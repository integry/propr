import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CONNECT_READY_EVENT = 'desktop.renderer.connect_discovery.ready';
export const CONNECT_DISCOVERY_MILESTONE_EVENT = 'desktop.renderer.connect_discovery.milestone';
export const CONNECT_JOURNEY_STAGE_EVENT = 'desktop.renderer.connect_journey.stage';
export const CONNECT_NETWORK_PERMISSION_EVENT = 'desktop.renderer.connect_network_permission';
export const CHILD_CAPTURE_MAX_BYTES = 64 * 1024;
export const CHILD_DIAGNOSTIC_MAX_RECORDS = 20;

const RECORD_MAX_BYTES = 8 * 1024;
const RECORD_MAX_COUNT = 128;
const WINDOWS_PID_MAX = 0xffff_ffff;
const FIXTURE_LEAF_PATTERN = /^propr-desktop-connect-smoke-[A-Za-z0-9]{6}$/u;
const ISOLATED_CLEANUP_ARGUMENT = '--internal-isolated-connect-fixture-cleanup';
const MODULE_PATH = fileURLToPath(import.meta.url);
const isIsolatedCleanupProcess = process.argv[1] === MODULE_PATH
  && process.argv[2] === ISOLATED_CLEANUP_ARGUMENT;

const diagnosticEvents = new Set([
  'desktop.app.ready',
  'desktop.app.start_failed',
  'desktop.log.write_failed',
  'desktop.main_process.uncaught_exception',
  CONNECT_READY_EVENT,
  CONNECT_DISCOVERY_MILESTONE_EVENT,
  CONNECT_JOURNEY_STAGE_EVENT,
  CONNECT_NETWORK_PERMISSION_EVENT,
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
const journeyStageCodes = new Set([
  'JOURNEY_DISCOVERY_RENDERER',
  'JOURNEY_DISCOVERY_VALIDATED',
  'JOURNEY_STORAGE_BACKEND',
  'JOURNEY_NEGATIVE_MALFORMED',
  'JOURNEY_NEGATIVE_OVERSIZED',
  'JOURNEY_NEGATIVE_EXPIRY',
  'JOURNEY_NEGATIVE_CANCEL',
  'JOURNEY_NEGATIVE_STATE',
  'JOURNEY_PAIR_MANUAL_FORM',
  'JOURNEY_PAIR_BROWSER_APPROVAL',
  'JOURNEY_PAIR_ACTIVATION_DASHBOARD',
  'JOURNEY_PAIR_TRANSPORT',
  'JOURNEY_PAIR_COMPLETE',
  'JOURNEY_REPROBE_ACTIVATION_DASHBOARD',
  'JOURNEY_REPROBE_TRANSPORT',
  'JOURNEY_REPROBE_COMPLETE',
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
const networkPermissionCategories = new Set([
  'local-network-access',
  'local-network',
  'loopback-network',
]);
const networkPermissionDecisions = new Set(['check', 'request']);
const networkPermissionBooleanFields = [
  'activeBindingCurrent',
  'webContentsPresent',
  'webContentsEqualsMainWindow',
  'mainWindowPresent',
  'isMainFrame',
  'requestingUrlPresent',
  'requestingUrlTrusted',
  'rendererDocumentUrlTrusted',
  'requestingOriginAuthorityValid',
  'requestingOriginAuthorityEqual',
];

const boundedNetworkPermissionEvidence = record => {
  if (record.schemaVersion !== 1
    || !networkPermissionCategories.has(record.permissionCategory)
    || !networkPermissionDecisions.has(record.decision)
    || typeof record.allowed !== 'boolean'
    || networkPermissionBooleanFields.some(field => typeof record[field] !== 'boolean')) return {};
  return {
    schemaVersion: 1,
    permissionCategory: record.permissionCategory,
    decision: record.decision,
    allowed: record.allowed,
    ...Object.fromEntries(networkPermissionBooleanFields.map(field => [field, record[field]])),
  };
};

export const boundedChildDiagnostics = records => {
  const diagnostics = records.flatMap(record => {
    if (!record || typeof record !== 'object' || !diagnosticEvents.has(record.event)) return [];
    if (record.event === CONNECT_NETWORK_PERMISSION_EVENT) {
      return [{ event: record.event, ...boundedNetworkPermissionEvidence(record) }];
    }
    const nestedCode = record.error && typeof record.error === 'object' ? record.error.code : undefined;
    const candidateCode = typeof record.code === 'string' ? record.code : nestedCode;
    const phase = typeof record.phase === 'string' ? record.phase : undefined;
    const substep = typeof record.substep === 'string' ? record.substep : undefined;
    const category = typeof record.category === 'string' ? record.category : undefined;
    return [{
      event: record.event,
      ...(journeyStageCodes.has(candidateCode)
        && (record.event === CONNECT_DISCOVERY_MILESTONE_EVENT
          || record.event === CONNECT_JOURNEY_STAGE_EVENT)
        ? { code: candidateCode }
        : diagnosticPhases.has(phase) && diagnosticPhaseCodes.has(candidateCode)
        ? {
            phase,
            code: candidateCode,
            ...(candidateCode === 'FAILED' && diagnosticSubsteps.has(substep) ? { substep } : {}),
            ...(candidateCode === 'FAILED' && diagnosticCategories.has(category) ? { category } : {}),
          }
        : diagnosticCodes.has(candidateCode) ? { code: candidateCode } : {}),
    }];
  });
  const bounded = diagnostics.slice(0, CHILD_DIAGNOSTIC_MAX_RECORDS);
  const latestJourneyStage = diagnostics.findLast(record => typeof record.code === 'string'
    && (record.event === CONNECT_DISCOVERY_MILESTONE_EVENT
      || record.event === CONNECT_JOURNEY_STAGE_EVENT));
  if (latestJourneyStage && !bounded.includes(latestJourneyStage)) {
    bounded[bounded.length - 1] = latestJourneyStage;
  }
  return bounded;
};

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
  const reportSensitiveOutput = () => {
    if (sensitiveOutput) return;
    sensitiveOutput = true;
    onSensitiveOutput();
  };

  const parsedContentIsSensitive = parsed => {
    const pending = [parsed];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        if (normalizedNeedles.some(needle => value.includes(needle))) return true;
      } else if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) pending.push(key, nested);
      }
    }
    return false;
  };

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
    // JSON escaping can hide a decoded path (notably Windows backslashes) from
    // the raw stream scan, so inspect every bounded parsed string before the
    // record can contribute either readiness or diagnostics.
    if (parsedContentIsSensitive(record)) reportSensitiveOutput();
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    recordCount += 1;
    onRecord(record);
  };

  const scan = (state, text) => {
    const candidate = `${state.scanTail}${text}`;
    if (normalizedNeedles.some(needle => candidate.includes(needle))) reportSensitiveOutput();
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
    if (captureResult.sensitiveOutput || captureResult.capture === 'truncated') {
      primary = 'output-rejected';
    } else if (invalidReadyObserved) primary = 'ready-validation';
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

const createCleanupPhaseDeadline = milliseconds => {
  let timedOut = false;
  let timer;
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => {
      timedOut = true;
      resolveTimeout({ status: 'timed-out' });
    }, Math.max(0, milliseconds));
  });
  return {
    run: operation => {
      if (timedOut) return Promise.resolve({ status: 'timed-out' });
      let pending;
      try { pending = operation(); } catch (error) {
        return Promise.resolve({ status: 'rejected', error });
      }
      return Promise.race([
        Promise.resolve(pending).then(
          value => ({ status: 'fulfilled', value }),
          error => ({ status: 'rejected', error }),
        ),
        timeout,
      ]);
    },
    dispose: () => clearTimeout(timer),
  };
};

