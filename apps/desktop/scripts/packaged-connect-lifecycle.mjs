import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

export const CONNECT_READY_EVENT = 'desktop.renderer.connect_discovery.ready';
export const CHILD_CAPTURE_MAX_BYTES = 64 * 1024;
export const CHILD_DIAGNOSTIC_MAX_RECORDS = 20;

const RECORD_MAX_BYTES = 8 * 1024;
const RECORD_MAX_COUNT = 128;
const WINDOWS_PID_MAX = 0xffff_ffff;
const FIXTURE_LEAF_PATTERN = /^propr-desktop-connect-smoke-[A-Za-z0-9]{6}$/u;

const diagnosticEvents = new Set([
  'desktop.app.ready',
  'desktop.app.start_failed',
  'desktop.log.write_failed',
  'desktop.main_process.uncaught_exception',
  CONNECT_READY_EVENT,
  'desktop.renderer.connect_discovery.phase',
  'desktop.renderer.connect_discovery.status',
  'desktop.renderer.gone',
  'desktop.renderer.ready',
]);
const diagnosticCodes = new Set([
  'CONNECT_STATUS_INCOMPATIBLE',
  'CONNECT_STATUS_INTERNAL_FAILURE',
  'CONNECT_STATUS_INVALID_CONFIG',
  'CONNECT_STATUS_NOT_READY',
  'CONNECT_STATUS_READY',
  'CONNECT_STATUS_TIMEOUT',
  'DETAIL_REDACTED',
  'LOG_WRITE_FAILED',
  'OPERATION_FAILED',
  'UNCAUGHT_EXCEPTION',
]);
const diagnosticPhases = new Set([
  'config-read',
  'addon-integrity-type',
  'addon-load',
  'descriptor-operation',
  'authority-inspection',
  'status-resolution',
]);
const diagnosticPhaseCodes = new Set(['STARTED', 'PASSED', 'FAILED']);
const diagnosticSubsteps = new Set(['directory-open', 'addon-open', 'fstat-type']);
const diagnosticCategories = new Set([
  'access-denied',
  'invalid-argument',
  'io-failure',
  'missing-entry',
  'not-directory',
  'symlink-refused',
  'type-mismatch',
  'unexpected',
]);

export const boundedChildDiagnostics = records => records.flatMap(record => {
  if (!record || typeof record !== 'object' || !diagnosticEvents.has(record.event)) return [];
  const nestedCode = record.error && typeof record.error === 'object' ? record.error.code : undefined;
  const candidateCode = typeof record.code === 'string' ? record.code : nestedCode;
  const phase = typeof record.phase === 'string' ? record.phase : undefined;
  const substep = typeof record.substep === 'string' ? record.substep : undefined;
  const category = typeof record.category === 'string' ? record.category : undefined;
  return [{
    event: record.event,
    ...(diagnosticPhases.has(phase) && diagnosticPhaseCodes.has(candidateCode)
      ? {
          phase,
          code: candidateCode,
          ...(candidateCode === 'FAILED' && diagnosticSubsteps.has(substep) ? { substep } : {}),
          ...(candidateCode === 'FAILED' && diagnosticCategories.has(category) ? { category } : {}),
        }
      : diagnosticCodes.has(candidateCode) ? { code: candidateCode } : {}),
  }];
}).slice(0, CHILD_DIAGNOSTIC_MAX_RECORDS);

const exactKeys = (record, expected) => {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isExactReadyRecord = (record, { platform, arch, authorityMechanism }) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (!exactKeys(record, [
    'authorityMechanism', 'event', 'level', 'rendererSchemaValid',
    'selectedArch', 'selectedPlatform', 'timestamp',
  ])) return false;
  return record.event === CONNECT_READY_EVENT
    && record.level === 'info'
    && typeof record.timestamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.timestamp)
    && record.selectedPlatform === platform
    && record.selectedArch === arch
    && record.authorityMechanism === authorityMechanism
    && record.rendererSchemaValid === true;
};

