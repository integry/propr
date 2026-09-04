#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const EXIT_FOR_SIGNAL = new Map([['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]);
const GROUP_GUARD_ARGUMENT = '--internal-process-group-guard';
const GROUP_GUARD_RELEASE = 'release-process-group-guard';
const GROUP_GUARD_RESULT = 'process-group-command-result';

export class BoundedProcessError extends Error {
  constructor(reason, result) {
    super(`bounded-process-${reason}`);
    this.name = 'BoundedProcessError';
    this.reason = reason;
    this.result = result;
  }
}

const appendBounded = (chunks, chunk, state, maximumBytes, forward) => {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const available = Math.max(0, maximumBytes - state.bytes);
  const accepted = value.subarray(0, available);
  if (accepted.length > 0) {
    chunks.push(accepted);
    state.bytes += accepted.length;
    forward?.write(accepted);
  }
  if (accepted.length !== value.length) state.truncated = true;
};

const signalProcessGroup = (child, signal, platform) => {
  if (!child?.pid) return;
  try {
    if (platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};

const runProcessGroupGuard = async argv => {
  if (argv[0] !== '--' || typeof argv[1] !== 'string' || argv[1].length === 0) {
    process.exitCode = 1;
    return;
  }

  // The guard is the process-group leader and deliberately survives TERM. Keeping its PID
  // occupied until its supervisor releases or kills it prevents the PGID from being reused
  // while a TERM-ignoring descendant may still belong to the group.
  const ignoredSignals = [...EXIT_FOR_SIGNAL.keys()];
  const ignoreSignal = () => {};
  for (const signal of ignoredSignals) process.on(signal, ignoreSignal);

  let commandResult;
  let resultPublished = false;
  const publishResult = result => {
    if (resultPublished) return;
    resultPublished = true;
    commandResult = result;
    if (process.send) {
      process.send({ type: GROUP_GUARD_RESULT, ...result }, () => {});
    }
  };

  const command = nodeSpawn(argv[1], argv.slice(2), {
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  command.once('error', () => publishResult({
    exitCode: 1, signal: null, spawnError: true,
  }));
  command.once('close', (exitCode, signal) => publishResult({ exitCode, signal }));

  process.on('message', message => {
    if (message?.type !== GROUP_GUARD_RELEASE || !commandResult) return;
    process.exitCode = commandResult.exitCode ?? 1;
    process.disconnect?.();
  });
};

export const runBoundedProcess = async ({
  executable,
  arguments: arguments_ = [],
  timeoutMs,
  terminationGraceMs = 5_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  forwardOutput = false,
  spawn = nodeSpawn,
  platform = process.platform,
  onSpawn,
  signalSource = process,
}) => {
  if (typeof executable !== 'string' || executable.length === 0
    || !Array.isArray(arguments_)
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(terminationGraceMs) || terminationGraceMs <= 0
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new BoundedProcessError('invalid-input');
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  let primaryReason;
  let requestedSignal;
  let forceTimer;
  let drainTimer;
  let timeout;
  let child;
  let childClosed;
  let commandResult;
  let commandSpawnFailed = false;
  let resolveForcedSettlement;
  const forcedSettlement = new Promise(resolve => { resolveForcedSettlement = resolve; });

  const requestTermination = reason => {
    if (!primaryReason) primaryReason = reason;
    try {
      signalProcessGroup(child, 'SIGTERM', platform);
    } catch {
      // The primary failure remains the timeout/signal even if termination reports a race.
    }
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, 'SIGKILL', platform);
        } catch {
          // A failed final kill is reflected by the bounded supervisor exit, without arguments.
        }
        drainTimer = setTimeout(() => resolveForcedSettlement({
          exitCode: null, signal: 'SIGKILL', drainTimedOut: true,
        }), 1_000);
      }, terminationGraceMs);
    }
  };

  const signalHandlers = new Map();
  for (const signal of EXIT_FOR_SIGNAL.keys()) {
    const handler = () => {
      requestedSignal ??= signal;
      requestTermination('signal');
    };
    signalHandlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  try {
    const guardProcessGroup = platform !== 'win32';
    child = spawn(
      guardProcessGroup ? process.execPath : executable,
      guardProcessGroup
        ? [fileURLToPath(import.meta.url), GROUP_GUARD_ARGUMENT, '--', executable, ...arguments_]
        : arguments_, {
      detached: platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: guardProcessGroup
        ? ['ignore', 'pipe', 'pipe', 'ipc']
        : ['ignore', 'pipe', 'pipe'],
    });
    const processError = new Promise(resolve => {
      child.once('error', error => resolve({ operationError: error }));
    });
    childClosed = new Promise(resolve => {
      child.once('close', (exitCode, signal) => resolve(commandResult ?? { exitCode, signal }));
    });
    if (guardProcessGroup) {
      child.on('message', message => {
        if (message?.type !== GROUP_GUARD_RESULT || commandResult) return;
        commandResult = { exitCode: message.exitCode, signal: message.signal };
        commandSpawnFailed = message.spawnError === true;
        if (primaryReason) return;
        if (commandSpawnFailed) requestTermination('spawn-or-io');
        else if (commandResult.exitCode !== 0 || commandResult.signal) requestTermination('exit');
        else {
          // Only success releases the guard. Every failure retains the PGID through SIGKILL.
          child.send({ type: GROUP_GUARD_RELEASE }, () => {});
        }
      });
    }
    child.stdout?.on('data', chunk => appendBounded(
      stdoutChunks, chunk, stdoutState, maxOutputBytes,
      forwardOutput ? process.stdout : undefined,
    ));
    child.stderr?.on('data', chunk => appendBounded(
      stderrChunks, chunk, stderrState, maxOutputBytes,
      forwardOutput ? process.stderr : undefined,
    ));

    onSpawn?.(child);
    if (primaryReason) signalProcessGroup(child, 'SIGTERM', platform);
    timeout = setTimeout(() => requestTermination('timeout'), timeoutMs);
    const settlement = await Promise.race([
      childClosed, processError, forcedSettlement,
    ])
      .finally(() => clearTimeout(timeout));
    if ('operationError' in settlement) throw settlement.operationError;
    const result = settlement;
    if (forceTimer) clearTimeout(forceTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (result.drainTimedOut) {
      try { child.disconnect?.(); } catch { /* The IPC channel may already be closed. */ }
      child.channel?.unref?.();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }

    const completed = {
      ...result,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutTruncated: stdoutState.truncated,
      stderrTruncated: stderrState.truncated,
      requestedSignal,
    };
    if (primaryReason) throw new BoundedProcessError(primaryReason, completed);
    if (result.exitCode !== 0) throw new BoundedProcessError('exit', completed);
    return completed;
  } catch (error) {
    if (child?.pid && !primaryReason) requestTermination('spawn-or-io');
    if (child?.pid && childClosed && forceTimer) {
      // The guard ignores TERM, so this settles only after SIGKILL or the final drain bound.
      await Promise.race([childClosed, forcedSettlement]);
    }
    if (error instanceof BoundedProcessError) throw error;
    throw new BoundedProcessError('spawn-or-io', { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    if (drainTimer) clearTimeout(drainTimer);
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler);
  }
};

const parseCli = argv => {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) throw new Error('invalid-cli');
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const parsed = {
    timeoutMs: undefined,
    terminationGraceMs: 5_000,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    forwardOutput: false,
    stdoutFile: undefined,
  };
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) throw new Error('invalid-cli');
    if (option === '--timeout-ms') parsed.timeoutMs = Number(value);
    else if (option === '--termination-grace-ms') parsed.terminationGraceMs = Number(value);
    else if (option === '--max-output-bytes') parsed.maxOutputBytes = Number(value);
    else if (option === '--forward-output') parsed.forwardOutput = value === 'true';
    else if (option === '--stdout-file') parsed.stdoutFile = value;
    else throw new Error('invalid-cli');
  }
  return { ...parsed, executable: command[0], arguments: command.slice(1) };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv[2] === GROUP_GUARD_ARGUMENT) {
    await runProcessGroupGuard(process.argv.slice(3));
  } else try {
    const options = parseCli(process.argv.slice(2));
    const result = await runBoundedProcess(options);
    if (options.stdoutFile) {
      await writeFile(options.stdoutFile, result.stdout, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (error) {
    if (error instanceof BoundedProcessError && error.reason === 'timeout') {
      process.stderr.write('Bounded Darwin operation timed out.\n');
      process.exitCode = 124;
    } else if (error instanceof BoundedProcessError && error.reason === 'signal') {
      process.exitCode = EXIT_FOR_SIGNAL.get(error.result?.requestedSignal) ?? 1;
    } else {
      process.stderr.write('Bounded Darwin operation failed.\n');
      process.exitCode = error instanceof BoundedProcessError && error.reason === 'exit'
        ? (error.result.exitCode ?? 1) : 1;
    }
  }
}
