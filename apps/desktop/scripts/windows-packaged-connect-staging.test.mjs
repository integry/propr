import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPackagedWindowsPeArchitecture,
  assertWindowsStagedPackagePreflightResult,
  classifyWindowsArtifactFailure,
  describeWindowsArtifactFailure,
  packagedConnectArtifactSensitiveNeedles,
  parseWindowsStagedPackageContract,
  parseWindowsStagedPackageHandoff,
  validateWindowsStagedPackage,
  WINDOWS_ARTIFACT_FAILURE_CATEGORIES,
  WINDOWS_ARTIFACT_FAILURE_PHASES,
  WINDOWS_ARTIFACT_FAILURE_SUBPHASES,
  WINDOWS_ORDINARY_USER_PREFLIGHT_FAILURE_SUBPHASES,
  WINDOWS_STAGED_CONTRACT_FAILURE_SUBPHASES,
  WindowsArtifactFailure,
} from './windows-packaged-connect-staging.mjs';
import { windowsPowerShell51Path } from './windows-fixture-acl.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;
const orchestratorPath = fileURLToPath(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url));
const taskkillPath = String.raw`C:\Windows\System32\taskkill.exe`;
const hostPreflightSubphases = Object.freeze([
  'host-node-command-cardinality',
  'host-node-command-type',
  'host-node-source',
  'host-node-path-binding',
  'host-node-launcher-return-authority',
  'host-capture-contract',
  'host-staging-handoff',
]);
const launcherAuthoritySubphases = Object.freeze([
  'host-launcher-native-initialization',
  'host-launcher-selected-path-input',
  'host-launcher-selected-path-extra-colon',
  'host-launcher-selected-path-get-full-path',
  'host-launcher-selected-path-absolute-shape',
  'host-launcher-selected-path-canonical-equality',
  'host-launcher-source-open',
  'host-launcher-source-type',
  'host-launcher-source-identity',
  'host-launcher-source-final-path',
  'host-launcher-final-open',
  'host-launcher-final-type',
  'host-launcher-final-identity',
  'host-launcher-final-path',
  'host-launcher-final-match',
  'host-launcher-source-reopen',
  'host-launcher-source-reopen-type',
  'host-launcher-source-reopen-identity',
  'host-launcher-source-reopen-final-path',
  'host-launcher-source-reopen-match',
]);
const fixedHostDiagnosticSubphases = Object.freeze([
  ...hostPreflightSubphases,
  ...launcherAuthoritySubphases,
]);
const launcherInvocationSubphases = Object.freeze([
  'host-node-path-binding',
  ...launcherAuthoritySubphases,
]);
const positiveHostNodeProducerSubphases = Object.freeze([
  'host-node-command-cardinality',
  'host-node-command-type',
  'host-node-source',
]);
const captureRedirectionFailurePredicates = Object.freeze([
  'pre-create',
  'redirect-open',
  'redirect-timeout',
  'redirect-child-exit',
  'post-redirection-identity',
  'capture-owner',
  'dacl-canonicality',
  'unauthorized-writer',
  'link-path-type',
  'identity-replacement',
  'capture-content',
  'cleanup',
]);
const captureRedirectionReportedPredicates = Object.freeze([
  ...captureRedirectionFailurePredicates,
  'diagnostic-contract',
]);
const captureProducerExitBuckets = Object.freeze(['zero', 'forced-23', 'other']);
const captureProducerOutputStates = Object.freeze(['exact-expected', 'empty', 'other-bounded']);
const captureRedirectionResultPredicates = Object.freeze([
  'redirect-child-exit',
  'capture-content',
]);
const captureRedirectionDiagnosticPattern = new RegExp(
  '^PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
    + ':phase=capture-parse:subphase=capture-authority'
    + ':predicate=([a-z-]+):cleanup=none\\r?\\n$',
  'u',
);
const captureRedirectionResultDiagnosticPattern = new RegExp(
  '^PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
    + ':phase=capture-parse:subphase=capture-authority'
    + ':predicate=([a-z-]+):exit=([a-z0-9-]+)'
    + ':out=([a-z-]+):err=([a-z-]+):cleanup=none\\r?\\n$',
  'u',
);
const captureRedirectionAcceptedPattern =
  /^PROPR_WINDOWS_PACKAGED_CONNECT_CAPTURE_REDIRECTION_TEST:accepted\r?\n$/u;
const hostileDiagnosticPattern = /[A-Z]:\\|\\\\|S-1-5-|account-name|username|stdout|stderr|exception|native-text|command-line|sddl|exit-code|environment-secret/iu;
const uppercasePathDiagnosticPattern = /\bPATH\b/u;
const hasHostileDiagnosticEvidence = value => hostileDiagnosticPattern.test(value)
  || uppercasePathDiagnosticPattern.test(value);
const assertNoHostileDiagnosticEvidence = value => {
  assert.doesNotMatch(value, hostileDiagnosticPattern);
  assert.doesNotMatch(value, uppercasePathDiagnosticPattern);
};

const parent = String.raw`C:\runner-temp\propr-connect-packaged-stage`;
const leaf = 'propr-connect-package-0123456789abcdef0123456789abcdef';
const environment = {
  RUNNER_TEMP: String.raw`C:\runner-temp`,
  PROPR_DESKTOP_CONNECT_STAGING_PARENT: parent,
  PROPR_DESKTOP_CONNECT_STAGING_LEAF: leaf,
};
const handoffFor = ({
  RUNNER_TEMP = environment.RUNNER_TEMP,
  PROPR_DESKTOP_CONNECT_STAGING_PARENT = environment.PROPR_DESKTOP_CONNECT_STAGING_PARENT,
  PROPR_DESKTOP_CONNECT_STAGING_LEAF = environment.PROPR_DESKTOP_CONNECT_STAGING_LEAF,
} = {}) => '--propr-windows-staged-contract=' + Buffer.from([
  RUNNER_TEMP,
  PROPR_DESKTOP_CONNECT_STAGING_PARENT,
  PROPR_DESKTOP_CONNECT_STAGING_LEAF,
].join('\n'), 'utf8').toString('base64');
const regularFile = {
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const regularDirectory = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};

const peFixture = architecture => {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 0x84);
  return bytes;
};

const processExists = processId => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const waitForProcessExit = async (processId, timeoutMilliseconds = 5_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processExists(processId);
};

const startNativeNodeTree = async () => {
  const rootSource = String.raw`
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});
process.stdout.write(String(descendant.pid) + '\n');
setInterval(() => {}, 1000);
`;
  const root = spawn(process.execPath, ['-e', rootSource], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantProcessId = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('native process tree did not start')), 5_000);
    root.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    root.stdout.on('data', chunk => {
      output += chunk.toString('ascii');
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      const value = output.slice(0, newline).trim();
      if (!/^[1-9][0-9]{0,9}$/u.test(value)) reject(new Error('native descendant pid was invalid'));
      else resolve(Number(value));
    });
  });
  return { root, descendantProcessId };
};

const terminateTreeAfterTest = processId => {
  if (!Number.isSafeInteger(processId) || processId < 1 || !processExists(processId)) return;
  spawnSync(taskkillPath, ['/PID', String(processId), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
    timeout: 5_000,
  });
};

const runLauncherAuthorityTest = (path, testCase = 'normal', retargetPath) => {
  const arguments_ = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    orchestratorPath,
    '-Architecture',
    process.arch,
    '-LifecycleTestMode',
    'launcher-authority',
    '-LauncherAuthorityTestCase',
    testCase,
    '-LauncherAuthorityTestPath',
    path,
  ];
  if (retargetPath !== undefined) {
    arguments_.push('-LauncherAuthorityTestRetargetPath', retargetPath);
  }
  return spawnSync(windowsPowerShell51Path(), arguments_, {
    shell: false,
    windowsHide: true,
    timeout: 15_000,
  });
};

const runHostNodeProducerTest = testCase => spawnSync(windowsPowerShell51Path(), [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-File',
  orchestratorPath,
  '-Architecture',
  process.arch,
  '-LifecycleTestMode',
  'host-node-producer',
  '-HostNodeProducerTestCase',
  testCase,
], {
  shell: false,
  windowsHide: true,
  timeout: 10_000,
});

const runCaptureParserTest = (
  path,
  authorityCase = 'existing',
  environmentOverrides = {},
) => spawnSync(windowsPowerShell51Path(), [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-File', orchestratorPath,
  '-Architecture', process.arch,
  '-LifecycleTestMode', 'capture-parser',
  '-CaptureParserTestPath', path,
  '-CaptureParserAuthorityTestCase', authorityCase,
], {
  shell: false,
  windowsHide: true,
  timeout: 10_000,
  env: { ...process.env, ...environmentOverrides },
});

const runCaptureRedirectionTest = (producerTestCase = 'success') => spawnSync(windowsPowerShell51Path(), [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-File', orchestratorPath,
  '-Architecture', process.arch,
  '-LifecycleTestMode', 'capture-redirection',
  '-CaptureRedirectionProducerTestCase', producerTestCase,
], {
  shell: false,
  windowsHide: true,
  timeout: 45_000,
});

const failCaptureRedirectionTest = result => {
  let evidence = 'predicate=diagnostic-contract';
  if (!result.error && result.signal === null && result.status === 1
      && Buffer.isBuffer(result.stdout) && result.stdout.length === 0
      && Buffer.isBuffer(result.stderr) && result.stderr.length <= 256) {
    const diagnostic = result.stderr.toString('utf8');
    const resultMatch = captureRedirectionResultDiagnosticPattern.exec(diagnostic);
    const predicateMatch = captureRedirectionDiagnosticPattern.exec(diagnostic);
    if (resultMatch
        && captureRedirectionResultPredicates.includes(resultMatch[1])
        && captureProducerExitBuckets.includes(resultMatch[2])
        && captureProducerOutputStates.includes(resultMatch[3])
        && captureProducerOutputStates.includes(resultMatch[4])
        && !hasHostileDiagnosticEvidence(diagnostic)) {
      evidence = `predicate=${resultMatch[1]}:exit=${resultMatch[2]}`
        + `:out=${resultMatch[3]}:err=${resultMatch[4]}`;
    } else if (predicateMatch
        && captureRedirectionFailurePredicates.includes(predicateMatch[1])
        && !captureRedirectionResultPredicates.includes(predicateMatch[1])
        && !hasHostileDiagnosticEvidence(diagnostic)) {
      evidence = `predicate=${predicateMatch[1]}`;
    }
  }
  assert.ok(captureRedirectionReportedPredicates.includes(evidence.slice('predicate='.length).split(':')[0]));
  const error = new Error(
    `PROPR_WINDOWS_PACKAGED_CONNECT_CAPTURE_REDIRECTION_TEST:failed:${evidence}`,
  );
  error.stack = error.message;
  throw error;
};

