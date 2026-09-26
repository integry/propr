import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { arch as hostArch, platform as hostPlatform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createHeldDmgArtifact,
  inspectArtifactArchitecture,
  inspectExecutableBytes,
} from './release-architecture.mjs';
import {
  createPrivateSmokeProfile,
  createSmokeChildEnvironment,
  removePrivateSmokeProfile,
} from './packaged-smoke-support.mjs';
import { signDarwinPackagedConnectApplication } from './sign-darwin-packaged-connect.mjs';
import { verifyDarwinLocalPackage } from './sign-darwin-local-package.mjs';
import { verifyDarwinPackagedConnectSignature } from './verify-darwin-packaged-connect-signature.mjs';
import {
  DESKTOP_ICON_FILE,
  verifyLinuxLauncherIcon,
  verifyMacApplicationIcon,
  verifyPackagedLinuxIcon,
  verifyPackagedTrayIcon,
} from './desktop-icon-assets.mjs';

const EXECUTABLE = 'propr-desktop';
const APP_ID = 'dev.propr.desktop';
const PROCESS_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 64 * 1024;
const CLEANUP_GRACE_MS = 2_000;
const DBUS_SESSION_ADDRESS = /^unix:path=\/[^\0\r\n,]+(?:,guid=[0-9a-f]{32})?$/;
const COLD_MANUAL = 'propr://connect?api=http%3A%2F%2Flocalhost%3A44111';
const COLD_TUNNEL = 'propr://connect?api=https%3A%2F%2Ft-native-relaunch.propr.dev';
const WARM_MANUAL = 'propr://connect?api=http%3A%2F%2F127.0.0.1%3A44112';
const WARM_TUNNEL = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
const WARM_OPEN = 'propr://open?path=%2Ftasks%3Fstatus%3Dopen';
const REQUIRED_FIRST_EVENTS = [
  'desktop.smoke.authorized',
  'desktop.native.identity_verified',
  'desktop.deeplink.consumer_ready',
  'desktop.deeplink.cold_manual_once',
  'desktop.native.secure_storage_probe.started',
  'desktop.native.secure_storage_probe.completed',
  'desktop.native.secure_storage_enforced',
  'desktop.native.profile_fresh',
  'desktop.renderer.ready',
  'desktop.deeplink.warm_manual_once',
  'desktop.deeplink.warm_tunnel_once',
  'desktop.deeplink.warm_open_once',
  'desktop.deeplink.rejected_malformed',
  'desktop.deeplink.rejected_oversized',
  'desktop.deeplink.rejected_unsafe_scheme',
  'desktop.deeplink.confirmation_required',
  'desktop.app.shutdown',
];
const REQUIRED_RELAUNCH_EVENTS = [
  'desktop.smoke.authorized',
  'desktop.native.identity_verified',
  'desktop.deeplink.consumer_ready',
  'desktop.deeplink.cold_tunnel_once',
  'desktop.native.profile_preserved',
  'desktop.deeplink.confirmation_required',
  'desktop.renderer.ready',
  'desktop.app.shutdown',
];

export const parseArguments = args => {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Native artifact lifecycle arguments are missing, duplicated, or malformed');
    }
    values.set(name, value);
  }
  const platform = values.get('--platform');
  const arch = values.get('--arch');
  const version = values.get('--version');
  const artifactDirectory = values.get('--artifact-directory');
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')
    || !artifactDirectory || values.size !== 4) {
    throw new Error('Native artifact lifecycle target is invalid');
  }
  return { platform, arch, version, artifactDirectory: resolve(artifactDirectory) };
};

export const createNativeLaunchContext = ({ platform, baseEnvironment, sessionAddress }) => {
  if (platform !== 'linux') {
    return Object.freeze({
      environment: Object.freeze({ ...baseEnvironment }),
      arguments: Object.freeze([]),
    });
  }
  if (typeof sessionAddress !== 'string' || sessionAddress.length > 4096 || /[\0\r\n]/.test(sessionAddress)
    || !DBUS_SESSION_ADDRESS.test(sessionAddress)) {
    throw new Error('Native Linux lifecycle requires one validated D-Bus session address');
  }
  return Object.freeze({
    environment: Object.freeze({ ...baseEnvironment, DBUS_SESSION_BUS_ADDRESS: sessionAddress }),
    arguments: Object.freeze(['--disable-gpu', '--password-store=gnome-libsecret']),
  });
};

const appendBounded = (current, chunk) => {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= OUTPUT_CAP ? next : next.subarray(next.length - OUTPUT_CAP);
};

const COMMAND_RESULT_CLASSES = Object.freeze([
  'COMMAND_FAILED', 'COMMAND_SIGNALLED', 'COMMAND_DEADLINE', 'COMMAND_SPAWN_FAILED', 'UNEXPECTED_OUTPUT',
]);

// Distinguishes a bundle that really is still registered from an absence proof
// that never got a readable answer out of `lsregister -dump`, or one whose
// re-issued `lsregister -u` kept failing while the bundle stayed listed.
export const LAUNCH_SERVICES_STALE_REGISTRATION = 'STALE_REGISTRATION';
export const LAUNCH_SERVICES_UNREGISTER_FAILED = 'UNREGISTER_FAILED';

export class NativeLifecycleCommandFailure extends Error {
  constructor(resultClass) {
    if (!COMMAND_RESULT_CLASSES.includes(resultClass)) {
      throw new Error('Native lifecycle command result class is invalid');
    }
    super(`Native lifecycle command failed [result:${resultClass}]`);
    this.name = 'NativeLifecycleCommandFailure';
    this.resultClass = resultClass;
  }
}

export const runNativeLifecycleCommand = (file, args, {
  cwd, env, timeout = COMMAND_TIMEOUT_MS, input,
} = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, {
    cwd,
    env,
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutOverflow = false;
  let stderrOverflow = false;
  child.stdout.on('data', chunk => {
    stdoutOverflow ||= stdout.length + chunk.length > OUTPUT_CAP;
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on('data', chunk => {
    stderrOverflow ||= stderr.length + chunk.length > OUTPUT_CAP;
    stderr = appendBounded(stderr, chunk);
  });
  if (input !== undefined) child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  child.once('error', () => {
    clearTimeout(timer);
    reject(new NativeLifecycleCommandFailure('COMMAND_SPAWN_FAILED'));
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new NativeLifecycleCommandFailure(timedOut ? 'COMMAND_DEADLINE'
        : signal ? 'COMMAND_SIGNALLED' : 'COMMAND_FAILED'));
      return;
    }
    resolveRun({ stderr, stderrOverflow, stdout, stdoutOverflow });
  });
});

const run = runNativeLifecycleCommand;

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

