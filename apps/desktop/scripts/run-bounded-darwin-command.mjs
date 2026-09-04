#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const EXIT_FOR_SIGNAL = new Map([['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]);

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
  if (!child.pid) return;
  try {
    if (platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
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
  let child;
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
    child = spawn(executable, arguments_, {
      detached: platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    if (primaryReason) signalProcessGroup(child, 'SIGTERM', platform);
    child.stdout?.on('data', chunk => appendBounded(
      stdoutChunks, chunk, stdoutState, maxOutputBytes,
      forwardOutput ? process.stdout : undefined,
    ));
    child.stderr?.on('data', chunk => appendBounded(
      stderrChunks, chunk, stderrState, maxOutputBytes,
      forwardOutput ? process.stderr : undefined,
    ));

    const timeout = setTimeout(() => requestTermination('timeout'), timeoutMs);
    const closeResult = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const result = await Promise.race([closeResult, forcedSettlement])
      .finally(() => clearTimeout(timeout));
    if (forceTimer) clearTimeout(forceTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (result.drainTimedOut) {
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
    if (error instanceof BoundedProcessError) throw error;
    throw new BoundedProcessError('spawn-or-io', { cause: error });
  } finally {
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
  try {
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