test('capture redirection mismatch reporting is total and redacted for each launch predicate', () => {
  const resultFor = stderr => ({
    error: undefined,
    signal: null,
    status: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
  });
  const assertDiagnosticContract = (result, label) => assert.throws(
    () => failCaptureRedirectionTest(result),
    error => error.message === 'PROPR_WINDOWS_PACKAGED_CONNECT_CAPTURE_REDIRECTION_TEST'
      + ':failed:predicate=diagnostic-contract'
      && error.stack === error.message
      && !hasHostileDiagnosticEvidence(error.message),
    label,
  );
  for (const predicate of ['redirect-open', 'redirect-timeout']) {
    const diagnostic = 'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + `:predicate=${predicate}:cleanup=none\r\n`;
    assert.throws(
      () => failCaptureRedirectionTest(resultFor(diagnostic)),
      error => error.message === 'PROPR_WINDOWS_PACKAGED_CONNECT_CAPTURE_REDIRECTION_TEST'
        + `:failed:predicate=${predicate}`
        && error.stack === error.message
        && !hasHostileDiagnosticEvidence(error.message),
      predicate,
    );

    assertDiagnosticContract(resultFor(
      diagnostic + String.raw`C:\hostile\capture S-1-5-21 account-name username stdout stderr exception native-text command-line sddl exit-code environment-secret`,
    ), `${predicate}-hostile-output`);

    assertDiagnosticContract({
      error: new Error(String.raw`C:\hostile\exception`),
      signal: 'hostile-signal',
      status: null,
      stdout: Buffer.from('environment-secret'),
      stderr: Buffer.from(diagnostic),
    }, `${predicate}-totality`);
  }

  for (const [predicate, exit, out, err] of [
    ['redirect-child-exit', 'zero', 'exact-expected', 'exact-expected'],
    ['redirect-child-exit', 'forced-23', 'empty', 'other-bounded'],
    ['capture-content', 'other', 'other-bounded', 'empty'],
  ]) {
    const diagnostic = 'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + `:predicate=${predicate}:exit=${exit}:out=${out}:err=${err}:cleanup=none\r\n`;
    assert.throws(
      () => failCaptureRedirectionTest(resultFor(diagnostic)),
      error => error.message === 'PROPR_WINDOWS_PACKAGED_CONNECT_CAPTURE_REDIRECTION_TEST'
        + `:failed:predicate=${predicate}:exit=${exit}:out=${out}:err=${err}`
        && error.stack === error.message
        && !hasHostileDiagnosticEvidence(error.message),
      `${predicate}-${exit}-${out}-${err}`,
    );
    assertDiagnosticContract(resultFor(
      diagnostic + String.raw`C:\hostile\capture S-1-5-21 environment-secret`,
    ), `${predicate}-hostile-output`);
  }

  for (const diagnostic of [
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + ':predicate=redirect-child-exit:cleanup=none\r\n',
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + ':predicate=redirect-child-exit:exit=23:out=exact-expected:err=exact-expected'
      + ':cleanup=none\r\n',
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + ':predicate=redirect-child-exit:exit=other:out=raw-value:err=empty'
      + ':cleanup=none\r\n',
  ]) assertDiagnosticContract(resultFor(diagnostic), 'result-attribution-totality');
});

const assertLauncherAuthorityRejected = (result, category, subphase) => {
  const expected = `PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=${category}`
    + `:phase=ordinary-user-preflight:subphase=${subphase}:cleanup=none`;
  const diagnostic = Buffer.isBuffer(result.stderr)
    && result.stderr.length <= 512 ? result.stderr.toString('utf8').trim() : '';
  if (result.error || result.signal !== null || result.status !== 1
      || !Buffer.isBuffer(result.stdout) || result.stdout.length !== 0
      || diagnostic !== expected || hasHostileDiagnosticEvidence(diagnostic)) {
    const error = new Error(
      `PROPR_WINDOWS_PACKAGED_CONNECT_LAUNCHER_AUTHORITY_TEST:rejection-diagnostic-failed`
        + `:category=${category}:phase=ordinary-user-preflight:subphase=${subphase}`,
    );
    error.stack = error.message;
    throw error;
  }
};

const failAcceptedLauncherCase = (caseName, result) => {
  const fallback = 'category=artifact-inaccessible:phase=ordinary-user-preflight:subphase=host-state-contract';
  let evidence = fallback;
  if (!result.error && result.signal === null && result.status === 1
      && Buffer.isBuffer(result.stdout) && result.stdout.length === 0
      && Buffer.isBuffer(result.stderr) && result.stderr.length <= 512) {
    const diagnostic = result.stderr.toString('utf8').trim();
    const match = /^PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=(artifact-missing|artifact-inaccessible|artifact-type|architecture-mismatch|spawn-failed):phase=(ordinary-user-preflight):subphase=([a-z-]+):cleanup=none$/u.exec(diagnostic);
    if (match && launcherInvocationSubphases.includes(match[3])
        && !hasHostileDiagnosticEvidence(diagnostic)) {
      evidence = `category=${match[1]}:phase=${match[2]}:subphase=${match[3]}`;
    }
  }
  const error = new Error(
    `PROPR_WINDOWS_PACKAGED_CONNECT_LAUNCHER_AUTHORITY_TEST:accepted-case-failed:case=${caseName}:${evidence}`,
  );
  error.stack = error.message;
  throw error;
};

const assertLauncherAuthorityAccepted = (result, caseName) => {
  if (result.error || result.signal !== null || result.status !== 0
      || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
      || result.stdout.toString('utf8').trim()
        !== 'PROPR_WINDOWS_PACKAGED_CONNECT_LAUNCHER_AUTHORITY_TEST:accepted'
      || result.stderr.length !== 0) {
    failAcceptedLauncherCase(caseName, result);
  }
};

const failPositiveHostNodeProducer = result => {
  const fallback = 'category=artifact-inaccessible:phase=ordinary-user-preflight'
    + ':subphase=host-node-command-cardinality';
  let evidence = fallback;
  if (!result.error && result.signal === null && result.status === 1
      && Buffer.isBuffer(result.stdout) && result.stdout.length === 0
      && Buffer.isBuffer(result.stderr) && result.stderr.length <= 512) {
    const diagnostic = result.stderr.toString('utf8').trim();
    const match = /^PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=(artifact-inaccessible|artifact-type):phase=(ordinary-user-preflight):subphase=([a-z-]+):cleanup=none$/u.exec(diagnostic);
    if (match && positiveHostNodeProducerSubphases.includes(match[3])
        && !hasHostileDiagnosticEvidence(diagnostic)) {
      evidence = `category=${match[1]}:phase=${match[2]}:subphase=${match[3]}`;
    }
  }
  const error = new Error(
    `PROPR_WINDOWS_PACKAGED_CONNECT_HOST_NODE_PRODUCER_TEST:positive-case-failed:${evidence}`,
  );
  error.stack = error.message;
  throw error;
};

const assertPositiveHostNodeProducer = result => {
  if (result.error || result.signal !== null || result.status !== 0
      || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
      || result.stdout.toString('utf8').trim()
        !== 'PROPR_WINDOWS_PACKAGED_CONNECT_HOST_NODE_PRODUCER_TEST:accepted'
      || result.stderr.length !== 0) {
    failPositiveHostNodeProducer(result);
  }
};

test('positive host Node producer failures expose only fixed allowlisted evidence', () => {
  for (const category of ['artifact-inaccessible', 'artifact-type']) {
    for (const subphase of positiveHostNodeProducerSubphases) {
      const result = {
        error: undefined,
        signal: null,
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(
          `PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=${category}`
            + `:phase=ordinary-user-preflight:subphase=${subphase}:cleanup=none`,
        ),
      };
      assert.throws(
        () => failPositiveHostNodeProducer(result),
        {
          message: 'PROPR_WINDOWS_PACKAGED_CONNECT_HOST_NODE_PRODUCER_TEST'
            + `:positive-case-failed:category=${category}`
            + `:phase=ordinary-user-preflight:subphase=${subphase}`,
        },
      );
    }
  }

  const fallback = 'PROPR_WINDOWS_PACKAGED_CONNECT_HOST_NODE_PRODUCER_TEST'
    + ':positive-case-failed:category=artifact-inaccessible'
    + ':phase=ordinary-user-preflight:subphase=host-node-command-cardinality';
  for (const stderr of [
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=spawn-failed'
      + ':phase=ordinary-user-preflight:subphase=host-node-source:cleanup=none',
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=application-spawn:subphase=host-node-source:cleanup=none',
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=ordinary-user-preflight:subphase=host-node-path-binding:cleanup=none',
    String.raw`C:\hostile\node.exe \\hostile PATH account-name S-1-5-21 stdout stderr exception native-text environment-secret`,
  ]) {
    assert.throws(
      () => failPositiveHostNodeProducer({
        error: undefined,
        signal: null,
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(stderr),
      }),
      { message: fallback },
    );
  }
  assertNoHostileDiagnosticEvidence(fallback);
});

test('hostile diagnostics reject uppercase PATH without matching fixed path subphases', () => {
  assert.equal(
    hasHostileDiagnosticEvidence(
      'category=artifact-type:phase=ordinary-user-preflight:subphase=host-node-path-binding',
    ),
    false,
  );
  assert.equal(hasHostileDiagnosticEvidence('PATH'), true);
});

const validationOptions = overrides => ({
  environment,
  expectedArchitecture: 'arm64',
  inspectPath: async path => path.endsWith('.exe') || path.endsWith('.asar')
    ? regularFile
    : regularDirectory,
  canonicalize: async (kind, path) => ({ path }),
  readHeader: async () => peFixture('arm64'),
  preflight: async () => {},
  ...overrides,
});