// Races an operation against a deadline and always clears the deadline timer.
// An uncleared deadline keeps Node alive after the lifecycle already
// succeeded, which previously held CI for the full ten-minute RPM deadline.
export const withDeadline = (operation, milliseconds, message) => {
  let timer;
  const deadline = new Promise((_resolveDeadline, rejectDeadline) => {
    timer = setTimeout(() => rejectDeadline(new Error(message)), milliseconds);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
};

const errorFrom = (error, fallback) => error instanceof Error ? error : new Error(fallback);

export const NATIVE_LIFECYCLE_OPERATION_STAGES = Object.freeze([
  'PREPARE_WORK_ROOT',
  'CREATE_PROFILE',
  'START_PROFILE_API',
  'BASELINE_BEFORE',
  'INSPECT_ARTIFACT',
  'EXTRACT_ARTIFACT',
  'VALIDATE_ARTIFACT',
  'PREPARE_DARWIN_ACCEPTANCE_SIGNATURE',
  'PREPARE_LINUX_SANDBOX',
  'CREATE_CHILD_ENVIRONMENT',
  'FIRST_LAUNCH',
  'FIRST_INITIAL_EVIDENCE',
  'FIRST_SECURE_STORAGE_PROBE',
  'FIRST_RENDERER_READY',
  'WARM_MANUAL_DISPATCH',
  'WARM_MANUAL_EVIDENCE',
  'PROTOCOL_DISPATCH',
  'PROTOCOL_DATABASE',
  'PROTOCOL_REGISTER',
  'PROTOCOL_QUERY',
  'PROTOCOL_LAUNCH',
  'LS_REGISTER',
  'OPEN_DISPATCH',
  'PROTOCOL_EVIDENCE',
  'WARM_OPEN_DISPATCH',
  'WARM_OPEN_EVIDENCE',
  'MALFORMED_DISPATCH',
  'MALFORMED_EVIDENCE',
  'OVERSIZED_DISPATCH',
  'OVERSIZED_EVIDENCE',
  'UNSAFE_SCHEME_DISPATCH',
  'UNSAFE_SCHEME_EVIDENCE',
  'FIRST_EXIT',
  'FIRST_EVIDENCE_VALIDATION',
  'RELAUNCH',
  'RELAUNCH_EXIT',
  'RELAUNCH_EVIDENCE',
  'FINAL_DARWIN_SIGNATURE_VALIDATION',
  'FINAL_VALIDATION',
]);

export const NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES = Object.freeze([
  'CLEAN_EXIT',
  'FAILED_EXIT',
  'SIGNALLED',
  'EVIDENCE_DEADLINE',
  'EVIDENCE_READ_FAILED',
]);

export const FIRST_EVIDENCE_MILESTONES = Object.freeze([
  'NO_EVIDENCE',
  'AUTHORIZED',
  'IDENTITY',
  'CONSUMER_READY',
  'SECURE_STORAGE_BACKEND',
  'DEEP_LINK_DELIVERY_FAILURE',
  'COLD_ACK',
  'SECURE_STORAGE_STARTED',
  'SECURE_STORAGE_COMPLETED',
  'RENDERER',
]);

export const FIRST_EVIDENCE_FAILURE_CATEGORIES = Object.freeze([
  'START_FAILED',
  'UNCAUGHT_EXCEPTION',
  'DEEP_LINK_DELIVERY_FAILED',
  'COLD_CONFIRMATION_INSPECTION_FAILED',
  'COLD_CONFIRMATION_NOT_VISIBLE',
  'RENDERER_GONE',
]);

export const WARM_OPEN_EVIDENCE_MILESTONES = Object.freeze([
  'NO_EVIDENCE',
  'RENDERER',
  'WARM_MANUAL_ACK',
  'WARM_TUNNEL_ACK',
  'WARM_OPEN_ACK',
  'SHUTDOWN',
]);

const WARM_OPEN_EVIDENCE_STATES = Object.freeze([
  'READABLE', 'MISSING', 'MALFORMED', 'UNREADABLE', 'OVERSIZED',
]);

export class NativeLifecycleEvidenceWaitFailure extends Error {
  constructor(resultClass) {
    if (!NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES.includes(resultClass)) {
      throw new Error('Native lifecycle evidence result class is invalid');
    }
    super(resultClass === 'EVIDENCE_DEADLINE'
      ? 'Native application evidence deadline expired'
      : resultClass === 'EVIDENCE_READ_FAILED'
        ? 'Native application evidence could not be read'
        : 'Native application exited before producing required evidence');
    this.name = 'NativeLifecycleEvidenceWaitFailure';
    this.resultClass = resultClass;
  }
}

export class NativeLifecycleOperationFailure extends Error {
  constructor(stage, operationError, evidenceClassification) {
    if (!NATIVE_LIFECYCLE_OPERATION_STAGES.includes(stage)) {
      throw new Error('Native lifecycle failure stage is invalid');
    }
    const milestones = stage === 'WARM_OPEN_EVIDENCE'
      ? WARM_OPEN_EVIDENCE_MILESTONES
      : FIRST_EVIDENCE_MILESTONES;
    if (evidenceClassification
      && (!milestones.includes(evidenceClassification.milestone)
        || !NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES.includes(evidenceClassification.resultClass)
        || (evidenceClassification.evidenceState !== undefined
          && (stage !== 'WARM_OPEN_EVIDENCE'
            || !WARM_OPEN_EVIDENCE_STATES.includes(evidenceClassification.evidenceState)))
        || (evidenceClassification.failureCategory !== undefined
          && !FIRST_EVIDENCE_FAILURE_CATEGORIES.includes(evidenceClassification.failureCategory)))) {
      throw new Error('Native lifecycle evidence failure classification is invalid');
    }
    // Preserve the wait outcome at later stages too, without exposing the
    // underlying error or any child output, arguments, URLs, or profile paths.
    const resultClass = evidenceClassification?.resultClass
      ?? (operationError instanceof NativeLifecycleEvidenceWaitFailure
        || operationError instanceof NativeLifecycleCommandFailure ? operationError.resultClass : undefined);
    if (resultClass !== undefined && !NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES.includes(resultClass)
      && !COMMAND_RESULT_CLASSES.includes(resultClass)) {
      throw new Error('Native lifecycle evidence result class is invalid');
    }
    const classification = [
      evidenceClassification ? ` [milestone:${evidenceClassification.milestone}]` : '',
      resultClass ? ` [result:${resultClass}]` : '',
      evidenceClassification?.evidenceState ? ` [evidence:${evidenceClassification.evidenceState}]` : '',
      evidenceClassification?.failureCategory ? ` [category:${evidenceClassification.failureCategory}]` : '',
    ].join('');
    super(`Native lifecycle operation failed [stage:${stage}]${classification}`);
    this.name = 'NativeLifecycleOperationFailure';
    this.stage = stage;
    if (resultClass) this.resultClass = resultClass;
    if (evidenceClassification) {
      this.milestone = evidenceClassification.milestone;
      if (evidenceClassification.evidenceState) this.evidenceState = evidenceClassification.evidenceState;
      if (evidenceClassification.failureCategory) {
        this.failureCategory = evidenceClassification.failureCategory;
      }
    }
    Object.defineProperty(this, 'operationError', { value: operationError, enumerable: false });
  }
}

// A cleanup label alone cannot say why the step failed, so a fixed reason code
// is carried alongside it when the failure classified itself: that is the one
// fact separating a flaky probe from a genuinely stale artifact. Only these
// fixed tokens are ever appended, so the safe errors still carry no child
// output, arguments, URLs, or profile paths.
const CLEANUP_RESULT_CLASSES = Object.freeze([
  ...COMMAND_RESULT_CLASSES,
  LAUNCH_SERVICES_STALE_REGISTRATION,
  LAUNCH_SERVICES_UNREGISTER_FAILED,
]);

export const describeCleanupFailure = ({ label, error }) => (
  CLEANUP_RESULT_CLASSES.includes(error?.resultClass)
    ? `${label} [result:${error.resultClass}]`
    : label
);

export class NativeLifecycleFailure extends AggregateError {
  constructor(primaryError, cleanupFailures) {
    const cleanupLabels = cleanupFailures.map(describeCleanupFailure).sort();
    const classification = primaryError instanceof NativeLifecycleOperationFailure
      ? [
          ` [stage:${primaryError.stage}]`,
          ...(primaryError.milestone ? [` [milestone:${primaryError.milestone}]`] : []),
          ...(primaryError.resultClass ? [` [result:${primaryError.resultClass}]`] : []),
          ...(primaryError.evidenceState ? [` [evidence:${primaryError.evidenceState}]`] : []),
          ...(primaryError.failureCategory ? [` [category:${primaryError.failureCategory}]`] : []),
        ].join('')
      : '';
    const message = primaryError
      ? `Native lifecycle failed${classification}; cleanup also failed: ${cleanupLabels.join(', ')}`
      : `Native lifecycle cleanup failed: ${cleanupLabels.join(', ')}`;
    const safeErrors = [
      ...(primaryError ? [new Error(
        primaryError instanceof NativeLifecycleOperationFailure
          ? primaryError.message
          : 'Native lifecycle primary operation failed',
      )] : []),
      ...cleanupLabels.map(label => new Error(`Native lifecycle cleanup failed: ${label}`)),
    ];
    super(safeErrors, message);
    this.name = 'NativeLifecycleFailure';
    Object.defineProperties(this, {
      primaryError: { value: primaryError, enumerable: false },
      cleanupFailures: { value: cleanupFailures, enumerable: false },
    });
  }
}

const throwCombined = (primaryError, cleanupFailures) => {
  if (cleanupFailures.length > 0) throw new NativeLifecycleFailure(primaryError, cleanupFailures);
  if (primaryError) throw primaryError;
};

export const runningProcessGroupMembersFromPs = (output, processGroupId) => {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('Native process-group identity is invalid');
  }
  const members = [];
  for (const line of output.toString('utf8').split(/\r?\n/).filter(candidate => candidate.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Native process-group inspection returned an invalid record');
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const state = match[3][0];
    if (pgid === processGroupId && state !== 'Z') members.push(pid);
  }
  return members;
};

export const inspectRunningProcessGroupMembers = async processGroupId => {
  if (!processGroupId) return [];
  const result = await run('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { timeout: CLEANUP_GRACE_MS });
  if (result.stdoutOverflow || result.stderrOverflow) {
    throw new Error('Native process-group inspection exceeded its fixed output bound');
  }
  return runningProcessGroupMembersFromPs(result.stdout, processGroupId);
};

const waitUntil = async (predicate, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await predicate()) return true;
    await delay(25);
  }
  return !await predicate();
};

class OwnedProcessGroup {
  constructor(child) {
    this.child = child;
    this.pid = child.pid;
    this.closed = false;
    this.released = false;
    this.result = null;
    this.closePromise = new Promise(resolveClose => {
      child.once('error', error => {
        if (!this.result) this.result = { code: null, error, signal: null };
      });
      child.once('close', (code, signal) => {
        this.closed = true;
        this.result = { code, error: this.result?.error, signal };
        resolveClose(this.result);
      });
    });
  }

  signal(signal) {
    if (!this.pid) return;
    try {
      process.kill(-this.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }

  async waitForClose(timeout) {
    if (this.closed) return this.result;
    return withDeadline(this.closePromise, timeout, 'Native application close deadline expired');
  }

  async terminate() {
    if (this.released) {
      await this.waitForClose(CLEANUP_GRACE_MS);
      return;
    }
    let initialMembers;
    try {
      initialMembers = await inspectRunningProcessGroupMembers(this.pid);
    } catch {
      // Inspection failure cannot relinquish authority: still bound TERM/KILL before reporting
      // that the running-member postcondition could not be proved.
      this.signal('SIGTERM');
      await delay(CLEANUP_GRACE_MS);
      this.signal('SIGKILL');
      try {
        await this.waitForClose(CLEANUP_GRACE_MS);
      } catch {
        throw new Error('Native application close and process-group inspection deadlines expired');
      }
      throw new Error('Native application process-group inspection failed after bounded cleanup');
    }
    if (initialMembers.length > 0) {
      this.signal('SIGTERM');
      if (!await waitUntil(
        async () => (await inspectRunningProcessGroupMembers(this.pid)).length > 0,
        CLEANUP_GRACE_MS,
      )) {
        this.signal('SIGKILL');
      }
    }
    const groupGone = await waitUntil(
      async () => (await inspectRunningProcessGroupMembers(this.pid)).length > 0,
      CLEANUP_GRACE_MS,
    );
    let closeError;
    try {
      await this.waitForClose(CLEANUP_GRACE_MS);
    } catch (error) {
      closeError = errorFrom(error, 'Native application close postcondition failed');
    }
    if (!groupGone && closeError) {
      throw new Error('Native application close and process-group cleanup deadlines expired');
    }
    if (!groupGone) throw new Error('Native application process-group cleanup deadline expired');
    if (closeError) throw closeError;
    if ((await inspectRunningProcessGroupMembers(this.pid)).length > 0) {
      throw new Error('Native application left a running process in its owned process group');
    }
    this.released = true;
  }

  async waitForSuccessfulExit(timeout = PROCESS_TIMEOUT_MS) {
    let result;
    try {
      result = await this.waitForClose(timeout);
    } catch (error) {
      const cleanupFailures = [];
      try {
        await this.terminate();
      } catch (cleanupError) {
        cleanupFailures.push({
          label: 'process-groups',
          error: errorFrom(cleanupError, 'Process-group cleanup failed'),
        });
      }
      throwCombined(errorFrom(error, 'Native application close failed'), cleanupFailures);
    }
    let resultError = result?.error;
    if (!resultError && result?.code !== 0) {
      resultError = new Error(
        `Native application exited with code ${result?.code ?? 'null'} signal ${result?.signal ?? 'none'}`,
      );
    }
    let naturallyDrained;
    try {
      naturallyDrained = await waitUntil(
        async () => (await inspectRunningProcessGroupMembers(this.pid)).length > 0,
        CLEANUP_GRACE_MS,
      );
    } catch (error) {
      const cleanupFailures = [];
      try {
        await this.terminate();
      } catch (cleanupError) {
        cleanupFailures.push({
          label: 'process-groups',
          error: errorFrom(cleanupError, 'Process-group cleanup failed'),
        });
      }
      throwCombined(
        resultError ?? errorFrom(error, 'Native process-group drain inspection failed'),
        cleanupFailures,
      );
    }
    if (!naturallyDrained) {
      const primaryError = resultError
        ?? new Error('Native application main process exited before its owned process group drained');
      const cleanupFailures = [];
      try {
        await this.terminate();
      } catch (cleanupError) {
        cleanupFailures.push({
          label: 'process-groups',
          error: errorFrom(cleanupError, 'Process-group cleanup failed'),
        });
      }
      throwCombined(primaryError, cleanupFailures);
    }
    // Relinquish authority only after proving that the complete group is gone;
    // this also prevents a later cleanup pass from acting on a reused PID.
    this.released = true;
    if (resultError) throw resultError;
  }
}

export class OwnedProcessGroups {
  constructor() {
    this.groups = [];
  }

  track(child) {
    const group = new OwnedProcessGroup(child);
    this.groups.push(group);
    return group;
  }

  async cleanup() {
    const failures = [];
    for (const group of [...this.groups].reverse()) {
      try {
        await group.terminate();
      } catch (error) {
        failures.push({ label: 'process-groups', error: errorFrom(error, 'Process-group cleanup failed') });
      }
    }
    return failures;
  }
}

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const inspectStagedArtifact = async ({ artifact, kind, target, workRoot }) => {
  if (kind !== 'dmg') {
    return inspectArtifactArchitecture({ path: artifact, kind, platform: target.platform, arch: target.arch });
  }
  const privatePath = join(workRoot, 'held-artifact.dmg');
  await copyFile(artifact, privatePath, fsConstants.COPYFILE_EXCL);
  await chmod(privatePath, 0o600);
  const handle = await open(privatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const heldArtifact = createHeldDmgArtifact(handle, 'staged native lifecycle DMG', privatePath);
    return await inspectArtifactArchitecture({
      heldArtifact,
      kind,
      platform: target.platform,
      arch: target.arch,
    });
  } finally {
    await handle.close();
    await rm(privatePath, { force: true });
  }
};

const canonicalArtifact = ({ directory, platform, arch, version, kind }) => join(
  directory,
  `ProPR-Desktop-${version}-${platform === 'darwin' ? 'macos' : 'linux'}-${arch}.${kind}`,
);

export const assertArtifactSet = async target => {
  const expectedKinds = target.platform === 'linux' ? ['deb', 'rpm', 'zip'] : ['dmg', 'zip'];
  const entries = await readdir(target.artifactDirectory, { withFileTypes: true });
  for (const kind of expectedKinds) {
    const path = canonicalArtifact({ directory: target.artifactDirectory, ...target, kind });
    const entry = entries.find(candidate => candidate.name === basename(path));
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Native lifecycle requires exactly the canonical staged ${kind} artifact`);
    }
  }
  const unexpected = entries.filter(entry => {
    if (entry.name === 'release-fragment.json') return false;
    return !expectedKinds.some(kind => entry.name === basename(canonicalArtifact({
      directory: target.artifactDirectory, ...target, kind,
    })));
  });
  if (unexpected.length) throw new Error('Native lifecycle artifact directory contains an unexpected or duplicate identity');
  return expectedKinds;
};

export const assertSafeExtractedTree = async root => {
  const canonicalRoot = await realpath(root);
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        const fromRoot = relative(canonicalRoot, target);
        if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw new Error('Native artifact contains a symlink escaping its install root');
        }
        const targetStats = await stat(path);
        if (!targetStats.isFile() && !targetStats.isDirectory()) {
          throw new Error('Native artifact contains a symlink to an unsupported filesystem entry');
        }
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (!entry.isFile()) {
        throw new Error('Native artifact contains an unsupported filesystem entry');
      }
    }
  };
  await visit(root);
};

const waitForPipelineProcess = child => new Promise(resolveProcess => {
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => resolveProcess({ code, error: spawnError, signal }));
});

const stopPipelineProcess = async (child, completion) => {
  const running = child.exitCode === null
    && (child.signalCode === undefined || child.signalCode === null);
  if (running) child.kill('SIGTERM');
  const result = await withDeadline(completion, CLEANUP_GRACE_MS, 'RPM extraction process stop grace expired')
    .catch(() => null);
  if (result) return result;
  child.kill('SIGKILL');
  return withDeadline(completion, CLEANUP_GRACE_MS, 'RPM extraction process cleanup deadline expired');
};

export const extractRpm = async (artifact, root, {
  converterFile = '/usr/bin/rpm2cpio',
  extractorFile = '/usr/bin/cpio',
  spawnProcess = spawn,
  timeout = COMMAND_TIMEOUT_MS,
} = {}) => {
  const converter = spawnProcess(converterFile, [artifact], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const extractor = spawnProcess(
    extractorFile,
    ['--extract', '--make-directories', '--no-absolute-filenames', '--quiet'],
    { cwd: root, shell: false, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  const converterCompletion = waitForPipelineProcess(converter);
  const extractorCompletion = waitForPipelineProcess(extractor);
  const stopExtractorOnConverterFailure = converterCompletion.then(result => (
    result.error || result.code !== 0 ? stopPipelineProcess(extractor, extractorCompletion) : undefined
  ));
  const stopConverterOnExtractorFailure = extractorCompletion.then(result => (
    result.error || result.code !== 0 ? stopPipelineProcess(converter, converterCompletion) : undefined
  ));
  let diagnostics = Buffer.alloc(0);
  converter.stderr.on('data', chunk => { diagnostics = appendBounded(diagnostics, chunk); });
  extractor.stderr.on('data', chunk => { diagnostics = appendBounded(diagnostics, chunk); });
  converter.stdout.pipe(extractor.stdin);

  let results;
  try {
    results = await withDeadline(
      Promise.all([
        converterCompletion,
        extractorCompletion,
        stopExtractorOnConverterFailure,
        stopConverterOnExtractorFailure,
      ]).then(([converterResult, extractorResult]) => [converterResult, extractorResult]),
      timeout,
      'RPM extraction deadline expired',
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([
      stopPipelineProcess(converter, converterCompletion),
      stopPipelineProcess(extractor, extractorCompletion),
    ]);
    const cleanupFailures = cleanup
      .filter(result => result.status === 'rejected')
      .map(result => ({ label: 'rpm-processes', error: result.reason }));
    throwCombined(errorFrom(error, 'RPM extraction failed'), cleanupFailures);
  }
  const [converterResult, extractorResult] = results;
  if (converterResult.error) throw converterResult.error;
  if (extractorResult.error) throw extractorResult.error;
  if (converterResult.code !== 0) {
    throw new Error(`rpm2cpio failed with code ${converterResult.code ?? 'null'} signal ${converterResult.signal ?? 'none'}`);
  }
  if (extractorResult.code !== 0) {
    throw new Error(`cpio failed with code ${extractorResult.code ?? 'null'} signal ${extractorResult.signal ?? 'none'}`);
  }
  if (diagnostics.length !== 0) throw new Error('RPM extraction emitted unexpected diagnostics');
};

const locateApplication = async ({ platform, arch, kind, installRoot }) => {
  if (platform === 'linux') {
    const packagePayload = join(installRoot, 'usr', 'lib', EXECUTABLE);
    const zipPayload = join(installRoot, `propr-desktop-linux-${arch}`);
    const applicationRoot = kind === 'zip' ? zipPayload : packagePayload;
    return {
      applicationRoot,
      executable: join(applicationRoot, EXECUTABLE),
      desktopFile: kind === 'zip' ? null : join(installRoot, 'usr', 'share', 'applications', `${EXECUTABLE}.desktop`),
      iconFile: kind === 'zip' ? null : join(installRoot, 'usr', 'share', 'pixmaps', DESKTOP_ICON_FILE),
    };
  }
  const candidates = (await readdir(installRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (candidates.length !== 1) throw new Error('Native macOS artifact has a missing or duplicate application identity');
  const applicationRoot = join(installRoot, candidates[0].name);
  return {
    applicationRoot,
    executable: join(applicationRoot, 'Contents', 'MacOS', EXECUTABLE),
    desktopFile: null,
    iconFile: null,
  };
};

const mountOutputContains = (output, mountRoot) => output.toString('utf8')
  .split(/\r?\n/)
  .some(line => line.trimEnd().endsWith(mountRoot));

export class DmgMountAuthority {
  constructor(mountRoot, { runCommand = run } = {}) {
    this.mountRoot = mountRoot;
    this.runCommand = runCommand;
    this.mounted = false;
  }

  async attach(artifact) {
    // hdiutil can mount successfully before returning a failure or being killed.
    // Hold tentative authority until an exact post-failure query proves absence.
    this.mounted = true;
    try {
      await this.runCommand('/usr/bin/hdiutil', [
        'attach', '-readonly', '-nobrowse', '-mountpoint', this.mountRoot, artifact,
      ]);
    } catch (error) {
      try {
        const mounts = await this.runCommand('/usr/bin/hdiutil', ['info'], { timeout: 30_000 });
        if (!mountOutputContains(mounts.stdout, this.mountRoot)) this.mounted = false;
      } catch {
        // A failed query cannot release tentative mount authority. The caller's
        // cleanup pass will retry detach plus the exact absence postcondition.
      }
      throw error;
    }
  }

  async detach() {
    if (!this.mounted) return;
    let detachError;
    try {
      await this.runCommand('/usr/bin/hdiutil', ['detach', this.mountRoot], { timeout: 30_000 });
    } catch (error) {
      detachError = errorFrom(error, 'DMG detach failed');
    }
    let mounts;
    let queryError;
    try {
      mounts = await this.runCommand('/usr/bin/hdiutil', ['info'], { timeout: 30_000 });
    } catch (error) {
      queryError = errorFrom(error, 'DMG mount postcondition query failed');
    }
    const stale = mounts ? mountOutputContains(mounts.stdout, this.mountRoot) : false;
    if (!queryError && !stale) this.mounted = false;
    const failures = [];
    if (detachError) failures.push({ label: 'dmg-detach', error: detachError });
    if (queryError) failures.push({ label: 'dmg-mount-query', error: queryError });
    if (stale) failures.push({ label: 'dmg-mounted-postcondition', error: new Error('DMG mount remained active') });
    throwCombined(null, failures);
  }
}

export const extractDmg = async ({
  artifact,
  installRoot,
  mountAuthority,
  readDirectory = readdir,
  runCommand = run,
}) => {
  let primaryError;
  try {
    await mountAuthority.attach(artifact);
    const applications = (await readDirectory(mountAuthority.mountRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (applications.length !== 1) throw new Error('Mounted DMG has a missing or duplicate application identity');
    await runCommand('/usr/bin/ditto', [
      join(mountAuthority.mountRoot, applications[0].name),
      join(installRoot, applications[0].name),
    ]);
  } catch (error) {
    primaryError = errorFrom(error, 'DMG extraction failed');
  }
  const cleanupFailures = [];
  if (mountAuthority.mounted) {
    try {
      await mountAuthority.detach();
    } catch (error) {
      cleanupFailures.push({ label: 'dmg-mount', error: errorFrom(error, 'DMG cleanup failed') });
    }
  }
  throwCombined(primaryError, cleanupFailures);
};

const extractArtifact = async ({ artifact, kind, target, installRoot, mountAuthority }) => {
  if (kind === 'deb') {
    await run('/usr/bin/dpkg-deb', ['--extract', artifact, installRoot]);
  } else if (kind === 'rpm') {
    await extractRpm(artifact, installRoot);
  } else if (kind === 'zip' && target.platform === 'linux') {
    await run('/usr/bin/unzip', ['-q', artifact, '-d', installRoot]);
  } else if (kind === 'zip') {
    await run('/usr/bin/ditto', ['-x', '-k', artifact, installRoot]);
  } else {
    await extractDmg({ artifact, installRoot, mountAuthority });
  }
};

const validateIdentity = async ({ target, kind, application }) => {
  const handle = await open(application.executable, 'r');
  const bytes = Buffer.alloc(4096);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(bytes, 0, bytes.length, 0));
  } finally {
    await handle.close();
  }
  const executable = inspectExecutableBytes(bytes.subarray(0, bytesRead));
  const expectedFormat = target.platform === 'linux' ? 'elf' : 'mach-o';
  if (executable.format !== expectedFormat || executable.architectures.length !== 1
    || executable.architectures[0] !== target.arch) {
    throw new Error('Extracted native artifact executable architecture mismatch');
  }
  const executableStats = await lstat(application.executable);
  if (!executableStats.isFile() || executableStats.isSymbolicLink() || (executableStats.mode & 0o111) === 0) {
    throw new Error('Extracted native artifact executable identity is invalid');
  }
  if (target.platform === 'linux') {
    await verifyPackagedLinuxIcon(application.applicationRoot);
    await verifyPackagedTrayIcon(join(application.applicationRoot, 'resources'));
    if (kind !== 'zip') {
      await verifyLinuxLauncherIcon({ desktopFile: application.desktopFile, iconFile: application.iconFile });
    }
    return;
  }
  const plist = join(application.applicationRoot, 'Contents', 'Info.plist');
  const readPlist = async key => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.toString().trim();
  if (await readPlist('CFBundleIdentifier') !== APP_ID
    || await readPlist('CFBundleShortVersionString') !== target.version
    || await readPlist('CFBundleExecutable') !== EXECUTABLE
    || await readPlist('CFBundleURLTypes.0.CFBundleURLSchemes.0') !== 'propr') {
    throw new Error('macOS application identity, version, or protocol declaration is invalid');
  }
  await verifyMacApplicationIcon({ applicationRoot: application.applicationRoot, readPlist });
  await verifyPackagedTrayIcon(join(application.applicationRoot, 'Contents', 'Resources'));
};

const readFixedEvidenceEvents = async path => {
  const records = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records.some(record => Object.keys(record).length !== 1 || typeof record.event !== 'string')) {
    throw new Error('Native application emitted secret-capable evidence fields');
  }
  return records.map(record => record.event);
};

export const waitForEvents = async (path, events, child, timeout = PROCESS_TIMEOUT_MS) => {
  const deadline = Date.now() + timeout;
  const hasRequiredEvents = async () => {
    const names = await readFixedEvidenceEvents(path);
    return events.every(event => names.includes(event));
  };
  while (true) {
    try {
      if (await hasRequiredEvents()) return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const signalled = child.signalCode !== undefined && child.signalCode !== null;
    const exited = child.exitCode !== null || signalled;
    if (exited) {
      // Exit can become observable after the first read even though the child's
      // final fsynced event preceded that exit. Re-read the now-stable file once.
      try {
        if (await hasRequiredEvents()) return;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          if (error instanceof SyntaxError) throw new Error('Native application evidence was malformed');
          throw error;
        }
      }
      const resultClass = signalled ? 'SIGNALLED' : child.exitCode === 0 ? 'CLEAN_EXIT' : 'FAILED_EXIT';
      throw new NativeLifecycleEvidenceWaitFailure(resultClass);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(50, remaining));
  }
  throw new NativeLifecycleEvidenceWaitFailure('EVIDENCE_DEADLINE');
};

const assertEvidenceOrdering = async (path, requiredEvents) => {
  const records = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const names = records.map(record => record.event);
  let previous = -1;
  for (const event of requiredEvents) {
    const occurrences = names.reduce((count, name) => count + Number(name === event), 0);
    const index = names.indexOf(event);
    if (occurrences !== 1 || index <= previous) {
      throw new Error('Native application evidence was duplicated or out of order');
    }
    previous = index;
  }
};

const startApplication = (application, args, env, cwd, processGroups) => processGroups.track(spawn(application.executable, args, {
  cwd,
  env,
  detached: true,
  shell: false,
  stdio: ['ignore', 'ignore', 'ignore'],
}));

const dispatchDirect = async (application, userData, link, env, processGroups, launchArguments = []) => {
  const group = startApplication(
    application,
    [...launchArguments, `--user-data-dir=${userData}`, link],
    env,
    dirname(application.applicationRoot),
    processGroups,
  );
  await group.waitForSuccessfulExit(15_000);
};

export const linuxProtocolDispatch = async ({ application, profile, link, env, processGroups }, {
  runCommand = run,
} = {}) => {
  if (!application.desktopFile) {
    await dispatchDirect(application, profile.userData, link, env, processGroups);
    return 'direct-second-instance; ZIP has no OS launcher registration';
  }
  const applications = join(profile.xdgData, 'applications');
  await mkdir(applications, { recursive: true, mode: 0o700 });
  const registered = join(applications, `${EXECUTABLE}.desktop`);
  const source = await readFile(application.desktopFile, 'utf8');
  const relocated = source.replace(
    /^Exec=.*$/m,
    `Exec=${application.executable} --disable-gpu --password-store=gnome-libsecret --user-data-dir=${profile.userData} %U`,
  );
  if (relocated === source) throw new Error('Linux launcher relocation did not replace exactly one Exec declaration');
  await writeFile(registered, relocated, { mode: 0o600 });
  // Keep the command and outcome visible without printing child output, URLs,
  // or private profile paths. A stage-only PROTOCOL_DISPATCH failure cannot
  // distinguish registration failures from a GIO launch failure or deadline.
  let stage = 'PROTOCOL_DATABASE';
  try {
    await runCommand('/usr/bin/update-desktop-database', [applications], { env });
    stage = 'PROTOCOL_REGISTER';
    await runCommand('/usr/bin/xdg-mime', ['default', `${EXECUTABLE}.desktop`, 'x-scheme-handler/propr'], { env });
    stage = 'PROTOCOL_QUERY';
    const query = await runCommand('/usr/bin/xdg-mime', ['query', 'default', 'x-scheme-handler/propr'], { env });
    if (query.stdout.toString().trim() !== `${EXECUTABLE}.desktop`) {
      throw new NativeLifecycleCommandFailure('UNEXPECTED_OUTPUT');
    }
    stage = 'PROTOCOL_LAUNCH';
    await runCommand('/usr/bin/gio', ['open', link], { env, timeout: 15_000 });
  } catch (error) {
    throw new NativeLifecycleOperationFailure(stage, error);
  }
  return 'xdg-mime-registration+gio-dispatch (CI-relocated package launcher)';
};

const LAUNCH_SERVICES = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// lsregister -u can return before -dump reflects the removal, so absence is
// re-probed for a bounded window before the copied app is declared stale. The
// window is a deadline rather than a probe count: one -dump costs milliseconds
// on an idle host and seconds on a loaded CI runner, so counting probes gives
// the shortest window exactly where LaunchServices is slowest to settle.
// The window admits two full-length dumps, so one slow dump can never be the
// whole proof: a thirty-second flat probe cap used to kill four consecutive
// darwin-x64 dumps and report the postcondition as COMMAND_DEADLINE.
const LAUNCH_SERVICES_ABSENCE_BUDGET_MS = 240_000;
const LAUNCH_SERVICES_ABSENCE_INTERVAL_MS = 1_000;
// lsregister -dump emits megabytes, so a dump record is never read back through
// the shared bounded-output helper: that would reduce the probe to whichever
// records happened to land in the retained OUTPUT_CAP tail.
const LAUNCH_SERVICES_DUMP_LINE_CAP = 64 * 1024;
// A dump that is still emitting records is slow, not stuck, so the probe is
// bounded by silence rather than by total runtime: a loaded Intel runner walks
// the whole LaunchServices database well past any fixed cap that is short
// enough to leave room for a retry. The absolute deadline stays as the backstop
// for a dump that trickles forever.
const LAUNCH_SERVICES_DUMP_STALL_MS = 30_000;
const LAUNCH_SERVICES_DUMP_TIMEOUT_MS = 120_000;

export const launchServicesRecordMatchesApplication = (line, applicationRoot) => {
  const record = line.trim();
  if (!record.startsWith('path:')) return false;
  const value = record.slice('path:'.length).trim();
  if (!value.startsWith(applicationRoot)) return false;
  const after = value[applicationRoot.length];
  return after === undefined || /[\s"',)]/.test(after);
};

// Streams a command's stdout line by line and stops at the first match. Only one
// bounded line is ever retained, so an unbounded dump is scanned in full without
// buffering it and without a truncation window deciding the answer.
export const scanCommandLinesForMatch = (file, args, { env, timeout, stallTimeout } = {}, matchesLine) =>
  new Promise((resolveScan, reject) => {
    const child = spawn(file, args, { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let carry = '';
    let matched = false;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stallTimer);
      if (error) reject(error); else resolveScan(value);
    };
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(expire, timeout ?? COMMAND_TIMEOUT_MS);
    // An optional stall deadline bounds silence instead of runtime: every chunk
    // restarts it, so a dump that keeps producing records is never killed for
    // being slow, while one that stops answering still ends as COMMAND_DEADLINE.
    let stallTimer;
    const restartStallDeadline = () => {
      if (stallTimeout === undefined || settled) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(expire, stallTimeout);
    };
    restartStallDeadline();
    const consume = line => {
      if (matchesLine(line)) {
        matched = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.setEncoding('utf8');
    // Stopping early kills the producer mid-write, so a torn read after a match
    // is the expected end of the scan rather than a failed probe.
    child.stdout.on('error', () => {
      if (matched) settle(null, { matched: true });
      else settle(new NativeLifecycleCommandFailure('COMMAND_FAILED'));
    });
    child.stdout.on('data', chunk => {
      if (matched) return;
      restartStallDeadline();
      carry += chunk;
      let newline = carry.indexOf('\n');
      while (newline >= 0 && !matched) {
        consume(carry.slice(0, newline));
        carry = carry.slice(newline + 1);
        newline = carry.indexOf('\n');
      }
      // A record longer than the cap cannot be a bundle path record; drop it
      // rather than letting one pathological line grow without bound.
      if (!matched && carry.length > LAUNCH_SERVICES_DUMP_LINE_CAP) carry = '';
    });
    child.once('error', () => settle(new NativeLifecycleCommandFailure('COMMAND_SPAWN_FAILED')));
    child.once('close', (code, signal) => {
      if (matched) {
        settle(null, { matched: true });
        return;
      }
      if (timedOut) {
        settle(new NativeLifecycleCommandFailure('COMMAND_DEADLINE'));
        return;
      }
      if (code !== 0) {
        settle(new NativeLifecycleCommandFailure(signal ? 'COMMAND_SIGNALLED' : 'COMMAND_FAILED'));
        return;
      }
      if (carry) consume(carry);
      settle(null, { matched });
    });
  });

// Carries why the absence proof ended without ever seeing the bundle gone: a
// dump that kept listing it, a dump that never produced a usable answer, or a
// bundle that stayed listed while the re-issued removal itself kept failing.
export class LaunchServicesAbsenceFailure extends Error {
  constructor(probeFailure, { unregisterFailed = false } = {}) {
    const resultClass = probeFailure === undefined
      ? unregisterFailed ? LAUNCH_SERVICES_UNREGISTER_FAILED : LAUNCH_SERVICES_STALE_REGISTRATION
      : probeFailure instanceof NativeLifecycleCommandFailure
        ? probeFailure.resultClass
        : 'COMMAND_FAILED';
    super(probeFailure === undefined
      ? `Copied application remained registered with LaunchServices [result:${resultClass}]`
      : `Copied application registration could not be probed [result:${resultClass}]`);
    this.name = 'LaunchServicesAbsenceFailure';
    this.resultClass = resultClass;
  }
}

export class LaunchServicesAuthority {
  constructor(applicationRoot, environment, {
    runCommand = run,
    scanCommand = scanCommandLinesForMatch,
    wait = delay,
    now = Date.now,
    absenceBudgetMs = LAUNCH_SERVICES_ABSENCE_BUDGET_MS,
    // The deadline is the production bound; an explicit probe cap only ever
    // narrows it, so a caller can close the window without waiting out a clock.
    absenceAttempts = Number.POSITIVE_INFINITY,
  } = {}) {
    this.applicationRoot = applicationRoot;
    this.environment = environment;
    this.runCommand = runCommand;
    this.scanCommand = scanCommand;
    this.wait = wait;
    this.now = now;
    this.absenceBudgetMs = absenceBudgetMs;
    this.absenceAttempts = absenceAttempts;
    this.registered = false;
  }

  async register() {
    // lsregister can update its database before returning a failure or timeout.
    // Keep tentative authority so every exit path unregisters and proves absence.
    this.registered = true;
    await this.runCommand(LAUNCH_SERVICES, ['-f', this.applicationRoot], { env: this.environment, timeout: 30_000 });
  }

  async dispatch(link) {
    if (!this.registered) throw new Error('Copied application must be registered before LaunchServices dispatch');
    await this.runCommand('/usr/bin/open', ['-a', this.applicationRoot, link], {
      env: this.environment,
      timeout: 15_000,
    });
  }

  async unregister() {
    if (!this.registered) return;
    await this.runCommand(LAUNCH_SERVICES, ['-u', this.applicationRoot], { env: this.environment, timeout: 30_000 });
  }

  async isListed() {
    const { matched } = await this.scanCommand(
      LAUNCH_SERVICES,
      ['-dump'],
      {
        env: this.environment,
        timeout: LAUNCH_SERVICES_DUMP_TIMEOUT_MS,
        stallTimeout: LAUNCH_SERVICES_DUMP_STALL_MS,
      },
      line => launchServicesRecordMatchesApplication(line, this.applicationRoot),
    );
    return matched;
  }

  // Absence is only ever concluded from a probe that ran and reported the
  // bundle gone. A probe that could not run is not evidence of anything, so it
  // costs one attempt rather than ending the proof: `lsregister -dump` walks
  // the whole database, and one slow or interrupted dump on a loaded runner
  // used to fail the postcondition that this retry window exists for.
  async assertGone() {
    // The window is a deadline rather than a probe count, and it is only
    // consulted after a probe answered, so it always closes on evidence rather
    // than on an unprobed timer. A failed re-issued removal does not prove the
    // record stale either, so it also keeps the window running; it is retained
    // so an exhausted window names why, since the CI log renders only the label.
    const deadline = this.now() + this.absenceBudgetMs;
    let lastProbeFailure;
    let unregisterFailed = false;
    for (let attempt = 1; attempt <= this.absenceAttempts; attempt += 1) {
      try {
        if (!await this.isListed()) {
          this.registered = false;
          return;
        }
        lastProbeFailure = undefined;
      } catch (error) {
        lastProbeFailure = error;
      }
      if (attempt === this.absenceAttempts || this.now() >= deadline) break;
      await this.wait(LAUNCH_SERVICES_ABSENCE_INTERVAL_MS);
      // A bundle opened through LaunchServices can be re-registered by the
      // system after -u returns, so each re-probe re-issues the removal instead
      // of only waiting for the first one to be reflected. The re-issue is
      // never evidence either way: the first removal already ran as its own
      // cleanup step, and only the next dump decides anything. So a re-issue
      // that exits non-zero on a busy runner (lsregister also exits nonzero
      // once the record it was racing is gone) costs this attempt rather than
      // ending the proof, and the deadline still bounds the proof.
      try {
        await this.unregister();
      } catch {
        // Absence is concluded only from a dump, never from a -u exit status;
        // the failure is only recorded so an exhausted window can name it.
        unregisterFailed = true;
      }
    }
    throw new LaunchServicesAbsenceFailure(lastProbeFailure, { unregisterFailed });
  }
}

export const removeCopiedApplicationWithLaunchServicesAuthority = async ({
  installRoot,
  launchServices,
}, {
  removeInstallRoot = path => rm(path, { recursive: true, force: true }),
  assertInstallRootAbsent = path => assertAbsent(
    path,
    'Native uninstall/remove left an owned install root behind',
  ),
} = {}) => {
  const failures = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push({ label, error: errorFrom(error, 'Native lifecycle cleanup failed') });
    }
  };
  if (launchServices?.registered) {
    await attempt('launchservices-unregister', () => launchServices.unregister());
    await attempt('launchservices-postcondition', () => launchServices.assertGone());
  }
  if (failures.length === 0) {
    await attempt('install-root', () => removeInstallRoot(installRoot));
    await attempt('install-postcondition', () => assertInstallRootAbsent(installRoot));
  }
  return failures;
};

const processGroupAbsenceWasProved = cleanupFailures => (
  !cleanupFailures.some(failure => failure.label === 'process-groups')
);

export const removeLifecycleRootsWithAuthority = async ({
  cleanupFailures,
  installRoot,
  launchServices,
  workRoot,
}, {
  removeCopiedApplication = removeCopiedApplicationWithLaunchServicesAuthority,
  removeWorkRoot = path => rm(path, { recursive: true, force: true }),
  assertWorkRootAbsent = path => assertAbsent(
    path,
    'Native lifecycle work root remained after cleanup',
  ),
} = {}) => {
  const failures = [...cleanupFailures];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push({ label, error: errorFrom(error, 'Native lifecycle cleanup failed') });
    }
  };

  // A copied executable remains the only bounded remediation authority if the owned
  // process group could still contain a live member. Do not unregister or remove it.
  if (processGroupAbsenceWasProved(failures)) {
    failures.push(...await removeCopiedApplication({ installRoot, launchServices }));
  }
  const blocksOuterRemoval = failures.some(failure => [
    'process-groups',
    'dmg-mount',
    'mount-postcondition',
    'profile-authority',
    'launchservices-unregister',
    'launchservices-postcondition',
    'install-root',
    'install-postcondition',
  ].includes(failure.label));
  if (!blocksOuterRemoval) {
    await attempt('work-root', () => removeWorkRoot(workRoot));
    await attempt('work-postcondition', () => assertWorkRootAbsent(workRoot));
  }
  return failures;
};

const assertProfileAuthority = async profile => {
  const desktop = join(profile.userData, 'desktop');
  const state = join(desktop, 'profiles.json');
  const logs = join(profile.userData, 'logs');
  const logsFromRoot = relative(profile.root, logs);
  const log = join(logs, 'desktop.jsonl');
  const [rootStats, desktopStats, stateStats, logsStats, logStats] = await Promise.all([
    lstat(profile.root),
    lstat(desktop),
    lstat(state),
    lstat(logs),
    lstat(log),
  ]);
  if ((rootStats.mode & 0o777) !== 0o700 || (desktopStats.mode & 0o777) !== 0o700
    || (stateStats.mode & 0o777) !== 0o600 || stateStats.isSymbolicLink()
    || !logsFromRoot || logsFromRoot.startsWith('..') || isAbsolute(logsFromRoot)
    || (logsStats.mode & 0o777) !== 0o700 || logsStats.isSymbolicLink()
    || (logStats.mode & 0o777) !== 0o600 || logStats.isSymbolicLink()) {
    throw new Error('Native profile state did not retain 0700/0600 authority');
  }
  const contents = await readFile(state, 'utf8');
  let persisted;
  try {
    persisted = JSON.parse(contents);
  } catch {
    throw new Error('Native profile state is not valid JSON');
  }
  if (persisted?.version !== 3
    || !persisted.credentialSlots || Object.keys(persisted.credentialSlots).length !== 0
    || !persisted.credentialEpochs || Object.keys(persisted.credentialEpochs).length !== 0
    || !persisted.pendingRevocations || Object.keys(persisted.pendingRevocations).length !== 0
    || /native-custody-probe|propr_it_/i.test(contents)) {
    throw new Error('Native non-secret profile state contains a secret-bearing field');
  }
};

const createProfileApi = async () => {
  const server = createServer((request, response) => {
    const allowed = request.method === 'GET'
      && ['/api/compatibility', '/api/desktop/discovery'].includes(request.url ?? '')
      && request.headers.origin === 'propr-app://renderer';
    response.writeHead(allowed ? 200 : 403, {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': 'propr-app://renderer',
      'Content-Type': 'application/json',
    });
    response.end(request.url === '/api/desktop/discovery'
      ? '{"product":"ProPR","desktopAuthentication":{"protocolVersion":1}}'
      : '{"profileEndpoint":true}');
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Native profile API did not bind safely');
    return { port: address.port, server, url: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    const primaryError = errorFrom(error, 'Native profile API creation failed');
    const cleanupFailures = [];
    if (server.listening) {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          try {
            server.closeAllConnections();
          } finally {
            await Promise.race([
              new Promise((resolveClose, rejectClose) => server.close(closeError => (
                closeError ? rejectClose(closeError) : resolveClose()
              ))),
              delay(CLEANUP_GRACE_MS).then(() => {
                throw new Error('Native profile API setup close deadline expired');
              }),
            ]);
          }
          if (server.listening || server.address() !== null) {
            throw new Error('Native profile API retained listening authority after setup failure');
          }
        } else {
          await closeProfileApi({ server, port: address.port });
        }
      } catch (cleanupError) {
        cleanupFailures.push({
          label: 'profile-api-setup',
          error: errorFrom(cleanupError, 'Native profile API setup cleanup failed'),
        });
      }
    }
    throwCombined(primaryError, cleanupFailures);
  }
};

const assertPortClosed = (port, timeout = CLEANUP_GRACE_MS) => new Promise((resolveClosed, rejectClosed) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const timer = setTimeout(() => {
    socket.destroy();
    rejectClosed(new Error('Native profile API close postcondition deadline expired'));
  }, timeout);
  socket.once('connect', () => {
    clearTimeout(timer);
    socket.destroy();
    rejectClosed(new Error('Native profile API remained reachable after close'));
  });
  socket.once('error', error => {
    clearTimeout(timer);
    if (error?.code === 'ECONNREFUSED') resolveClosed();
    else rejectClosed(new Error('Native profile API close postcondition failed'));
  });
});

export const closeProfileApi = async ({ server, port }, {
  closeDeadline = CLEANUP_GRACE_MS,
  probeClosed = assertPortClosed,
} = {}) => {
  const failures = [];
  let closeError;
  if (server.listening) {
    try {
      server.closeAllConnections();
    } catch (error) {
      failures.push({
        label: 'profile-api-connections',
        error: errorFrom(error, 'Native profile API connection cleanup failed'),
      });
    }
    try {
      await withDeadline(
        new Promise((resolveClose, rejectClose) => server.close(error => (
          error ? rejectClose(error) : resolveClose()
        ))),
        closeDeadline,
        'Native profile API close deadline expired',
      );
    } catch (error) {
      closeError = errorFrom(error, 'Native profile API close failed');
    }
  }
  if (closeError) failures.push({ label: 'profile-api-close', error: closeError });
  if (server.listening || server.address() !== null) {
    failures.push({ label: 'profile-api-listening', error: new Error('Native profile API retained listening authority') });
  } else {
    try {
      await probeClosed(port);
    } catch (error) {
      failures.push({ label: 'profile-api-postcondition', error: errorFrom(error, 'Native profile API postcondition failed') });
    }
  }
  throwCombined(null, failures);
};

const assertAbsent = async (path, message) => {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
};

export const removeAuthorizedProfile = async (profile, {
  inspectPath = lstat,
  removeProfile = removePrivateSmokeProfile,
} = {}) => {
  let removalError;
  try {
    await removeProfile(profile);
  } catch (error) {
    removalError = errorFrom(error, 'Native private profile authority cleanup failed');
  }
  let postconditionError;
  try {
    await inspectPath(profile.root);
    postconditionError = new Error('Native private profile remained after authority cleanup');
  } catch (error) {
    if (error?.code !== 'ENOENT') postconditionError = errorFrom(error, 'Native private profile postcondition failed');
  }
  const failures = [];
  if (removalError) failures.push({ label: 'profile-authority', error: removalError });
  if (postconditionError) failures.push({ label: 'profile-postcondition', error: postconditionError });
  throwCombined(null, failures);
};

const defaultUserDataCandidates = target => {
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error('Native lifecycle runner home is invalid');
  const applicationNames = [EXECUTABLE, 'ProPR Desktop'];
  return target.platform === 'darwin'
    ? applicationNames.flatMap(name => [
        join(home, 'Library', 'Application Support', name),
        join(home, 'Library', 'Logs', name),
      ])
    : applicationNames.flatMap(name => [join(home, '.config', name), join(home, '.cache', name)]);
};

const assertDefaultUserDataUntouched = async target => {
  for (const path of defaultUserDataCandidates(target)) {
    try {
      await lstat(path);
      throw new Error('Native lifecycle wrote outside the isolated user-data root');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
};

const evidenceFailureCategory = events => {
  if (events.has('desktop.deeplink.delivery_failed')) return 'DEEP_LINK_DELIVERY_FAILED';
  if (events.has('desktop.renderer.gone')) return 'RENDERER_GONE';
  if (events.has('desktop.native.cold_confirmation_not_visible')) return 'COLD_CONFIRMATION_NOT_VISIBLE';
  if (events.has('desktop.native.cold_confirmation_inspection_failed')) return 'COLD_CONFIRMATION_INSPECTION_FAILED';
  if (events.has('desktop.main_process.uncaught_exception')) return 'UNCAUGHT_EXCEPTION';
  if (events.has('desktop.app.start_failed')) return 'START_FAILED';
  return undefined;
};

export const classifyWarmOpenEvidenceFailure = async (path, resultClass) => {
  if (!NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES.includes(resultClass)) {
    throw new Error('Native lifecycle evidence result class is invalid');
  }
  let milestone = 'NO_EVIDENCE';
  let evidenceState = 'UNREADABLE';
  let failureCategory;
  let handle;
  try {
    // This snapshot is taken before cleanup removes the private profile. Bound
    // the read, reject links/non-files, and never publish records or parse errors.
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stats = await handle.stat();
    if (stats.isFile()) {
      const buffer = Buffer.alloc(OUTPUT_CAP + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (stats.size > OUTPUT_CAP || bytesRead > OUTPUT_CAP) {
        evidenceState = 'OVERSIZED';
      } else {
        evidenceState = 'MALFORMED';
        const records = buffer.subarray(0, bytesRead).toString('utf8').trim().split('\n')
          .filter(Boolean).map(line => JSON.parse(line));
        if (records.every(record => record !== null && typeof record === 'object'
          && !Array.isArray(record) && Object.keys(record).length === 1 && typeof record.event === 'string')) {
          evidenceState = 'READABLE';
          const events = new Set(records.map(record => record.event));
          if (events.has('desktop.renderer.ready')) milestone = 'RENDERER';
          if (events.has('desktop.deeplink.warm_manual_once')) milestone = 'WARM_MANUAL_ACK';
          if (events.has('desktop.deeplink.warm_tunnel_once')) milestone = 'WARM_TUNNEL_ACK';
          if (events.has('desktop.deeplink.warm_open_once')) milestone = 'WARM_OPEN_ACK';
          if (events.has('desktop.app.shutdown')) milestone = 'SHUTDOWN';
          failureCategory = evidenceFailureCategory(events);
        }
      }
    }
  } catch (error) {
    evidenceState = error?.code === 'ENOENT' ? 'MISSING'
      : error instanceof SyntaxError ? 'MALFORMED' : 'UNREADABLE';
  } finally {
    await handle?.close().catch(() => { evidenceState = 'UNREADABLE'; });
  }
  return {
    milestone, resultClass, evidenceState,
    ...(failureCategory ? { failureCategory } : {}),
  };
};

export const waitForWarmOpenEvidence = async (path, child, timeout = PROCESS_TIMEOUT_MS) => {
  try {
    await waitForEvents(path, ['desktop.deeplink.warm_open_once'], child, timeout);
  } catch (error) {
    // #2323's macOS job reached this wait after successful launcher exit and
    // tunnel acknowledgement. Neither proves delivery of the subsequent open
    // link. Keep that assertion and expose the missing outcome before cleanup;
    // the old stage-only failure cannot establish a dispatch or renderer defect.
    const classification = await classifyWarmOpenEvidenceFailure(path,
      error instanceof NativeLifecycleEvidenceWaitFailure ? error.resultClass : 'EVIDENCE_READ_FAILED');
    throw new NativeLifecycleOperationFailure('WARM_OPEN_EVIDENCE', error, classification);
  }
};

export const classifyFirstEvidenceFailure = async (path, resultClass) => {
  if (!NATIVE_LIFECYCLE_EVIDENCE_RESULT_CLASSES.includes(resultClass)) {
    throw new Error('Native lifecycle evidence result class is invalid');
  }
  let milestone = 'NO_EVIDENCE';
  let failureCategory;
  try {
    const events = new Set(await readFixedEvidenceEvents(path));
    if (events.has('desktop.smoke.authorized')) milestone = 'AUTHORIZED';
    if (events.has('desktop.native.identity_verified')) milestone = 'IDENTITY';
    if (events.has('desktop.deeplink.consumer_ready')) milestone = 'CONSUMER_READY';
    if (events.has('desktop.native.secure_storage_backend_invalid')) milestone = 'SECURE_STORAGE_BACKEND';
    if (events.has('desktop.deeplink.delivery_failed')) milestone = 'DEEP_LINK_DELIVERY_FAILURE';
    if (events.has('desktop.deeplink.cold_manual_once')) milestone = 'COLD_ACK';
    if (events.has('desktop.native.secure_storage_probe.started')) milestone = 'SECURE_STORAGE_STARTED';
    if (events.has('desktop.native.secure_storage_probe.completed')) milestone = 'SECURE_STORAGE_COMPLETED';
    if (events.has('desktop.renderer.ready')) milestone = 'RENDERER';
    failureCategory = evidenceFailureCategory(events);
  } catch {
    // Only fixed classifications may cross the native-gate diagnostic boundary.
  }
  const stage = milestone === 'SECURE_STORAGE_STARTED'
    ? 'FIRST_SECURE_STORAGE_PROBE'
    : ['SECURE_STORAGE_COMPLETED', 'RENDERER'].includes(milestone)
      ? 'FIRST_RENDERER_READY'
      : 'FIRST_INITIAL_EVIDENCE';
  return { milestone, resultClass, stage, ...(failureCategory ? { failureCategory } : {}) };
};

const lifecycleForArtifact = async ({ target, kind, artifact, report }) => {
  const workRoot = await mkdtemp(join(tmpdir(), `propr-native-${kind}-`));
  const installRoot = join(workRoot, 'install');
  const mountRoot = join(workRoot, 'mount');
  const processGroups = new OwnedProcessGroups();
  const mountAuthority = kind === 'dmg' ? new DmgMountAuthority(mountRoot) : null;
  let profile;
  let profileApi;
  let application;
  let launchServices;
  let sandboxPrepared = false;
  let primaryError;
  let evidenceClassification;
  let operationStage = 'PREPARE_WORK_ROOT';
  try {
    await chmod(workRoot, 0o700);
    await mkdir(installRoot, { mode: 0o700 });
    await mkdir(mountRoot, { mode: 0o700 });
    const beforeDigest = await digest(artifact);
    operationStage = 'CREATE_PROFILE';
    profile = await createPrivateSmokeProfile(workRoot);
    const logsDirectory = join(profile.userData, 'logs');
    await mkdir(logsDirectory, { mode: 0o700 });
    await chmod(logsDirectory, 0o700);
    operationStage = 'START_PROFILE_API';
    profileApi = await createProfileApi();
    operationStage = 'BASELINE_BEFORE';
    await assertDefaultUserDataUntouched(target);
    operationStage = 'INSPECT_ARTIFACT';
    await inspectStagedArtifact({ artifact, kind, target, workRoot });
    operationStage = 'EXTRACT_ARTIFACT';
    await extractArtifact({ artifact, kind, target, installRoot, mountAuthority });
    operationStage = 'VALIDATE_ARTIFACT';
    application = await locateApplication({ ...target, kind, installRoot });
    await assertSafeExtractedTree(installRoot);
    await validateIdentity({ target, kind, application });
    let darwinSignatureProof;
    if (target.platform === 'darwin') {
      // Check the actual extracted ZIP/DMG payload before the acceptance identity
      // can repair a broken distributable signature and hide a packaging regression.
      if (target.arch === 'arm64' && !process.env.PROPR_DESKTOP_MAC_SIGNING_IDENTITY?.trim()) {
        operationStage = 'VERIFY_DARWIN_LOCAL_PACKAGE_SIGNATURE';
        await verifyDarwinLocalPackage({ application: application.applicationRoot });
      }
      operationStage = 'PREPARE_DARWIN_ACCEPTANCE_SIGNATURE';
      const keychain = process.env.PROPR_DESKTOP_NATIVE_SIGNING_KEYCHAIN;
      const certificateSha1 = process.env.PROPR_DESKTOP_NATIVE_SIGNING_CERTIFICATE_SHA1;
      if (!keychain?.endsWith('.keychain-db') || !/^[A-F0-9]{40}$/.test(certificateSha1 ?? '')) {
        throw new Error('Native Darwin lifecycle requires the CI-only acceptance signing identity');
      }
      darwinSignatureProof = join(workRoot, 'designated-requirement.txt');
      await signDarwinPackagedConnectApplication({
        application: application.applicationRoot,
        keychain,
        certificateSha1,
      });
      await verifyDarwinPackagedConnectSignature({
        mode: 'establish',
        application: application.applicationRoot,
        expectedCertificateSha1: certificateSha1,
        proofPath: darwinSignatureProof,
        keychain,
      });
    }
    if (target.platform === 'linux') {
      operationStage = 'PREPARE_LINUX_SANDBOX';
      const sandbox = join(application.applicationRoot, 'chrome-sandbox');
      await run('/usr/bin/sudo', ['/usr/bin/chown', 'root:root', sandbox]);
      await run('/usr/bin/sudo', ['/usr/bin/chmod', '4755', sandbox]);
      sandboxPrepared = true;
    }

    operationStage = 'CREATE_CHILD_ENVIRONMENT';
    const baseEnvironment = await createSmokeChildEnvironment({
      platform: target.platform,
      profile,
      profileApiUrl: profileApi.url,
      preserveMacosKeychainContext: target.platform === 'darwin',
    });
    const launchContext = createNativeLaunchContext({
      platform: target.platform,
      baseEnvironment,
      sessionAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
    });
    const firstEnvironment = Object.freeze({
      ...launchContext.environment,
      PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE: 'first',
      PROPR_DESKTOP_NATIVE_EXPECTED_ARCH: target.arch,
      PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM: target.platform,
      PROPR_DESKTOP_NATIVE_EXPECTED_VERSION: target.version,
    });
    const dispatchEnvironment = { ...launchContext.environment };
    delete dispatchEnvironment.PROPR_DESKTOP_SMOKE_TEST;
    delete dispatchEnvironment.PROPR_DESKTOP_SMOKE_PROFILE_API_URL;

    operationStage = 'FIRST_LAUNCH';
    const first = startApplication(application, [
      ...launchContext.arguments,
      '--propr-smoke-test',
      `--user-data-dir=${profile.userData}`,
      COLD_MANUAL,
    ], firstEnvironment, workRoot, processGroups);
    const firstEvidence = join(profile.userData, 'application.smoke-evidence.first.jsonl');
    operationStage = 'FIRST_INITIAL_EVIDENCE';
    try {
      await waitForEvents(firstEvidence, ['desktop.renderer.ready', 'desktop.deeplink.cold_manual_once'], first.child);
    } catch (error) {
      if (error instanceof NativeLifecycleEvidenceWaitFailure) {
        evidenceClassification = await classifyFirstEvidenceFailure(firstEvidence, error.resultClass);
        operationStage = evidenceClassification.stage;
      }
      throw error;
    }
    operationStage = 'WARM_MANUAL_DISPATCH';
    await dispatchDirect(
      application,
      profile.userData,
      WARM_MANUAL,
      dispatchEnvironment,
      processGroups,
      launchContext.arguments,
    );
    operationStage = 'WARM_MANUAL_EVIDENCE';
    await waitForEvents(firstEvidence, ['desktop.deeplink.warm_manual_once'], first.child);
    if (target.platform === 'darwin') {
      launchServices = new LaunchServicesAuthority(application.applicationRoot, dispatchEnvironment);
    }
    let protocol;
    if (target.platform === 'linux') {
      operationStage = 'PROTOCOL_DISPATCH';
      protocol = await linuxProtocolDispatch({
        application,
        profile,
        link: WARM_TUNNEL,
        env: dispatchEnvironment,
        processGroups,
      });
    } else {
      operationStage = 'LS_REGISTER';
      await launchServices.register();
      operationStage = 'OPEN_DISPATCH';
      await launchServices.dispatch(WARM_TUNNEL);
      protocol = 'LaunchServices-registration+open-exact-application-dispatch';
    }
    operationStage = 'PROTOCOL_EVIDENCE';
    await waitForEvents(firstEvidence, ['desktop.deeplink.warm_tunnel_once'], first.child);
    operationStage = 'WARM_OPEN_DISPATCH';
    await dispatchDirect(
      application,
      profile.userData,
      WARM_OPEN,
      dispatchEnvironment,
      processGroups,
      launchContext.arguments,
    );
    operationStage = 'WARM_OPEN_EVIDENCE';
    await waitForWarmOpenEvidence(firstEvidence, first.child);
    operationStage = 'MALFORMED_DISPATCH';
    await dispatchDirect(
      application,
      profile.userData,
      'native-evidence-malformed',
      dispatchEnvironment,
      processGroups,
      launchContext.arguments,
    );
    operationStage = 'MALFORMED_EVIDENCE';
    await waitForEvents(firstEvidence, ['desktop.deeplink.rejected_malformed'], first.child);
    operationStage = 'OVERSIZED_DISPATCH';
    await dispatchDirect(
      application,
      profile.userData,
      `propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev%2F${'a'.repeat(2_100)}`,
      dispatchEnvironment,
      processGroups,
      launchContext.arguments,
    );
    operationStage = 'OVERSIZED_EVIDENCE';
    await waitForEvents(firstEvidence, ['desktop.deeplink.rejected_oversized'], first.child);
    operationStage = 'UNSAFE_SCHEME_DISPATCH';
    await dispatchDirect(
      application,
      profile.userData,
      'https://native-evidence.invalid/unsafe',
      dispatchEnvironment,
      processGroups,
      launchContext.arguments,
    );
    operationStage = 'UNSAFE_SCHEME_EVIDENCE';
    await waitForEvents(firstEvidence, ['desktop.deeplink.rejected_unsafe_scheme'], first.child);
    operationStage = 'FIRST_EXIT';
    await first.waitForSuccessfulExit();
    const requiredFirstEvents = REQUIRED_FIRST_EVENTS;
    operationStage = 'FIRST_EVIDENCE_VALIDATION';
    await waitForEvents(firstEvidence, requiredFirstEvents, { exitCode: null });
    await assertEvidenceOrdering(firstEvidence, requiredFirstEvents);
    await assertProfileAuthority(profile);

    const relaunchEnvironment = Object.freeze({
      ...launchContext.environment,
      PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE: 'relaunch',
      PROPR_DESKTOP_NATIVE_EXPECTED_ARCH: target.arch,
      PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM: target.platform,
      PROPR_DESKTOP_NATIVE_EXPECTED_VERSION: target.version,
    });
    operationStage = 'RELAUNCH';
    const relaunch = startApplication(application, [
      ...launchContext.arguments,
      '--propr-smoke-test',
      `--user-data-dir=${profile.userData}`,
      COLD_TUNNEL,
    ], relaunchEnvironment, workRoot, processGroups);
    operationStage = 'RELAUNCH_EXIT';
    await relaunch.waitForSuccessfulExit();
    const relaunchEvidence = join(profile.userData, 'application.smoke-evidence.relaunch.jsonl');
    operationStage = 'RELAUNCH_EVIDENCE';
    await waitForEvents(
      relaunchEvidence,
      REQUIRED_RELAUNCH_EVENTS,
      { exitCode: null },
    );
    await assertEvidenceOrdering(relaunchEvidence, REQUIRED_RELAUNCH_EVENTS);
    await assertProfileAuthority(profile);
    if (target.platform === 'darwin') {
      operationStage = 'FINAL_DARWIN_SIGNATURE_VALIDATION';
      await verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application: application.applicationRoot,
        expectedCertificateSha1: process.env.PROPR_DESKTOP_NATIVE_SIGNING_CERTIFICATE_SHA1,
        proofPath: darwinSignatureProof,
        keychain: process.env.PROPR_DESKTOP_NATIVE_SIGNING_KEYCHAIN,
      });
    }
    operationStage = 'FINAL_VALIDATION';
    if (await digest(artifact) !== beforeDigest) throw new Error('Native lifecycle mutated the staged artifact bytes');
    await assertDefaultUserDataUntouched(target);
    report.push({
      coldDispatch: 'direct-argv (not OS protocol launch)',
      kind,
      lifecycle: 'extract-or-mount-copy/launch/shutdown/relaunch/remove',
      protocol,
      secureStorage: target.platform === 'linux'
        ? 'isolated gnome-libsecret round-trip and deletion'
        : 'OS-protected Keychain round-trip and deletion',
    });
  } catch (error) {
    primaryError = error instanceof NativeLifecycleOperationFailure ? error : new NativeLifecycleOperationFailure(
      operationStage,
      errorFrom(error, 'Native lifecycle operation failed'),
      evidenceClassification,
    );
  }

  const cleanupFailures = await processGroups.cleanup();
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push({ label, error: errorFrom(error, 'Native lifecycle cleanup failed') });
    }
  };
  if (profileApi) await cleanup('profile-api', () => closeProfileApi(profileApi));
  if (mountAuthority?.mounted) await cleanup('dmg-mount', () => mountAuthority.detach());
  if (processGroupAbsenceWasProved(cleanupFailures) && sandboxPrepared && application) {
    await cleanup('linux-sandbox', () => run('/usr/bin/sudo', [
      '/bin/rm', '-f', join(application.applicationRoot, 'chrome-sandbox'),
    ]));
  }
  if (!mountAuthority?.mounted) {
    await cleanup('mount-root', () => rm(mountRoot, { recursive: true, force: true }));
    await cleanup('mount-postcondition', () => assertAbsent(mountRoot, 'Native DMG mount root remained after detach'));
  }
  if (profile) {
    await cleanup('profile-authority', () => removeAuthorizedProfile(profile));
  }
  const finalCleanupFailures = await removeLifecycleRootsWithAuthority({
    cleanupFailures,
    installRoot,
    launchServices,
    workRoot,
  });
  throwCombined(primaryError, finalCleanupFailures);
};

export const runNativeArtifactLifecycle = async target => {
  if (hostPlatform() !== target.platform || hostArch() !== target.arch) {
    throw new Error(`Native lifecycle requires ${target.platform}-${target.arch}, got ${hostPlatform()}-${hostArch()}`);
  }
  const kinds = await assertArtifactSet(target);
  const report = [];
  for (const kind of kinds) {
    const artifact = canonicalArtifact({ directory: target.artifactDirectory, ...target, kind });
    await lifecycleForArtifact({ target, kind, artifact, report });
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    target: `${target.platform}-${target.arch}`,
    evidence: report,
    limitations: target.platform === 'linux'
      ? 'Cold launch is direct argv. ZIP warm dispatch is direct. Package warm dispatch uses isolated XDG/GIO. Secure storage uses one isolated gnome-libsecret session.'
      : 'Cold launch is direct argv. Warm protocol evidence uses local LaunchServices. Unsigned internal-RC evidence does not claim signing, notarization, or Gatekeeper assessment.',
  }));
};

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await runNativeArtifactLifecycle(parseArguments(process.argv.slice(2)));