const createRecordCapture = ({ sensitiveNeedles, onRecord, onSensitiveOutput }) => {
  let capturedBytes = 0;
  let captureTruncated = false;
  let recordCount = 0;
  let sensitiveOutput = false;
  const streams = new Map();
  const endedStreams = new Set();
  const normalizedNeedles = sensitiveNeedles.filter(value => typeof value === 'string' && value.length > 0);
  const maximumNeedleLength = Math.max(1, ...normalizedNeedles.map(value => value.length));

  const streamState = name => {
    if (!streams.has(name)) streams.set(name, {
      decoder: new TextDecoder('utf-8', { fatal: false }),
      line: '',
      lineBytes: 0,
      discardingLine: false,
      scanTail: '',
    });
    return streams.get(name);
  };

  const inspectLine = line => {
    const framed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!framed || recordCount >= RECORD_MAX_COUNT) {
      if (recordCount >= RECORD_MAX_COUNT) captureTruncated = true;
      return;
    }
    let record;
    try { record = JSON.parse(framed); } catch { return; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    recordCount += 1;
    onRecord(record);
  };

  const scan = (state, text) => {
    const candidate = `${state.scanTail}${text}`;
    if (!sensitiveOutput && normalizedNeedles.some(needle => candidate.includes(needle))) {
      sensitiveOutput = true;
      onSensitiveOutput();
    }
    state.scanTail = maximumNeedleLength > 1 ? candidate.slice(-(maximumNeedleLength - 1)) : '';
  };

  const write = (name, chunk) => {
    const state = streamState(name);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, CHILD_CAPTURE_MAX_BYTES - capturedBytes);
    const accepted = bytes.subarray(0, remaining);
    capturedBytes += accepted.byteLength;
    if (accepted.byteLength < bytes.byteLength) captureTruncated = true;

    // Secret detection continues with a constant-size tail even after structured capture is full.
    scan(state, state.decoder.decode(bytes, { stream: true }));
    if (accepted.byteLength === 0) return;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(accepted);
    for (const character of text) {
      if (character === '\n') {
        if (!state.discardingLine) inspectLine(state.line);
        state.line = '';
        state.lineBytes = 0;
        state.discardingLine = false;
        continue;
      }
      state.lineBytes += Buffer.byteLength(character, 'utf8');
      if (state.lineBytes > RECORD_MAX_BYTES) {
        state.line = '';
        state.discardingLine = true;
        captureTruncated = true;
      } else if (!state.discardingLine) {
        state.line += character;
      }
    }
  };

  const end = name => {
    if (endedStreams.has(name)) return;
    endedStreams.add(name);
    const state = streamState(name);
    scan(state, state.decoder.decode());
    if (state.line || state.discardingLine) captureTruncated = true;
    state.line = '';
    state.discardingLine = false;
  };

  return {
    write,
    end,
    finish: () => {
      end('stdout');
      end('stderr');
    },
    result: () => ({
      capture: captureTruncated ? 'truncated' : 'complete',
      sensitiveOutput,
    }),
  };
};

const deferred = () => {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

const boundedDelay = milliseconds => new Promise(resolveDelay => {
  setTimeout(resolveDelay, milliseconds);
});

const withTimeout = (promise, milliseconds) => new Promise(resolveBounded => {
  let settled = false;
  const finish = result => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveBounded(result);
  };
  const timer = setTimeout(() => finish({ timedOut: true }), milliseconds);
  promise.then(value => finish({ timedOut: false, value }), () => finish({ timedOut: false }));
});

const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= WINDOWS_PID_MAX;

const waitForClose = (child, milliseconds) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ closed: true, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolveWait => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolveWait(result);
    };
    const onClose = (code, signal) => finish({ closed: true, code, signal });
    const timer = setTimeout(() => finish({ closed: false }), milliseconds);
    child.once('close', onClose);
  });
};

const drainStream = (stream, milliseconds) => {
  if (!stream || stream.destroyed || stream.readableEnded) return Promise.resolve(true);
  return new Promise(resolveDrain => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream.removeListener('end', onDrain);
      stream.removeListener('close', onDrain);
      resolveDrain(value);
    };
    const onDrain = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    stream.once('end', onDrain);
    stream.once('close', onDrain);
  });
};

const drainChildStreams = async (child, milliseconds) => {
  const drained = await Promise.all([
    drainStream(child.stdout, milliseconds),
    drainStream(child.stderr, milliseconds),
  ]);
  return drained.every(Boolean);
};