describe('packaged Windows Connect staging contract', () => {
  test('accepts only the exact generated leaf below the fixed canonical staging parent', () => {
    const contract = parseWindowsStagedPackageContract(environment);
    assert.equal(contract.parent, parent);
    assert.equal(contract.root, win32.join(parent, leaf));
    assert.equal(contract.executable, win32.join(parent, leaf, 'propr-desktop.exe'));

    for (const [invalid, subphase] of [
      [{}, 'runner-temp-input-shape'],
      [{ PROPR_DESKTOP_CONNECT_STAGED_ROOT: contract.root }, 'runner-temp-input-shape'],
      [{ ...environment, RUNNER_TEMP: 'runner-temp' }, 'runner-temp-input-shape'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: `${parent}\\` }, 'staging-parent-input-shape'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`\\server\share\propr-connect-packaged-stage` }, 'staging-parent-input-shape'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`C:\runner-temp\x\propr-connect-packaged-stage` }, 'parent-to-runner-binding'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`C:\runner-temp\other` }, 'fixed-parent-leaf'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: '../package' }, 'generated-stage-leaf'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: 'propr-connect-package-ABCDEF0123456789abcdef0123456789' }, 'generated-stage-leaf'],
      [{ ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: 'propr-connect-package-0123' }, 'generated-stage-leaf'],
    ]) {
      assert.throws(
        () => parseWindowsStagedPackageContract(invalid),
        error => error instanceof WindowsArtifactFailure
          && error.category === 'artifact-type'
          && error.phase === 'staged-contract'
          && error.subphase === subphase,
      );
    }
  });

  test('accepts one bounded parent-owned handoff and rejects every other input shape', () => {
    const contract = parseWindowsStagedPackageHandoff([handoffFor()]);
    assert.equal(contract.runnerTemp, environment.RUNNER_TEMP);
    assert.equal(contract.parent, parent);
    assert.equal(contract.leaf, leaf);
    for (const arguments_ of [
      [],
      [handoffFor(), handoffFor()],
      ['--propr-windows-staged-contract=not-base64'],
      ['--different-contract=AAAA'],
      [`--propr-windows-staged-contract=${'A'.repeat(16_388)}`],
      ['--propr-windows-staged-contract=' + Buffer.from('one\ntwo', 'utf8').toString('base64')],
    ]) {
      assert.throws(
        () => parseWindowsStagedPackageHandoff(arguments_),
        error => error instanceof WindowsArtifactFailure
          && error.category === 'artifact-type'
          && error.phase === 'staged-contract'
          && error.subphase === 'runner-temp-input-shape',
      );
    }
  });

  test('emits only fixed staged-contract predicate evidence', () => {
    const diagnostics = WINDOWS_STAGED_CONTRACT_FAILURE_SUBPHASES.map(subphase => {
      const failure = new WindowsArtifactFailure('artifact-type', 'staged-contract', subphase);
      return JSON.stringify({
        event: 'packaged_connect.artifact_failed',
        ...describeWindowsArtifactFailure(failure, 'application-spawn'),
      });
    });
    assert.deepEqual(diagnostics, WINDOWS_STAGED_CONTRACT_FAILURE_SUBPHASES.map(subphase => (
      `{"event":"packaged_connect.artifact_failed","category":"artifact-type",`
        + `"phase":"staged-contract","subphase":"${subphase}"}`
    )));
    assertNoHostileDiagnosticEvidence(diagnostics.join('\n'));

    const hostileSubphase = new WindowsArtifactFailure(
      'artifact-type',
      'staged-contract',
      String.raw`C:\secret\account-name-S-1-5-21-123`,
    );
    assert.equal(hostileSubphase.subphase, undefined);
    assert.deepEqual(describeWindowsArtifactFailure(hostileSubphase, 'staged-contract'), {
      category: 'artifact-type',
      phase: 'staged-contract',
    });
    assertNoHostileDiagnosticEvidence(hostileSubphase.message);
  });

  test('rejects missing, inaccessible, reparse, wrong-type, and noncanonical entries before preflight', async () => {
    let preflightCalls = 0;
    const assertCategory = async (inspectPath, canonicalize, category) => {
      await assert.rejects(
        validateWindowsStagedPackage(validationOptions({
          inspectPath,
          canonicalize: canonicalize ?? (async (kind, path) => ({ path })),
          preflight: async () => { preflightCalls += 1; },
        })),
        error => error instanceof WindowsArtifactFailure && error.category === category,
      );
    };
    await assertCategory(async () => { const error = new Error('sensitive path'); error.code = 'ENOENT'; throw error; }, null, 'artifact-missing');
    await assertCategory(async () => { const error = new Error('sensitive path'); error.code = 'EACCES'; throw error; }, null, 'artifact-inaccessible');
    await assertCategory(async () => ({ ...regularDirectory, isSymbolicLink: () => true }), null, 'artifact-type');
    await assertCategory(async () => regularFile, null, 'artifact-type');
    await assertCategory(
      async path => path.endsWith('.exe') || path.endsWith('.asar') ? regularFile : regularDirectory,
      async (kind, path) => ({ path: `${path}-alias` }),
      'artifact-type',
    );
    assert.equal(preflightCalls, 0, 'a rejected package must fail before the access preflight');
  });

  test('proves target PE architecture and ordinary-user access before returning the executable', async () => {
    let preflightCalls = 0;
    const result = await validateWindowsStagedPackage(validationOptions({
      preflight: async paths => {
        preflightCalls += 1;
        assert.equal(paths.executable, win32.join(parent, leaf, 'propr-desktop.exe'));
      },
    }));
    assert.equal(result.root, win32.join(parent, leaf));
    assert.equal(preflightCalls, 1);

    await assert.rejects(
      validateWindowsStagedPackage(validationOptions({ readHeader: async () => peFixture('x64') })),
      error => error instanceof WindowsArtifactFailure && error.category === 'architecture-mismatch',
    );
  });

  test('maps a hostile preflight callback throw totally and redacts all supplied evidence', async () => {
    const hostile = new Error(
      String.raw`hostile exception C:\secret\package S-1-5-21-123 account-name raw stdout raw stderr environment-secret`,
    );
    hostile.stdout = 'raw stdout';
    hostile.stderr = 'raw stderr';
    hostile.environment = { SECRET: 'environment-secret' };
    await assert.rejects(
      validateWindowsStagedPackage(validationOptions({
        preflight: async () => { throw hostile; },
      })),
      error => {
        assert.ok(error instanceof WindowsArtifactFailure);
        assert.equal(error.category, 'artifact-inaccessible');
        assert.equal(error.phase, 'ordinary-user-preflight');
        assert.equal(error.subphase, 'preflight-invocation');
        const diagnostic = JSON.stringify({
          event: 'packaged_connect.artifact_failed',
          ...describeWindowsArtifactFailure(error, 'ordinary-user-preflight'),
        });
        assert.equal(
          diagnostic,
          '{"event":"packaged_connect.artifact_failed","category":"artifact-inaccessible","phase":"ordinary-user-preflight","subphase":"preflight-invocation"}',
        );
        assertNoHostileDiagnosticEvidence(`${error.message}\n${diagnostic}`);
        return true;
      },
    );
  });

  test('keeps PE type and architecture failures distinct', () => {
    assert.doesNotThrow(() => assertPackagedWindowsPeArchitecture(peFixture('arm64'), 'arm64'));
    assert.throws(
      () => assertPackagedWindowsPeArchitecture(Buffer.from('not a PE'), 'arm64'),
      error => error.category === 'artifact-type',
    );
    assert.throws(
      () => assertPackagedWindowsPeArchitecture(peFixture('x64'), 'arm64'),
      error => error.category === 'architecture-mismatch',
    );
  });

  test('maps hostile exceptions to a fixed path-free allowlist', () => {
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_CATEGORIES, [
      'artifact-missing',
      'artifact-inaccessible',
      'artifact-type',
      'architecture-mismatch',
      'spawn-failed',
    ]);
    const hostile = new Error(String.raw`spawn C:\secret\propr-desktop.exe ENOENT --token=secret`);
    hostile.code = 'ENOENT';
    assert.equal(classifyWindowsArtifactFailure(hostile), 'artifact-missing');
    assert.equal(classifyWindowsArtifactFailure(new Error('username SID environment stack')), 'spawn-failed');
    for (const category of WINDOWS_ARTIFACT_FAILURE_CATEGORIES) {
      const failure = new WindowsArtifactFailure(category, 'staged-tree');
      assert.equal(classifyWindowsArtifactFailure(failure), category);
      assert.doesNotMatch(failure.message, /[A-Z]:\\|S-1-5-|--|username|environment|stack/iu);
    }
    const invalidSubphase = new WindowsArtifactFailure(
      'artifact-inaccessible',
      'ordinary-user-preflight',
      String.raw`C:\secret\account-name-S-1-5-21-123`,
    );
    assert.equal(invalidSubphase.subphase, undefined);
    assert.doesNotMatch(invalidSubphase.message, /[A-Z]:\\|S-1-5-|account-name/iu);
  });

  test('classifies fixed phases without collapsing pre-spawn failures into spawn', () => {
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_PHASES, [
      'staged-contract',
      'staged-tree',
      'staged-architecture',
      'ordinary-user-preflight',
      'fixture-setup',
      'package-authority',
      'application-spawn',
      'application-runtime',
      'result-verify',
    ]);
    assert.deepEqual(WINDOWS_STAGED_CONTRACT_FAILURE_SUBPHASES, [
      'runner-temp-input-shape',
      'staging-parent-input-shape',
      'parent-to-runner-binding',
      'fixed-parent-leaf',
      'generated-stage-leaf',
      'derived-root-to-parent-binding',
    ]);
    assert.deepEqual(
      describeWindowsArtifactFailure(new Error(String.raw`C:\secret\account`), 'fixture-setup'),
      { category: 'artifact-inaccessible', phase: 'fixture-setup' },
    );
    assert.deepEqual(
      describeWindowsArtifactFailure(
        new WindowsArtifactFailure(
          'artifact-type',
          'ordinary-user-preflight',
          'authority-contract',
        ),
        'application-spawn',
      ),
      {
        category: 'artifact-type',
        phase: 'ordinary-user-preflight',
        subphase: 'authority-contract',
      },
    );
    assert.deepEqual(
      describeWindowsArtifactFailure(new Error('--token secret'), 'application-spawn'),
      { category: 'spawn-failed', phase: 'application-spawn' },
    );
  });

  test('maps every preflight transport and exit result to fixed subphase evidence', () => {
    assert.deepEqual(WINDOWS_ORDINARY_USER_PREFLIGHT_FAILURE_SUBPHASES, [
      'preflight-invocation',
      'descendant-enumeration',
      'executable-read',
      'unexpected-exit',
      'authority-contract',
    ]);
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_SUBPHASES, [
      ...WINDOWS_STAGED_CONTRACT_FAILURE_SUBPHASES,
      ...WINDOWS_ORDINARY_USER_PREFLIGHT_FAILURE_SUBPHASES,
    ]);
    const clean = status => ({
      status,
      error: undefined,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    assert.doesNotThrow(() => assertWindowsStagedPackagePreflightResult(clean(0)));

    for (const [status, category, subphase] of [
      [80, 'artifact-type', 'authority-contract'],
      [81, 'artifact-type', 'authority-contract'],
      [82, 'artifact-type', 'authority-contract'],
      [83, 'artifact-inaccessible', 'descendant-enumeration'],
      [84, 'artifact-type', 'authority-contract'],
      [85, 'artifact-inaccessible', 'executable-read'],
      [1, 'artifact-inaccessible', 'unexpected-exit'],
      [86, 'artifact-inaccessible', 'unexpected-exit'],
      [null, 'artifact-inaccessible', 'unexpected-exit'],
    ]) {
      assert.throws(
        () => assertWindowsStagedPackagePreflightResult(clean(status)),
        error => error instanceof WindowsArtifactFailure
          && error.category === category
          && error.phase === 'ordinary-user-preflight'
          && error.subphase === subphase,
      );
    }

    const invocationFailures = [
      { ...clean(null), error: new Error(String.raw`C:\secret\invoke.exe`) },
      { ...clean(null), signal: 'SIGTERM' },
      { ...clean(0), stdout: Buffer.from('raw stdout account-name') },
      { ...clean(0), stderr: Buffer.from('raw stderr S-1-5-21-123') },
      { ...clean(0), stdout: 'not-a-buffer' },
      { ...clean(0), stderr: 'not-a-buffer' },
    ];
    for (const result of invocationFailures) {
      assert.throws(
        () => assertWindowsStagedPackagePreflightResult(result),
        error => error instanceof WindowsArtifactFailure
          && error.category === 'artifact-inaccessible'
          && error.phase === 'ordinary-user-preflight'
          && error.subphase === 'preflight-invocation',
      );
    }
  });

  test('preflight diagnostics exclude path, SID, account name, stdout, and stderr evidence', () => {
    const clean = status => ({
      status,
      error: undefined,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const hostileResult = {
      status: 85,
      error: new Error(String.raw`C:\runner-temp\secret\propr-desktop.exe account-name S-1-5-21-123`),
      signal: null,
      stdout: Buffer.from('raw stdout account-name'),
      stderr: Buffer.from(String.raw`raw stderr C:\secret S-1-5-21-123`),
    };
    const diagnosticFor = result => {
      try {
        assertWindowsStagedPackagePreflightResult(result);
        assert.fail('the preflight result must fail');
      } catch (error) {
        return JSON.stringify({
          event: 'packaged_connect.artifact_failed',
          ...describeWindowsArtifactFailure(error, 'ordinary-user-preflight'),
        });
      }
    };
    const diagnostics = [
      diagnosticFor(hostileResult),
      diagnosticFor(clean(83)),
      diagnosticFor(clean(85)),
      diagnosticFor(clean(86)),
      diagnosticFor(clean(84)),
    ];
    assert.deepEqual(
      diagnostics.map(diagnostic => JSON.parse(diagnostic).subphase),
      [
        'preflight-invocation',
        'descendant-enumeration',
        'executable-read',
        'unexpected-exit',
        'authority-contract',
      ],
    );
    assertNoHostileDiagnosticEvidence(diagnostics.join('\n'));
  });

  test('scopes staged-root and executable leak needles to Windows', () => {
    const options = {
      artifactRoot: String.raw`C:\runner-temp\stage\leaf`,
      binaryPath: String.raw`C:\runner-temp\stage\leaf\propr-desktop.exe`,
      stagedContract: {
        runnerTemp: String.raw`C:\runner-temp`,
        parent: String.raw`C:\runner-temp\stage`,
        leaf: 'leaf',
      },
      stagedHandoff: handoffFor(),
    };
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'darwin', ...options }), []);
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'linux', ...options }), []);
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'win32', ...options }), [
      options.artifactRoot,
      options.binaryPath,
      options.stagedContract.runnerTemp,
      options.stagedContract.parent,
      options.stagedContract.leaf,
      options.stagedHandoff,
    ]);
  });
});