const fixtureIdentityIsAuthorized = async ({
  fixture,
  canonicalTemporaryParent,
  generatedLeaf,
  lstatImpl,
  realpathImpl,
  runBeforeDeadline,
}) => {
  if (typeof fixture !== 'string' || typeof canonicalTemporaryParent !== 'string'
    || typeof generatedLeaf !== 'string' || !FIXTURE_LEAF_PATTERN.test(generatedLeaf)
    || basename(fixture) !== generatedLeaf || dirname(fixture) !== canonicalTemporaryParent
    || relative(canonicalTemporaryParent, fixture) !== generatedLeaf) return { authorized: false };
  const fixtureStats = await runBeforeDeadline(() => lstatImpl(fixture));
  if (fixtureStats.status === 'timed-out') return { timedOut: true };
  if (fixtureStats.status === 'rejected') {
    return { authorized: fixtureStats.error?.code === 'ENOENT' };
  }
  const identity = await Promise.all([
    runBeforeDeadline(() => realpathImpl(canonicalTemporaryParent)),
    runBeforeDeadline(() => realpathImpl(fixture)),
    runBeforeDeadline(() => lstatImpl(canonicalTemporaryParent)),
  ]);
  if (identity.some(result => result.status === 'timed-out')) return { timedOut: true };
  if (identity.some(result => result.status === 'rejected')) return { authorized: false };
  const [parentPath, fixturePath, parentStats] = identity.map(result => result.value);
  const stats = fixtureStats.value;
  try {
    return {
      authorized: parentPath === canonicalTemporaryParent
        && fixturePath === fixture
        && parentStats.isDirectory()
        && !parentStats.isSymbolicLink()
        && stats.isDirectory()
        && !stats.isSymbolicLink(),
    };
  } catch { return { authorized: false }; }
};