const runWindowsTreeKiller = async ({ spawn, treeKillerPath, pid, timeoutMs }) => {
  if (typeof treeKillerPath !== 'string' || !isAbsolute(treeKillerPath) || !validPid(pid)) return false;
  let killer;
  try {
    killer = spawn(treeKillerPath, ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { return false; }
  let captured = 0;
  const discard = chunk => { captured = Math.min(CHILD_CAPTURE_MAX_BYTES, captured + chunk.length); };
  killer.stdout?.on('data', discard);
  killer.stderr?.on('data', discard);
  const closePromise = new Promise(resolveKiller => {
    killer.once('error', () => resolveKiller({ ok: false }));
    killer.once('close', (code, signal) => resolveKiller({ ok: code === 0 && signal === null }));
  });
  const boundedClose = await withTimeout(closePromise, timeoutMs);
  if (boundedClose.timedOut) {
    try { killer.kill('SIGKILL'); } catch { /* The bounded helper has already failed. */ }
    const finalDrainBound = Math.min(1_000, timeoutMs);
    await Promise.all([
      withTimeout(closePromise, finalDrainBound),
      drainStream(killer.stdout, finalDrainBound),
      drainStream(killer.stderr, finalDrainBound),
    ]);
    killer.stdout?.destroy();
    killer.stderr?.destroy();
    killer.unref?.();
    return false;
  }
  const streamsDrained = await Promise.all([
    drainStream(killer.stdout, timeoutMs),
    drainStream(killer.stderr, timeoutMs),
  ]);
  return boundedClose.value?.ok === true && streamsDrained.every(Boolean);
};

const terminateOwnedProcess = async ({ child, platform, spawn, treeKillerPath, timeoutMs }) => {
  if (!validPid(child.pid)) return false;
  if (platform === 'win32') {
    const treeKilled = await runWindowsTreeKiller({ spawn, treeKillerPath, pid: child.pid, timeoutMs });
    if (!treeKilled) {
      // This cannot prove descendant termination, but it prevents a failed helper from
      // leaving the directly owned Electron process alive while the fixed failure is reported.
      try { child.kill('SIGKILL'); } catch { /* Preserve the tree-termination result. */ }
    }
    return treeKilled;
  }
  try { return child.kill('SIGKILL'); } catch { return false; }
};

const closeIsClean = close => close?.closed && close.code === 0 && close.signal === null;

/**
 * Own one packaged app from spawn through proof, shutdown, tree termination, and stream drain.
 * The returned object contains only fixed categories and allowlisted child diagnostics.
 */
export const runPackagedConnectLifecycle = async ({
  binaryPath,
  args,
  env,
  cwd,
  platform,
  arch,
  authorityMechanism,
  sensitiveNeedles = [],
  treeKillerPath,
  spawn = nodeSpawn,
  readyTimeoutMs = 240_000,
  shutdownGraceMs = 5_000,
  terminationTimeoutMs = 10_000,
  streamDrainTimeoutMs = 5_000,
  requestShutdown = () => undefined,
}) => {
  const records = [];
  const first = deferred();
  let firstSettled = false;
  let invalidReadyObserved = false;
  let child;
  const settleFirst = value => {
    if (firstSettled) return;
    firstSettled = true;
    first.resolve(value);
  };
  const capture = createRecordCapture({
    sensitiveNeedles,
    onSensitiveOutput: () => settleFirst({ category: 'output-rejected' }),
    onRecord: record => {
      if (records.length < RECORD_MAX_COUNT) records.push(record);
      if (record.event !== CONNECT_READY_EVENT) return;
      const valid = isExactReadyRecord(record, { platform, arch, authorityMechanism });
      if (!valid) invalidReadyObserved = true;
      settleFirst(valid ? { category: 'ready' } : { category: 'ready-validation' });
    },
  });

  try {
    child = spawn(binaryPath, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { ok: false, category: 'spawn-error', capture: 'complete', records: [] };
  }

  child.stdout?.on('data', chunk => capture.write('stdout', chunk));
  child.stderr?.on('data', chunk => capture.write('stderr', chunk));
  child.stdout?.once('end', () => capture.end('stdout'));
  child.stderr?.once('end', () => capture.end('stderr'));
  child.once('error', () => settleFirst({ category: 'spawn-error' }));
  child.once('close', (code, signal) => settleFirst({ category: 'child-exit', close: { closed: true, code, signal } }));

  const readyTimer = setTimeout(() => settleFirst({ category: 'timeout-before-ready' }), readyTimeoutMs);
  const trigger = await first.promise;
  clearTimeout(readyTimer);

  let primary = trigger.category;
  let close = trigger.close;
  let terminationAttempted = false;
  let terminationSucceeded = false;
  let streamsDrained = false;

  if (primary === 'ready') {
    try { requestShutdown(child); } catch { /* The app also self-requests quit after logging proof. */ }
    close = await waitForClose(child, shutdownGraceMs);
    if (closeIsClean(close)) {
      primary = 'ready-clean-exit';
    } else if (close.closed) {
      primary = 'child-exit-after-ready';
    } else {
      terminationAttempted = true;
      terminationSucceeded = await terminateOwnedProcess({
        child, platform, spawn, treeKillerPath, timeoutMs: terminationTimeoutMs,
      });
      close = await waitForClose(child, streamDrainTimeoutMs);
      streamsDrained = await drainChildStreams(child, streamDrainTimeoutMs);
      primary = closeIsClean(close) && streamsDrained
        ? 'ready-clean-exit'
        : terminationSucceeded && close.closed && streamsDrained
          ? 'ready-forced-exit'
          : 'tree-termination';
    }
  } else if (primary === 'child-exit') {
    primary = 'child-exit-before-ready';
  } else {
    const alreadyClosed = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyClosed && validPid(child.pid)) {
      terminationAttempted = true;
      terminationSucceeded = await terminateOwnedProcess({
        child, platform, spawn, treeKillerPath, timeoutMs: terminationTimeoutMs,
      });
    }
    close = await waitForClose(child, streamDrainTimeoutMs);
  }

  if (!streamsDrained) streamsDrained = await drainChildStreams(child, streamDrainTimeoutMs);
  capture.finish();
  const captureResult = capture.result();
  if (primary === 'ready-clean-exit' || primary === 'ready-forced-exit') {
    if (captureResult.sensitiveOutput) primary = 'output-rejected';
    else if (invalidReadyObserved) primary = 'ready-validation';
  }
  const secondary = [];
  if (terminationAttempted && !terminationSucceeded && primary !== 'ready-clean-exit') {
    secondary.push('tree-termination-failed');
  }
  if (!close?.closed) secondary.push('child-close-unconfirmed');
  if (!streamsDrained) secondary.push('stream-drain-failed');
  if (!close?.closed || !streamsDrained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref?.();
  }
  return {
    ok: primary === 'ready-clean-exit' || primary === 'ready-forced-exit',
    category: primary,
    capture: captureResult.capture,
    records: boundedChildDiagnostics(records),
    ...(secondary.length ? { secondary } : {}),
  };
};

const fixtureIdentityIsAuthorized = async ({
  fixture,
  canonicalTemporaryParent,
  generatedLeaf,
  lstatImpl,
  realpathImpl,
}) => {
  if (typeof fixture !== 'string' || typeof canonicalTemporaryParent !== 'string'
    || typeof generatedLeaf !== 'string' || !FIXTURE_LEAF_PATTERN.test(generatedLeaf)
    || basename(fixture) !== generatedLeaf || dirname(fixture) !== canonicalTemporaryParent
    || relative(canonicalTemporaryParent, fixture) !== generatedLeaf) return false;
  let stats;
  try { stats = await lstatImpl(fixture); } catch (error) {
    return error?.code === 'ENOENT';
  }
  try {
    const [parentPath, fixturePath, parentStats] = await Promise.all([
      realpathImpl(canonicalTemporaryParent), realpathImpl(fixture), lstatImpl(canonicalTemporaryParent),
    ]);
    return parentPath === canonicalTemporaryParent
      && fixturePath === fixture
      && parentStats.isDirectory()
      && !parentStats.isSymbolicLink()
      && stats.isDirectory()
      && !stats.isSymbolicLink();
  } catch { return false; }
};

export const removeAuthorizedConnectFixture = async ({
  fixture,
  canonicalTemporaryParent,
  generatedLeaf = basename(fixture),
  platform = process.platform,
  retryBoundMs = 10_000,
  retryDelayMs = 100,
  lstatImpl = lstat,
  realpathImpl = realpath,
  rmImpl = rm,
}) => {
  if (!await fixtureIdentityIsAuthorized({
    fixture, canonicalTemporaryParent, generatedLeaf, lstatImpl, realpathImpl,
  })) return { ok: false, category: 'fixture-cleanup-authorization-failed' };
  const deadline = performance.now() + Math.max(0, retryBoundMs);
  while (true) {
    try {
      await rmImpl(fixture, { recursive: true, force: true, maxRetries: 0 });
      return { ok: true };
    } catch (error) {
      const retryable = platform === 'win32' && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
      if (!retryable || performance.now() + retryDelayMs > deadline) {
        return { ok: false, category: 'fixture-cleanup-failed' };
      }
      await boundedDelay(retryDelayMs);
      if (!await fixtureIdentityIsAuthorized({
        fixture, canonicalTemporaryParent, generatedLeaf, lstatImpl, realpathImpl,
      })) return { ok: false, category: 'fixture-cleanup-authorization-failed' };
    }
  }
};

export const preservePrimaryWithCleanup = (outcome, cleanup) => cleanup.ok ? outcome : ({
  ...outcome,
  secondary: [...new Set([...(outcome.secondary ?? []), cleanup.category])],
});