test('the workflow stages before alternate credentials and the harness preflights before application spawn', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/desktop-connect-discovery-guard.yml', import.meta.url), 'utf8');
  const orchestrator = await readFile(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url), 'utf8');
  const harness = await readFile(new URL('./smoke-packaged-connect.mjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(workflow, /run-packaged-windows-connect-smoke\.ps1\s+-Architecture '\$\{\{ matrix\.arch \}\}'/u);
  assert.doesNotMatch(workflow, /Start-Process|Get-Content|New-LocalUser/u);

  const copy = orchestrator.indexOf('Copy-Item -LiteralPath $entry.FullName');
  const acl = orchestrator.indexOf('Set-StagedEntryAcl $item');
  const alternateLaunch = orchestrator.indexOf('$process = Start-Process');
  const nativeAuthorityTests = workflow.indexOf(
    'node --test apps/desktop/scripts/windows-packaged-connect-staging.test.mjs',
  );
  const packageStep = workflow.indexOf('npm run desktop:package');
  const packagedLaunch = workflow.indexOf('run-packaged-windows-connect-smoke.ps1');
  assert.ok(copy >= 0 && copy < acl && acl < alternateLaunch);
  assert.ok(nativeAuthorityTests >= 0
    && nativeAuthorityTests < packageStep
    && packageStep < packagedLaunch);
  assert.doesNotMatch(orchestrator.slice(alternateLaunch, alternateLaunch + 700), /\s-Wait(?:\s|`)/u);
  assert.match(orchestrator, /Assert-PeArchitecture \$sourceExecutable \$Architecture/u);
  assert.match(orchestrator, /Assert-PeArchitecture \$stagedExecutable \$Architecture/u);
  assert.match(orchestrator, /FileSystemRights\]::ReadAndExecute/u);
  assert.match(orchestrator, /FileSystemRights\]::FullControl/u);
  assert.match(orchestrator, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(orchestrator, /SetOwner\(\$Administrators\)/u);
  assert.match(orchestrator, /\[Diagnostics\.Process\]::new\(\)/u);
  assert.match(orchestrator, /\$taskkillExecutable = 'C:\\Windows\\System32\\taskkill\.exe'/u);
  assert.match(
    orchestrator,
    /\$taskkillStart\.Arguments = \[String\]::Join\(' ', \[string\[\]\]@\('\/PID', \$processIdText, '\/T', '\/F'\)\)/u,
  );
  assert.match(orchestrator, /\$taskkillStart\.UseShellExecute = \$false/u);
  assert.match(orchestrator, /\$processIdText -cnotmatch '\^\[1-9\]\[0-9\]\{0,9\}\$'/u);
  assert.match(orchestrator, /\$taskkillProcess\.WaitForExit\(\$terminationTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /Task\]::WaitAll\([\s\S]*?\$streamCloseTimeoutMilliseconds/u);
  assert.doesNotMatch(orchestrator, /(?:cmd(?:\.exe)?|powershell(?:\.exe)?)['"]?\s+\/c[\s\S]*?taskkill/iu);
  assert.match(orchestrator, /WaitForExit\(\$cleanupTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /if\(!\$cleanupProcess\.WaitForExit[\s\S]*?\$cleanupProcess\.Kill\(\)[\s\S]*?WaitForExit\(\$terminationTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /Remove-Item -LiteralPath \$root -Recurse/u);
  assert.doesNotMatch(orchestrator, /Remove-Item -LiteralPath \$parent -Recurse/u);
  assert.match(orchestrator, /\$createdAccount\.SID\.Value -cne \$testUserSid\.Value/u);
  assert.match(orchestrator, /\$administratorsSid\.Translate\(\[Security\.Principal\.NTAccount\]\)/u);
  assert.match(orchestrator, /\.psbase\.Invoke\('IsMember', \$ordinaryUserEntry\.Path\)/u);
  assert.doesNotMatch(orchestrator, /Get-LocalGroupMember/u);
  assert.doesNotMatch(orchestrator, /Get-Content|Write-(?:Host|Error|Verbose|Debug|Information)|GITHUB_WORKSPACE/u);
  const hostNodeProducer = orchestrator.slice(
    orchestrator.indexOf('function Get-ValidatedHostNodePath'),
    orchestrator.indexOf('function Stop-SpawnedProcess'),
  );
  const producerTransitions = [
    ['host-node-command-cardinality', 'Get-Command node.exe'],
    ['host-node-command-type', '$candidate -is [System.Management.Automation.ApplicationInfo]'],
    ['host-node-source', '@($candidate.Source)'],
  ];
  for (let index = 0; index < producerTransitions.length; index += 1) {
    const [subphase, operation] = producerTransitions[index];
    const transition = hostNodeProducer.indexOf(`Set-OrdinaryUserPreflightSubphase '${subphase}'`);
    const operationIndex = hostNodeProducer.indexOf(operation);
    const nextTransition = index + 1 < producerTransitions.length
      ? hostNodeProducer.indexOf(
        `Set-OrdinaryUserPreflightSubphase '${producerTransitions[index + 1][0]}'`,
      )
      : hostNodeProducer.length;
    assert.ok(transition >= 0 && transition < operationIndex && operationIndex < nextTransition,
      `${subphase} must cover exactly its producer operation boundary`);
  }
  assert.match(hostNodeProducer, /Get-Command node\.exe[\s\S]*?-CommandType Application[\s\S]*?-TotalCount 1[\s\S]*?-ErrorAction Stop/u);
  assert.match(hostNodeProducer, /\$commandResults\.Count -ne 1[\s\S]*?host-node-command-type[\s\S]*?\$candidate = \$commandResults\[0\][\s\S]*?System\.Management\.Automation\.ApplicationInfo/u);
  assert.match(hostNodeProducer, /\$sourceResults\.Count -ne 1[\s\S]*?\$sourceResults\[0\] -is \[string\]/u);
  assert.match(hostNodeProducer, /return \$sourceResults\[0\]/u);
  assert.doesNotMatch(hostNodeProducer, /validatedSources|StringComparison|foreach \(\$candidate in \$commandResults\)/u);
  assert.doesNotMatch(hostNodeProducer, /PSObject\.Properties\['Source'\]/u);
  assert.doesNotMatch(hostNodeProducer, /\$env:PATH|Select-Object\s+-First|where(?:\.exe)?/iu);
  assert.doesNotMatch(orchestrator, /\$node\s*=\s*['"]node(?:\.exe)?['"]/iu);
  const hostBoundary = orchestrator.slice(
    orchestrator.indexOf('$node = Get-ValidatedHostNodePath', orchestrator.indexOf("Set-FailurePhase 'staging-acl'")),
    orchestrator.indexOf("Set-FailurePhase 'application-spawn'"),
  );
  const hostTransitions = [
    ['host-node-path-binding', '$launcherAuthority = Get-TrustedHostLauncher -Path $node'],
    ['host-node-launcher-return-authority', '$launcherAuthorityResults = @($launcherAuthority)'],
    ['host-capture-contract', '$stdout = Join-Path $authenticatedRunnerTemp'],
    ['host-staging-handoff', '$handoffText = [String]::Join'],
  ];
  for (let index = 0; index < hostTransitions.length; index += 1) {
    const [subphase, operation] = hostTransitions[index];
    const transition = hostBoundary.indexOf(`Set-OrdinaryUserPreflightSubphase '${subphase}'`);
    const operationIndex = hostBoundary.indexOf(operation);
    const nextTransition = index + 1 < hostTransitions.length
      ? hostBoundary.indexOf(`Set-OrdinaryUserPreflightSubphase '${hostTransitions[index + 1][0]}'`)
      : hostBoundary.length;
    assert.ok(transition >= 0 && transition < operationIndex && operationIndex < nextTransition,
      `${subphase} must cover exactly its host operation boundary`);
  }
  assert.match(orchestrator, /function Set-PrimaryFailureFromException[\s\S]*?\$script:primaryPhase = \$failurePhase[\s\S]*?\$script:primarySubphase = if \(\$failureSubphases -ccontains \$failureSubphase\)/u);
  assert.match(orchestrator, /function Get-TrustedHostLauncher[\s\S]*?GetFinalPath\(\$sourceHandle\)[\s\S]*?Open\(\$finalPath, \$true\)[\s\S]*?GetIdentity\(\$authorityHandle\)[\s\S]*?Open\(\$selectedPath, \$false\)/u);
  assert.doesNotMatch(hostBoundary, /Get-TrustedHostLauncher \$node/u);
  assert.match(orchestrator, /\$node = \$launcherPathProperty\.Value[\s\S]*?-FilePath \$node/u);
  assert.match(hostBoundary, /SafeFileHandle[\s\S]*?\.IsInvalid[\s\S]*?\.IsClosed/u);
  assert.match(orchestrator, /Start-Process[\s\S]*?finally \{\s*\$launcherAuthority\.Handle\.Dispose\(\)/u);
  assert.match(orchestrator, /\$handoffArgument = '--propr-windows-staged-contract=' \+ \[Convert\]::ToBase64String\(\$handoffBytes\)/u);
  assert.match(orchestrator, /-ArgumentList @\('scripts\/smoke-packaged-connect\.mjs', \$handoffArgument\)[\s\S]*?-Credential \$credential[\s\S]*?-LoadUserProfile/u);
  assert.doesNotMatch(orchestrator, /SetEnvironmentVariable\('PROPR_DESKTOP_CONNECT_STAGING_/u);
  assert.match(orchestrator, /FILE_FLAG_OPEN_REPARSE_POINT/u);
  assert.match(
    orchestrator,
    /\[DllImport\("kernel32\.dll", CharSet = CharSet\.Unicode, ExactSpelling = true, SetLastError = true\)\]\s*private static extern SafeFileHandle CreateFileW/u,
  );
  assert.match(
    orchestrator,
    /\[DllImport\("kernel32\.dll", CharSet = CharSet\.Unicode, ExactSpelling = true, SetLastError = true\)\]\s*private static extern uint GetFinalPathNameByHandleW/u,
  );
  assert.match(orchestrator, /FILE_ID_INFO[\s\S]*?GetFileInformationByHandleEx[\s\S]*?FileIdInfo = 18/u);
  assert.match(orchestrator, /FILE_SHARE_READ\s*\n\s*: FILE_SHARE_READ \| FILE_SHARE_WRITE \| FILE_SHARE_DELETE/u);
  assert.match(orchestrator, /\$Path\.Length -gt 259[\s\S]*?\[\\x00-\\x1f\\x7f\]/u);
  const selectedPathValidation = orchestrator.slice(
    orchestrator.indexOf('function Get-BoundedAbsoluteWindowsPath'),
    orchestrator.indexOf('function ConvertFrom-NativeFinalPath'),
  );
  const selectedPathPredicateTransitions = [
    ['host-launcher-selected-path-input', '[String]::IsNullOrEmpty($Path)'],
    ['host-launcher-selected-path-extra-colon', "$Path.Substring(2).Contains(':')"],
    ['host-launcher-selected-path-get-full-path', '$fullPath = [IO.Path]::GetFullPath($Path)'],
    ['host-launcher-selected-path-absolute-shape', "$driveAbsolute = $fullPath -cmatch '^[A-Za-z]:\\\\'"],
    ['host-launcher-selected-path-canonical-equality', '[String]::Equals($fullPath, $Path'],
  ];
  let previousSelectedPathPredicate = -1;
  for (const [subphase, predicate] of selectedPathPredicateTransitions) {
    const transition = selectedPathValidation.indexOf(
      `Set-OrdinaryUserPreflightSubphase '${subphase}'`,
    );
    const predicateIndex = selectedPathValidation.indexOf(predicate);
    assert.ok(previousSelectedPathPredicate < transition && transition < predicateIndex,
      `${subphase} must identify only its selected-path predicate`);
    previousSelectedPathPredicate = predicateIndex;
  }
  assert.match(orchestrator, /function Get-CanonicalItem[\s\S]*?FileAttributes\]::ReparsePoint/u);
  assert.match(orchestrator, /function Assert-PackageTreeTypes[\s\S]*?FileAttributes\]::ReparsePoint/u);
  const captureAuthority = orchestrator.slice(
    orchestrator.indexOf('function Assert-CaptureAuthorityAcl'),
    orchestrator.indexOf('function Read-PackagedConnectSmokeFailure'),
  );
  const captureParser = orchestrator.slice(
    orchestrator.indexOf('function Read-PackagedConnectSmokeFailure'),
    orchestrator.indexOf('$hostLauncherNativeSource'),
  );
  assert.match(captureParser, /packaged_connect\.artifact_failed/u);
  assert.match(captureParser, /packaged_connect\.smoke_failed/u);
  assert.doesNotMatch(captureParser, /packaged_connect\.child_failed/u);
  const nestedDiagnosticEvents = captureParser.slice(
    captureParser.indexOf('$diagnosticEvents = @('),
    captureParser.indexOf('$diagnosticCodes = @('),
  );
  assert.match(nestedDiagnosticEvents, /'desktop\.renderer\.connect_discovery\.proof'/u);
  assert.equal(
    (orchestrator.match(/desktop\.renderer\.connect_discovery\.proof/gu) ?? []).length,
    1,
  );
  assert.match(captureParser, /Test-UniqueJsonPropertyNames \$jsonLine/u);
  assert.match(captureParser, /\[Text\.UTF8Encoding\]::new\(\$false, \$true\)/u);
  assert.match(captureAuthority, /\$captureLength -lt 1 -or \$captureLength -gt 65536/u);
  assert.match(captureParser, /\$diagnosticRecords\.Count -gt 20/u);
  assert.match(captureAuthority, /\$ownerValues -cnotcontains \$owner\.Value/u);
  assert.match(captureAuthority, /\$acl\.AreAccessRulesProtected/u);
  assert.match(captureAuthority, /\$acl\.AreAccessRulesCanonical/u);
  assert.match(captureAuthority, /\$authorizedWriters\.Contains\(\$rule\.IdentityReference\.Value\)/u);
  assert.match(captureAuthority, /function Initialize-PrivilegedCaptureFile/u);
  assert.match(captureAuthority, /GetSecurityDescriptorSddlForm\(\$sections\)/u);
  assert.match(
    captureAuthority,
    /SecurityDescriptor = \(Get-CaptureAuthorityDescriptor \$Path\)[\s\S]*?Get-CaptureAuthorityDescriptor \$Authority\.Path\) -cne \$Authority\.SecurityDescriptor/u,
  );
  assert.match(captureAuthority, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(captureAuthority, /SetOwner\(\$CapturePrivilegedSid\)/u);
  assert.match(
    captureAuthority,
    /foreach \(\$identity in @\(\$CapturePrivilegedSid, \$administratorsSid, \$systemSid\)\)/u,
  );
  assert.match(
    captureAuthority,
    /\[IO\.FileStream\]::new\([\s\S]*?FileMode\]::CreateNew[\s\S]*?\$captureAcl/u,
  );
  assert.doesNotMatch(captureAuthority, /S-1-1-0|S-1-5-11|S-1-5-32-545/u);
  assert.match(captureAuthority, /GetLinkCount\(\$captureHandle\) -ne 1/u);
  assert.match(captureAuthority, /GetIdentity\(\$captureHandle\)[\s\S]*?GetIdentity\(\$captureReopenHandle\)/u);
  assert.match(captureAuthority, /ReadBounded\(\$captureReopenHandle, 65536\)/u);
  assert.doesNotMatch(captureAuthority, /ReadAllBytes\(\$Path\)/u);
  assert.match(
    captureAuthority,
    /\$privilegedSid\.Value, \$administratorsSid\.Value, 'S-1-5-18'[\s\S]*?-cnotcontains \$parentOwner\.Value[\s\S]*?\$TestOnlyExpectedParentOwnerSid[\s\S]*?\$parentOwner\.Value -cne \$TestOnlyExpectedParentOwnerSid\.Value/u,
  );
  const topLevelParameters = orchestrator.slice(0, orchestrator.indexOf('$ErrorActionPreference'));
  assert.doesNotMatch(topLevelParameters, /TestOnlyExpectedParentOwnerSid/u);
  const captureParserTestMode = orchestrator.slice(
    orchestrator.indexOf("if ($LifecycleTestMode -eq 'capture-parser')"),
    orchestrator.indexOf("if ($LifecycleTestMode -eq 'diagnostic-subphase')"),
  );
  assert.match(
    captureParserTestMode,
    /foreign-parent-owner'[\s\S]*?\$captureExpectedParentOwnerSid = \[Security\.Principal\.SecurityIdentifier\]::new\([\s\S]*?-TestOnlyExpectedParentOwnerSid \$captureExpectedParentOwnerSid/u,
  );
  assert.doesNotMatch(
    captureParserTestMode,
    /\[IO\.Directory\]::SetAccessControl\(\$authenticatedRunnerTemp|\$parentAcl\.SetOwner/u,
  );
  const captureReadOpen = orchestrator.slice(
    orchestrator.indexOf('public static SafeFileHandle OpenCapture'),
    orchestrator.indexOf('public static SafeFileHandle OpenRedirectCaptureAuthority'),
  );
  assert.match(
    captureReadOpen,
    /lockAuthority\s*\? FILE_SHARE_READ\s*:\s*FILE_SHARE_READ \| FILE_SHARE_WRITE \| FILE_SHARE_DELETE/u,
  );
  assert.match(captureReadOpen, /GENERIC_READ \| READ_CONTROL/u);
  const redirectCaptureAuthorityOpen = orchestrator.slice(
    orchestrator.indexOf('public static SafeFileHandle OpenRedirectCaptureAuthority'),
    orchestrator.indexOf('public static string GetIdentity'),
  );
  assert.match(
    redirectCaptureAuthorityOpen,
    /FILE_READ_ATTRIBUTES \| READ_CONTROL,[\s\S]*?FILE_SHARE_READ \| FILE_SHARE_WRITE,[\s\S]*?OPEN_EXISTING/u,
  );
  assert.doesNotMatch(redirectCaptureAuthorityOpen, /GENERIC_READ/u);
  assert.match(orchestrator, /public static uint GetLinkCount/u);
  assert.match(
    orchestrator,
    /Initialize-PrivilegedCaptureFile \$stdout \$privilegedSid[\s\S]*?Initialize-PrivilegedCaptureFile \$stderr \$privilegedSid[\s\S]*?Start-Process/u,
  );
  assert.match(
    orchestrator,
    /Start-Process[\s\S]*?Assert-PrivilegedCaptureIdentity \$stdoutAuthority \$privilegedSid[\s\S]*?Assert-PrivilegedCaptureIdentity \$stderrAuthority \$privilegedSid/u,
  );
  const captureRedirectionTestMode = orchestrator.slice(
    orchestrator.indexOf("if ($LifecycleTestMode -eq 'capture-redirection')"),
    orchestrator.indexOf("if ($LifecycleTestMode -eq 'capture-parser')"),
  );
  const captureProducerOutputClassifier = orchestrator.slice(
    orchestrator.indexOf('function Get-TestOnlyCaptureProducerOutputState'),
    orchestrator.indexOf('function Set-LifecycleFailureSubphase'),
  );
  assert.match(
    captureProducerOutputClassifier,
    /\$captureReadHandle = \[ProprHostLauncherNative\]::OpenCapture\(\$Authority\.Path, \$true\)/u,
  );
  assert.doesNotMatch(
    captureProducerOutputClassifier,
    /(?:GetLength|ReadBounded)\(\s*\$Authority\.Handle/u,
  );
  assert.match(
    captureProducerOutputClassifier,
    /\$maximumAttributedBytes = 256[\s\S]*?GetLength\(\$captureReadHandle\)[\s\S]*?\$length -le \$maximumAttributedBytes[\s\S]*?ReadBounded\(\s*\$captureReadHandle, \$maximumAttributedBytes\s*\)/u,
  );
  assert.equal(
    (captureProducerOutputClassifier.match(/GetIdentity\(\$Authority\.Handle\)/gu) ?? []).length,
    2,
    'the retained non-readable authority identity must be unchanged across classification',
  );
  assert.equal(
    (captureProducerOutputClassifier.match(/Assert-PrivilegedCaptureFile/gu) ?? []).length,
    2,
    'the temporary read handle must be exact-bound before and after classification',
  );
  assert.match(
    captureProducerOutputClassifier,
    /Assert-PrivilegedCaptureFile[\s\S]*?\$Authority\.Identity[\s\S]*?Get-CaptureAuthorityDescriptor \$Authority\.Path\) -cne[\s\S]*?\$Authority\.SecurityDescriptor[\s\S]*?ReadBounded[\s\S]*?Assert-PrivilegedCaptureFile[\s\S]*?GetIdentity\(\$Authority\.Handle\)[\s\S]*?\$Authority\.SecurityDescriptor/u,
  );
  assert.match(
    captureProducerOutputClassifier,
    /finally \{\s*if \(\$null -ne \$captureReadHandle\) \{\s*try \{ \$captureReadHandle\.Dispose\(\) \} catch \{\}\s*\}\s*\}/u,
  );
  for (const predicate of [
    'pre-create',
    'redirect-open',
    'redirect-timeout',
    'redirect-child-exit',
    'capture-content',
    'cleanup',
  ]) {
    assert.match(
      captureRedirectionTestMode,
      new RegExp(`Set-CaptureAuthorityPredicate '${predicate}'`, 'u'),
    );
  }
  assert.match(
    captureRedirectionTestMode,
    /Set-CaptureAuthorityPredicate 'redirect-open'[\s\S]*?Start-Process[\s\S]*?!\(\$redirectionProcess -is \[System\.Diagnostics\.Process\]\)/u,
  );
  assert.match(
    captureRedirectionTestMode,
    /CaptureRedirectionProducerTestCase -ceq 'nonzero'[\s\S]*?\{ 23 \}[\s\S]*?\$captureProducerSource = if[\s\S]*?capture-stdout[\s\S]*?capture-stderr[\s\S]*?exit \$captureProducerExitCode[\s\S]*?\[Text\.Encoding\]::Unicode\.GetBytes\(\$captureProducerSource\)/u,
  );
  assert.match(
    captureRedirectionTestMode,
    /\$captureProducerArguments = \(\s*'-NoLogo -NoProfile -NonInteractive -EncodedCommand "' \+\s*\$captureProducerArgument \+ '"'\s*\)\s*\$redirectionProcess = Start-Process[\s\S]*?-ArgumentList \$captureProducerArguments/u,
  );
  assert.doesNotMatch(captureRedirectionTestMode, /-ArgumentList @\(|StartInfo\.Arguments/u);
  assert.match(
    captureRedirectionTestMode,
    /\$redirectionProcessHandle = \$redirectionProcess\.Handle[\s\S]*?Set-CaptureAuthorityPredicate 'redirect-timeout'[\s\S]*?WaitForExit\(\$terminationTimeoutMilliseconds\)[\s\S]*?Assert-PrivilegedCaptureIdentity[\s\S]*?Assert-PrivilegedCaptureIdentity[\s\S]*?Get-TestOnlyCaptureProducerOutputState/u,
  );
  assert.match(
    captureRedirectionTestMode,
    /Get-TestOnlyCaptureProducerOutputState\s*`\s*\$stdoutAuthority \$privilegedSid 'capture-stdout'[\s\S]*?Get-TestOnlyCaptureProducerOutputState\s*`\s*\$stderrAuthority \$privilegedSid 'capture-stderr'/u,
  );
  assert.match(
    captureRedirectionTestMode,
    /CaptureRedirectionProducerTestCase -cne 'success' -or\s*\$captureProducerExitBucket -cne 'zero'[\s\S]*?\$captureProducerStdoutState -cne 'exact-expected' -or\s*\$captureProducerStderrState -cne 'exact-expected'[\s\S]*?\$redirectionAccepted = \$true/u,
  );
  assert.doesNotMatch(
    captureRedirectionTestMode.slice(
      captureRedirectionTestMode.indexOf('WaitForExit($terminationTimeoutMilliseconds)'),
      captureRedirectionTestMode.indexOf('Assert-PrivilegedCaptureIdentity'),
    ),
    /ReadAllText|ReadAllBytes|ReadBounded/u,
  );
  assert.doesNotMatch(captureRedirectionTestMode, /start-process-launch/u);
  assert.match(
    captureRedirectionTestMode,
    /-TestOnlyIdentityPredicate 'post-redirection-identity'/u,
  );
  assert.match(
    captureRedirectionTestMode,
    /\$primaryFailure = 'artifact-type'[\s\S]*?\$primaryPhase = 'capture-parse'[\s\S]*?\$primarySubphase = 'capture-authority'[\s\S]*?Set-CaptureAuthorityPredicate \$redirectionFailurePredicate/u,
  );
  assert.match(captureParser, /Set-LifecycleFailureSubphase \$failureRecord\.category[\s\S]*?return 'spawn-failed'/u);
  assert.doesNotMatch(captureParser, /lastMilestone/u);
  assert.match(captureParser, /\$script:failurePhase = \$failureRecord\.phase/u);
  assert.match(
    orchestrator,
    /Read-PackagedConnectSmokeFailure[\s\S]*?-Path \$stderr[\s\S]*?-ExpectedCaptureIdentity \$stderrAuthority\.Identity[\s\S]*?Stop-PackagedConnect \$childFailureCategory/u,
  );
  assert.match(orchestrator, /catch \{\s*Set-PrimaryFailureFromException \$_\.Exception\s*\}/u);
  assert.match(orchestrator, /\$primaryPhase -ceq 'ordinary-user-preflight'[\s\S]*?\$primarySubphase = 'host-state-contract'/u);
  assert.match(orchestrator, /\$subphaseEvidence = ":subphase=\$primarySubphase"/u);
  assert.match(orchestrator, /PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=\$primaryFailure`:phase=\$primaryPhase\$subphaseEvidence`:cleanup=\$cleanupSecondary/u);

  const cleanupFinally = orchestrator.slice(orchestrator.lastIndexOf('} finally {'));
  assert.match(cleanupFinally, /\$cleanupResult = Invoke-BoundedCleanup/u);
  assert.doesNotMatch(cleanupFinally, /Get-ChildItem|GetAccessControl|Remove-Item|Test-Path|Remove-LocalUser/u);
  assert.match(cleanupFinally, /if \(\$null -eq \$primaryFailure -and \$cleanupSecondary -ne 'none'\)/u);
  assert.doesNotMatch(
    cleanupFinally.slice(0, cleanupFinally.indexOf("if ($null -eq $primaryFailure")),
    /\$primaryFailure\s*=/u,
    'a cleanup timeout must not replace an existing primary failure',
  );

  const preflight = harness.indexOf('const staged = await validateWindowsStagedPackage');
  const spawn = harness.indexOf("const child = spawn(binaryPath, ['--disable-gpu'");
  assert.ok(preflight >= 0 && preflight < spawn, 'ordinary-user package preflight must complete before spawn');
  assert.equal((harness.match(/await validateWindowsStagedPackage\(/gu) ?? []).length, 1);
  assert.equal((harness.match(/await runPackagedConnectLifecycle\(/gu) ?? []).length, 1);
  assert.match(harness, /shell: false/u);
  assert.match(harness, /parseWindowsStagedPackageHandoff\(process\.argv\.slice\(2\)\)/u);
  assert.match(harness, /delete childEnvironment\.PROPR_DESKTOP_CONNECT_STAGING_PARENT/u);
  assert.match(harness, /delete childEnvironment\.PROPR_DESKTOP_CONNECT_STAGING_LEAF/u);
  assert.match(harness, /describeWindowsArtifactFailure\(error, packagedConnectPhase\)/u);
  assert.match(harness, /packagedConnectArtifactSensitiveNeedles\(\{\s*platform: process\.platform,\s*artifactRoot,\s*binaryPath,/u);
  assert.doesNotMatch(harness, /identity, artifactRoot, binaryPath,/u);
  assert.doesNotMatch(harness, /child\.once\('error', error/u);
  const readyProducer = main.slice(
    main.indexOf('const runPackagedConnectDiscoverySmoke'),
    main.indexOf('const runPackagedTransportSmoke'),
  );
  assert.match(readyProducer, /await window\.webContents\.executeJavaScript/u);
  assert.match(readyProducer, /process\.stdout\.write\(`\$\{JSON\.stringify\(\{/u);
  assert.match(readyProducer, /const readyFields = \{[\s\S]*?selectedPlatform: process\.platform[\s\S]*?selectedArch: process\.arch[\s\S]*?authorityMechanism:[\s\S]*?rendererSchemaValid: true/u);
  assert.match(readyProducer, /timestamp: new Date\(\)\.toISOString\(\)[\s\S]*?level: 'info'[\s\S]*?event: 'desktop\.renderer\.connect_discovery\.ready'[\s\S]*?\.\.\.readyFields/u);
  assert.ok(
    readyProducer.indexOf("throw new Error('Packaged Connect renderer discovery proof was invalid')")
      < readyProducer.indexOf('process.stdout.write'),
    'READY must be emitted only after the renderer discovery proof succeeds',
  );
});

windowsTest('the PS5.1 child-failure parser accepts only the two exact bounded producer schemas', async context => {
  const runnerTemp = process.env.RUNNER_TEMP;
  assert.equal(typeof runnerTemp, 'string');
  const smokeRecord = {
    event: 'packaged_connect.smoke_failed',
    category: 'timeout-before-ready',
    capture: 'complete',
    records: [{
      event: 'desktop.renderer.connect_discovery.phase',
      phase: 'config-read',
      code: 'FAILED',
      substep: 'directory-open',
      category: 'access-denied',
    }],
    secondary: ['tree-termination-failed'],
  };
  const stagedContractRecord = {
    event: 'packaged_connect.artifact_failed',
    category: 'artifact-type',
    phase: 'staged-contract',
    subphase: 'parent-to-runner-binding',
  };
  const stagedTreeRecord = {
    event: 'packaged_connect.artifact_failed',
    category: 'artifact-inaccessible',
    phase: 'staged-tree',
  };
  const stagedArchitectureRecord = {
    event: 'packaged_connect.artifact_failed',
    category: 'architecture-mismatch',
    phase: 'staged-architecture',
  };
  const ordinaryPreflightRecord = {
    event: 'packaged_connect.artifact_failed',
    category: 'artifact-inaccessible',
    phase: 'ordinary-user-preflight',
    subphase: 'executable-read',
  };
  const smokeLine = `${JSON.stringify(smokeRecord)}\n`;
  const artifactLine = `${JSON.stringify(stagedContractRecord)}\n`;
  const cases = [
    ['valid-smoke', smokeLine,
      'category=spawn-failed:phase=application-runtime:subphase=timeout-before-ready'],
    ['valid-record-contained-ready-milestone', `${JSON.stringify({
      ...smokeRecord,
      records: [{ event: 'desktop.renderer.connect_discovery.ready' }],
    })}\n`, 'category=spawn-failed:phase=application-runtime:subphase=timeout-before-ready'],
    ['valid-record-contained-proof-milestone', `${JSON.stringify({
      ...smokeRecord,
      records: [{ event: 'desktop.renderer.connect_discovery.proof' }],
    })}\n`, 'category=spawn-failed:phase=application-runtime:subphase=timeout-before-ready'],
    ['valid-ready-duplicate', `${JSON.stringify({
      ...smokeRecord, category: 'ready-duplicate',
    })}\n`, 'category=spawn-failed:phase=application-runtime:subphase=ready-duplicate'],
    ['valid-child-remained-alive', `${JSON.stringify({
      ...smokeRecord, category: 'child-remained-alive',
    })}\n`, 'category=spawn-failed:phase=application-runtime:subphase=child-remained-alive'],
    ['valid-staged-contract', artifactLine,
      'category=artifact-type:phase=staged-contract:subphase=parent-to-runner-binding'],
    ['valid-staged-tree', `${JSON.stringify(stagedTreeRecord)}\n`,
      'category=artifact-inaccessible:phase=staged-tree'],
    ['valid-staged-architecture', `${JSON.stringify(stagedArchitectureRecord)}\n`,
      'category=architecture-mismatch:phase=staged-architecture'],
    ['valid-ordinary-user-preflight', `${JSON.stringify(ordinaryPreflightRecord)}\n`,
      'category=artifact-inaccessible:phase=ordinary-user-preflight:subphase=executable-read'],
    ['malformed', '{"event":\n',
      'category=artifact-type:phase=capture-parse:subphase=capture-json'],
    ['smoke-duplicate-field', smokeLine.replace(
      '{"event":"packaged_connect.smoke_failed",',
      '{"event":"packaged_connect.smoke_failed","event":"packaged_connect.smoke_failed",',
    ), 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-duplicate-field', artifactLine.replace(
      '"phase":"staged-contract",',
      '"phase":"staged-contract","phase":"staged-contract",',
    ), 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-extra-field', `${JSON.stringify({ ...smokeRecord, detail: 'fixed' })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-top-level-last-milestone', `${JSON.stringify({
      ...smokeRecord, lastMilestone: 'desktop.app.ready',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-extra-field', `${JSON.stringify({ ...stagedContractRecord, detail: 'fixed' })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-missing-field', `${JSON.stringify({
      event: smokeRecord.event, category: smokeRecord.category, records: smokeRecord.records,
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-missing-field', `${JSON.stringify({
      event: stagedContractRecord.event,
      category: stagedContractRecord.category,
      phase: stagedContractRecord.phase,
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-cross-schema-phase', `${JSON.stringify({
      ...smokeRecord, phase: 'staged-tree',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-cross-schema-subphase', `${JSON.stringify({
      ...smokeRecord, subphase: 'fixed-parent-leaf',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-cross-schema-capture', `${JSON.stringify({
      ...stagedContractRecord, capture: 'complete',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-cross-schema-records', `${JSON.stringify({
      ...stagedContractRecord, records: [],
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['artifact-cross-schema-secondary', `${JSON.stringify({
      ...stagedContractRecord, secondary: ['tree-termination-failed'],
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-multiline', `${smokeLine}${smokeLine}`,
      'category=artifact-type:phase=capture-parse:subphase=capture-line-cardinality'],
    ['artifact-multiline', `${artifactLine}${artifactLine}`,
      'category=artifact-type:phase=capture-parse:subphase=capture-line-cardinality'],
    ['oversized', Buffer.alloc(65_537, 0x61),
      'category=artifact-type:phase=capture-parse:subphase=capture-size'],
    ['wrong-event', `${JSON.stringify({ ...smokeRecord, event: 'packaged_connect.child_failed' })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-event-cardinality'],
    ['wrong-nested-event', `${JSON.stringify({
      ...smokeRecord, records: [{ event: 'desktop.renderer.connect_discovery.arbitrary' }],
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-event-cardinality'],
    ['proof-extra-field', `${JSON.stringify({
      ...smokeRecord,
      records: [{ event: 'desktop.renderer.connect_discovery.proof', milestone: 'connect-proof' }],
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-wrong-category', `${JSON.stringify({
      ...smokeRecord, category: 'arbitrary-runtime-error',
    })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-lifecycle-category'],
    ['artifact-wrong-category', `${JSON.stringify({
      ...stagedContractRecord, category: 'artifact-inaccessible',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-lifecycle-category'],
    ['artifact-wrong-phase', `${JSON.stringify({
      ...stagedContractRecord, phase: 'application-runtime',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-lifecycle-phase'],
    ['artifact-wrong-required-subphase', `${JSON.stringify({
      ...stagedContractRecord, subphase: 'executable-read',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-lifecycle-subphase'],
    ['artifact-forbidden-subphase', `${JSON.stringify({
      ...stagedTreeRecord, subphase: 'executable-read',
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-schema-cardinality'],
    ['smoke-wrong-record-category', `${JSON.stringify({
      ...smokeRecord,
      records: [{ ...smokeRecord.records[0], category: 'arbitrary-category' }],
    })}\n`, 'category=artifact-type:phase=capture-parse:subphase=capture-lifecycle-subphase'],
    ['smoke-sensitive', `${JSON.stringify({ ...smokeRecord, category: 'environment-secret-SENTINEL' })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-redaction'],
    ['artifact-sensitive', `${JSON.stringify({
      ...stagedContractRecord, subphase: 'environment-secret-SENTINEL',
    })}\n`,
      'category=artifact-type:phase=capture-parse:subphase=capture-redaction'],
    ['invalid-utf8', Buffer.from([0xc3, 0x28, 0x0a]),
      'category=artifact-type:phase=capture-parse:subphase=capture-utf8'],
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const [name, content, evidence] = cases[index];
    const capturePath = join(
      runnerTemp,
      `propr-connect-${randomBytes(16).toString('hex')}.stderr`,
    );
    await writeFile(capturePath, content, { flag: 'wx' });
    context.after(() => rm(capturePath, { force: true }));
    const result = runCaptureParserTest(capturePath);
    assert.ifError(result.error, name);
    assert.equal(result.signal, null, name);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout.length, 0, name);
    const diagnostic = result.stderr.toString('utf8').trim();
    assert.equal(
      diagnostic,
      `PROPR_WINDOWS_PACKAGED_CONNECT:failed:${evidence}:cleanup=none`,
      name,
    );
    assert.ok(diagnostic.length <= 256, name);
    assertNoHostileDiagnosticEvidence(diagnostic);
    assert.doesNotMatch(diagnostic, /SENTINEL|arbitrary|fixed/iu, name);
  }
});

windowsTest('the PS5.1 capture parser enforces native owner ACL path and identity authority', async context => {
  const runnerTemp = process.env.RUNNER_TEMP;
  assert.equal(typeof runnerTemp, 'string');
  const content = `${JSON.stringify({
    event: 'packaged_connect.artifact_failed',
    category: 'artifact-type',
    phase: 'staged-contract',
    subphase: 'parent-to-runner-binding',
  })}\n`;
  const expectedAccepted = 'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
    + ':phase=staged-contract:subphase=parent-to-runner-binding:cleanup=none';
  const expectedRejected = predicate => 'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
    + `:phase=capture-parse:subphase=capture-authority:predicate=${predicate}:cleanup=none`;
  const trackedPaths = [];
  context.after(async () => {
    await Promise.all(trackedPaths.map(path => rm(path, { force: true, recursive: true })));
  });
  const newCapturePath = async (parent = runnerTemp, leaf) => {
    const path = join(
      parent,
      leaf ?? `propr-connect-${randomBytes(16).toString('hex')}.stderr`,
    );
    await writeFile(path, content, { flag: 'wx' });
    trackedPaths.push(path);
    return path;
  };
  const assertResult = (name, result, expected) => {
    assert.ifError(result.error, name);
    assert.equal(result.signal, null, name);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout.length, 0, name);
    const diagnostic = result.stderr.toString('utf8').trim();
    assert.equal(diagnostic, expected, name);
    assertNoHostileDiagnosticEvidence(diagnostic);
  };

  for (const authorityCase of ['current-owner', 'administrators-owner']) {
    const path = await newCapturePath();
    assertResult(authorityCase, runCaptureParserTest(path, authorityCase), expectedAccepted);
  }

  for (const [authorityCase, predicate] of [
    ['foreign-owner', 'capture-owner'],
    ['ordinary-owner', 'capture-owner'],
    ['ordinary-write', 'unauthorized-writer'],
    ['broad-write', 'unauthorized-writer'],
    ['unprotected-dacl', 'dacl-canonicality'],
  ]) {
    const path = await newCapturePath();
    assertResult(authorityCase, runCaptureParserTest(path, authorityCase), expectedRejected(predicate));
  }

  const isolatedParent = await mkdtemp(join(runnerTemp, 'propr-capture-parent-owner-'));
  trackedPaths.push(isolatedParent);
  const isolatedParentCapture = await newCapturePath(isolatedParent);
  assertResult(
    'foreign-parent-owner',
    runCaptureParserTest(
      isolatedParentCapture,
      'foreign-parent-owner',
      { RUNNER_TEMP: isolatedParent },
    ),
    expectedRejected('parent-owner'),
  );

  const wrongLeaf = await newCapturePath(
    runnerTemp,
    `propr-connect-${randomBytes(16).toString('hex')}.txt`,
  );
  assertResult('wrong-leaf', runCaptureParserTest(wrongLeaf), expectedRejected('link-path-type'));

  const escapeParent = await mkdtemp(join(runnerTemp, 'propr-capture-escape-'));
  trackedPaths.push(escapeParent);
  const escapedCapture = await newCapturePath(escapeParent);
  assertResult(
    'parent-escape',
    runCaptureParserTest(escapedCapture),
    expectedRejected('link-path-type'),
  );

  const hardlinkCapture = await newCapturePath();
  const hardlinkAlias = join(
    runnerTemp,
    `propr-connect-${randomBytes(16).toString('hex')}.stderr`,
  );
  await link(hardlinkCapture, hardlinkAlias);
  trackedPaths.push(hardlinkAlias);
  assertResult(
    'hardlink',
    runCaptureParserTest(hardlinkAlias, 'existing'),
    expectedRejected('link-path-type'),
  );

  const directoryCapture = join(
    runnerTemp,
    `propr-connect-${randomBytes(16).toString('hex')}.stderr`,
  );
  await mkdir(directoryCapture);
  trackedPaths.push(directoryCapture);
  assertResult(
    'non-regular-file',
    runCaptureParserTest(directoryCapture),
    expectedRejected('link-path-type'),
  );

  const reparseTarget = await newCapturePath(
    runnerTemp,
    `propr-capture-target-${randomBytes(8).toString('hex')}.txt`,
  );
  const reparseCapture = join(
    runnerTemp,
    `propr-connect-${randomBytes(16).toString('hex')}.stderr`,
  );
  await symlink(reparseTarget, reparseCapture, 'file');
  trackedPaths.push(reparseCapture);
  assertResult(
    'reparse-file',
    runCaptureParserTest(reparseCapture, 'existing'),
    expectedRejected('link-path-type'),
  );

  const reparseParentTarget = await mkdtemp(join(runnerTemp, 'propr-capture-parent-target-'));
  trackedPaths.push(reparseParentTarget);
  const reparseParent = join(runnerTemp, `propr-capture-parent-${randomBytes(8).toString('hex')}`);
  await symlink(reparseParentTarget, reparseParent, 'junction');
  trackedPaths.push(reparseParent);
  const reparseParentCapture = await newCapturePath(reparseParentTarget);
  const captureThroughReparseParent = join(reparseParent, reparseParentCapture.slice(
    reparseParentTarget.length + 1,
  ));
  assertResult(
    'reparse-parent',
    runCaptureParserTest(captureThroughReparseParent, 'existing', { RUNNER_TEMP: reparseParent }),
    expectedRejected('link-path-type'),
  );

  const identityChangeCapture = await newCapturePath();
  trackedPaths.push(`${identityChangeCapture}.propr-replaced`);
  assertResult(
    'identity-change',
    runCaptureParserTest(identityChangeCapture, 'identity-change'),
    expectedRejected('identity-replacement'),
  );
});

windowsTest('nominal reaches zero with exact protected stdout and stderr capture', () => {
  const result = runCaptureRedirectionTest();
  const accepted = !result.error && result.signal === null && result.status === 0
    && Buffer.isBuffer(result.stdout) && result.stdout.length <= 128
    && captureRedirectionAcceptedPattern.test(result.stdout.toString('utf8'))
    && Buffer.isBuffer(result.stderr) && result.stderr.length === 0;
  if (!accepted) failCaptureRedirectionTest(result);
});

windowsTest('a forced nonzero capture producer maps only to redirect-child-exit', () => {
  const result = runCaptureRedirectionTest('nonzero');
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0);
  const diagnostic = result.stderr.toString('utf8');
  assert.equal(
    diagnostic,
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
      + ':phase=capture-parse:subphase=capture-authority'
      + ':predicate=redirect-child-exit:exit=forced-23'
      + ':out=exact-expected:err=exact-expected:cleanup=none\r\n',
  );
  assertNoHostileDiagnosticEvidence(diagnostic);
});

windowsTest('empty and hostile producer results map only to fixed bounded buckets', () => {
  for (const [producerTestCase, expectedResult] of [
    ['empty', 'exit=other:out=empty:err=empty'],
    ['hostile', 'exit=other:out=other-bounded:err=other-bounded'],
  ]) {
    const result = runCaptureRedirectionTest(producerTestCase);
    assert.equal(result.error, undefined, producerTestCase);
    assert.equal(result.signal, null, producerTestCase);
    assert.equal(result.status, 1, producerTestCase);
    assert.equal(result.stdout.length, 0, producerTestCase);
    const diagnostic = result.stderr.toString('utf8');
    assert.equal(
      diagnostic,
      'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type'
        + ':phase=capture-parse:subphase=capture-authority'
        + `:predicate=redirect-child-exit:${expectedResult}:cleanup=none\r\n`,
      producerTestCase,
    );
    assertNoHostileDiagnosticEvidence(diagnostic);
  }
});

windowsTest('each host preflight failure transition emits one fixed redacted subphase', () => {
  for (const subphase of fixedHostDiagnosticSubphases) {
    const result = spawnSync(windowsPowerShell51Path(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      orchestratorPath,
      '-Architecture',
      process.arch,
      '-LifecycleTestMode',
      'diagnostic-subphase',
      '-DiagnosticTestSubphase',
      subphase,
    ], {
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
    const diagnostic = result.stderr.toString('utf8').trim();
    assert.equal(
      diagnostic,
      `PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-inaccessible:phase=ordinary-user-preflight:subphase=${subphase}:cleanup=none`,
    );
    assert.equal((diagnostic.match(/:subphase=/gu) ?? []).length, 1);
    assertNoHostileDiagnosticEvidence(diagnostic);
  }
});

for (const [testCase, subphase] of [
  ['zero', 'host-node-command-cardinality'],
  ['duplicate', 'host-node-command-cardinality'],
  ['multiple', 'host-node-command-cardinality'],
  ['mixed-types', 'host-node-command-cardinality'],
  ['case-collision', 'host-node-command-cardinality'],
  ['non-application', 'host-node-command-type'],
  ['missing-source', 'host-node-source'],
  ['non-scalar-source', 'host-node-source'],
]) {
  windowsTest(`the PS5.1 host Node producer rejects ${testCase} command evidence`, () => {
    const result = runHostNodeProducerTest(testCase);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
    const diagnostic = result.stderr.toString('utf8').trim();
    assert.equal(
      diagnostic,
      `PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type`
        + `:phase=ordinary-user-preflight:subphase=${subphase}:cleanup=none`,
    );
    assert.equal((diagnostic.match(/:subphase=/gu) ?? []).length, 1);
    assertNoHostileDiagnosticEvidence(diagnostic);
  });
}

windowsTest('the PS5.1 host Node producer returns one validated scalar Source', () => {
  const result = runHostNodeProducerTest('positive');
  assertPositiveHostNodeProducer(result);
});

windowsTest('the host launcher accepts only a stable final ordinary-file identity', async context => {
  const producedRoot = await mkdtemp(join(tmpdir(), 'propr-launcher-authority-'));
  context.after(() => rm(producedRoot, { force: true, recursive: true }));
  // PowerShell 5.1 expands an existing 8.3 path in GetFullPath, so join fixtures only below this final spelling.
  const root = await realpath(producedRoot);
  const rootEntry = await lstat(root);
  assert.equal(rootEntry.isDirectory(), true);
  assert.equal(rootEntry.isSymbolicLink(), false);
  assert.equal(await realpath(root), root, 'the native fixture producer must return its canonical root');
  const target = join(root, 'node-target.exe');
  const otherTarget = join(root, 'node-other.exe');
  const alias = join(root, 'node-alias.exe');
  const brokenAlias = join(root, 'node-broken.exe');
  const retargetedAlias = join(root, 'node-retargeted.exe');
  const identityTarget = join(root, 'node-identity.exe');
  const directory = join(root, 'node-directory.exe');
  await Promise.all([
    writeFile(target, Buffer.from('ordinary launcher target')),
    writeFile(otherTarget, Buffer.from('other ordinary launcher target')),
    writeFile(identityTarget, Buffer.from('identity launcher target')),
  ]);
  await symlink(target, alias, 'file');
  await symlink(join(root, 'missing-target.exe'), brokenAlias, 'file');
  await symlink(target, retargetedAlias, 'file');
  await mkdir(directory);

  if (producedRoot.toUpperCase() !== root.toUpperCase()) {
    assertLauncherAuthorityRejected(
      runLauncherAuthorityTest(join(producedRoot, 'node-target.exe')),
      'artifact-type',
      'host-launcher-selected-path-canonical-equality',
    );
  }

  for (const [caseName, acceptedPath] of [['normal', target], ['alias', alias]]) {
    const result = runLauncherAuthorityTest(acceptedPath, caseName);
    assertLauncherAuthorityAccepted(result, caseName);
  }

  assertLauncherAuthorityRejected(
    runLauncherAuthorityTest(brokenAlias),
    'artifact-missing',
    'host-launcher-source-open',
  );
  assertLauncherAuthorityRejected(
    runLauncherAuthorityTest(retargetedAlias, 'retarget-alias', otherTarget),
    'artifact-type',
    'host-launcher-source-reopen-match',
  );
  assertLauncherAuthorityRejected(
    runLauncherAuthorityTest(identityTarget, 'identity-mismatch'),
    'artifact-type',
    'host-launcher-final-match',
  );
  assertLauncherAuthorityRejected(
    runLauncherAuthorityTest(directory),
    'artifact-type',
    'host-launcher-source-type',
  );
  const selectedPathRejections = [
    ['', 'host-launcher-selected-path-input'],
    [String.raw`\\.\NUL`, 'host-launcher-selected-path-input'],
    [String.raw`\\?\C:\ordinary.exe`, 'host-launcher-selected-path-input'],
    [String.raw`\??\C:\ordinary.exe`, 'host-launcher-selected-path-input'],
    [`${root}\\${'x'.repeat(260)}`, 'host-launcher-selected-path-input'],
    [`${root}\\control-${String.fromCharCode(1)}.exe`, 'host-launcher-selected-path-input'],
    [String.raw`C:\invalid|path.exe`, 'host-launcher-selected-path-get-full-path'],
    [String.raw`\\server\share`, 'host-launcher-selected-path-absolute-shape'],
    [String.raw`C:\ordinary.exe:alternate-stream`, 'host-launcher-selected-path-extra-colon'],
    ['node.exe', 'host-launcher-selected-path-canonical-equality'],
    [String.raw`C:\ordinary\..\ordinary.exe`, 'host-launcher-selected-path-canonical-equality'],
  ];
  for (const [rejectedPath, subphase] of selectedPathRejections) {
    assertLauncherAuthorityRejected(runLauncherAuthorityTest(rejectedPath), 'artifact-type', subphase);
  }
});

test('the bounded cleanup source requires proven child exit and bounded stream closure', async () => {
  const orchestrator = await readFile(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url), 'utf8');
  const boundedCleanup = orchestrator.slice(
    orchestrator.indexOf('function Invoke-BoundedCleanup'),
    orchestrator.indexOf('$authenticatedRunnerTemp = $null'),
  );
  assert.match(boundedCleanup, /\$cleanupProcess=\[Diagnostics\.Process\]::new\(\)/u);
  assert.match(
    boundedCleanup,
    /if\(!\$cleanupProcess\.WaitForExit\(\$cleanupTimeoutMilliseconds\)\)\{[\s\S]*?\$cleanupProcess\.Kill\(\)[\s\S]*?if\(!\$cleanupProcess\.WaitForExit\(\$terminationTimeoutMilliseconds\)\)\{return 'failed'\}[\s\S]*?Task\]::WaitAll[\s\S]*?return 'timeout'/u,
  );
  assert.match(boundedCleanup, /\$cleanupOutputClose=\$cleanupProcess\.StandardOutput\.BaseStream\.CopyToAsync/u);
  assert.match(boundedCleanup, /\$cleanupErrorClose=\$cleanupProcess\.StandardError\.BaseStream\.CopyToAsync/u);
});

windowsTest('the native timeout path terminates an actual child and descendant tree', async context => {
  const { root, descendantProcessId } = await startNativeNodeTree();
  context.after(() => terminateTreeAfterTest(root.pid));
  context.after(() => terminateTreeAfterTest(descendantProcessId));
  assert.equal(processExists(root.pid), true);
  assert.equal(processExists(descendantProcessId), true);

  const result = spawnSync(windowsPowerShell51Path(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    orchestratorPath,
    '-Architecture',
    process.arch,
    '-LifecycleTestMode',
    'terminate-tree',
    '-LifecycleTestProcessId',
    String(root.pid),
  ], {
    shell: false,
    windowsHide: true,
    timeout: 15_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString('utf8').trim(),
    'PROPR_WINDOWS_PACKAGED_CONNECT_LIFECYCLE_TEST:tree-terminated');
  assert.equal(result.stderr.length, 0);
  assert.equal(await waitForProcessExit(root.pid), true, 'the native harness root must terminate');
  assert.equal(await waitForProcessExit(descendantProcessId), true,
    'the native harness descendant must terminate');
});

windowsTest('a real never-settling cleanup is bounded, terminated, and remains secondary', () => {
  const startedAt = Date.now();
  const result = spawnSync(windowsPowerShell51Path(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    orchestratorPath,
    '-Architecture',
    process.arch,
    '-LifecycleTestMode',
    'cleanup-timeout',
  ], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  const elapsedMilliseconds = Date.now() - startedAt;

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(
    result.stderr.toString('utf8').trim(),
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type:phase=staged-tree:cleanup=cleanup-timeout',
  );
  assert.ok(elapsedMilliseconds >= 750, 'the injected cleanup must reach its deadline');
  assert.ok(elapsedMilliseconds < 8_000, 'the cleanup deadline and termination must remain bounded');
});