const isolatedCleanupResult = async ({
  fixture,
  canonicalTemporaryParent,
  generatedLeaf,
  retryBoundMs,
  retryDelayMs,
  phase,
}) => {
  if (!isAbsolute(process.execPath)) return { ok: false, category: 'fixture-cleanup-failed' };
  let child;
  try {
    child = nodeSpawn(process.execPath, [MODULE_PATH, ISOLATED_CLEANUP_ARGUMENT], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { return { ok: false, category: 'fixture-cleanup-failed' }; }
  let stdout = '';
  let stdoutOverflow = false;
  child.stdout.on('data', chunk => {
    if (stdoutOverflow) return;
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout, 'utf8') > RECORD_MAX_BYTES) {
      stdout = '';
      stdoutOverflow = true;
    }
  });
  child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined);
  const close = new Promise(resolveClose => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolveClose(result);
    };
    child.once('error', () => finish({ closed: false }));
    child.once('close', (code, signal) => finish({ closed: true, code, signal }));
  });
  child.stdin.end(JSON.stringify({
    fixture, canonicalTemporaryParent, generatedLeaf, retryBoundMs, retryDelayMs,
  }));
  const boundedClose = await phase.run(() => close);
  if (boundedClose.status !== 'fulfilled' || !boundedClose.value.closed
    || boundedClose.value.code !== 0 || boundedClose.value.signal !== null || stdoutOverflow) {
    try { child.kill('SIGKILL'); } catch { /* The fixed cleanup failure is already selected. */ }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return { ok: false, category: 'fixture-cleanup-failed' };
  }
  try {
    const result = JSON.parse(stdout);
    const keys = Object.keys(result).sort();
    if (result.ok === true && keys.length === 1 && keys[0] === 'ok') return result;
    if (result.ok === false && keys.length === 2 && keys[0] === 'category' && keys[1] === 'ok'
      && ['fixture-cleanup-authorization-failed', 'fixture-cleanup-failed'].includes(result.category)) {
      return result;
    }
  } catch { /* Return only the fixed failure below. */ }
  return { ok: false, category: 'fixture-cleanup-failed' };
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
  const phase = createCleanupPhaseDeadline(retryBoundMs);
  try {
    if (platform === 'win32' && !isIsolatedCleanupProcess
      && lstatImpl === lstat && realpathImpl === realpath && rmImpl === rm) {
      return await isolatedCleanupResult({
        fixture, canonicalTemporaryParent, generatedLeaf, retryBoundMs, retryDelayMs, phase,
      });
    }
    const authorize = () => fixtureIdentityIsAuthorized({
      fixture, canonicalTemporaryParent, generatedLeaf, lstatImpl, realpathImpl,
      runBeforeDeadline: phase.run,
    });
    const initialAuthorization = await authorize();
    if (initialAuthorization.timedOut) {
      return { ok: false, category: 'fixture-cleanup-failed' };
    }
    if (!initialAuthorization.authorized) {
      return { ok: false, category: 'fixture-cleanup-authorization-failed' };
    }
    while (true) {
      const removal = await phase.run(() => rmImpl(fixture, {
        recursive: true, force: true, maxRetries: 0,
      }));
      if (removal.status === 'fulfilled') return { ok: true };
      if (removal.status === 'timed-out') {
        return { ok: false, category: 'fixture-cleanup-failed' };
      }
      const retryable = platform === 'win32'
        && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(removal.error?.code);
      if (!retryable) return { ok: false, category: 'fixture-cleanup-failed' };
      const delay = await phase.run(() => boundedDelay(retryDelayMs));
      if (delay.status !== 'fulfilled') return { ok: false, category: 'fixture-cleanup-failed' };
      const retryAuthorization = await authorize();
      if (retryAuthorization.timedOut) {
        return { ok: false, category: 'fixture-cleanup-failed' };
      }
      if (!retryAuthorization.authorized) {
        return { ok: false, category: 'fixture-cleanup-authorization-failed' };
      }
    }
  } finally {
    phase.dispose();
  }
};

export const preservePrimaryWithCleanup = (outcome, cleanup) => cleanup.ok ? outcome : ({
  ...outcome,
  secondary: [...new Set([...(outcome.secondary ?? []), cleanup.category])],
});

export const createIdempotentJourneyFixtureClose = ({
  closeSocketServer,
  closeHttpServer,
}) => {
  let closePromise;
  return () => {
    closePromise ??= (async () => {
      await closeSocketServer();
      try {
        await closeHttpServer();
      } catch (error) {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      }
    })();
    return closePromise;
  };
};

if (isIsolatedCleanupProcess) {
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > RECORD_MAX_BYTES) throw new Error('invalid cleanup input');
    }
    const options = JSON.parse(input);
    const result = await removeAuthorizedConnectFixture({
      fixture: options.fixture,
      canonicalTemporaryParent: options.canonicalTemporaryParent,
      generatedLeaf: options.generatedLeaf,
      platform: 'win32',
      retryBoundMs: options.retryBoundMs,
      retryDelayMs: options.retryDelayMs,
    });
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, category: 'fixture-cleanup-failed' }));
  }
}
