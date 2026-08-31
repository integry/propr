import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import {
  interpretWindowsHostedAssumptionResults,
  WindowsNativeStageError,
} from '../packages/cli/src/connectWindowsAuthority.js';

const harness = readFileSync('scripts/verify-windows-standard-user-connect.mjs', 'utf8');
const processMock = readFileSync('test/fixtures/windowsConnectProcessMock.mjs', 'utf8');
const windowsAuthority = readFileSync('packages/cli/src/connectWindowsAuthority.ts', 'utf8');

function diagnosticDefinitions(): {
  scenarioAllowlist: string[];
  assertionStageAllowlist: string[];
  statusKindAllowlist: string[];
  reasonCodeAllowlist: string[];
  nativeStageAllowlist: string[];
  createFailureDiagnostic: (
    scenario: string,
    stage: string,
    failureStatus: { status?: unknown; reasonCodes?: unknown } | null,
    nativeStage: string | null,
    assumptions: {
      extraStdio: string | null;
      alreadyContained: boolean | 'failed' | 'timeout' | null;
      nestedJob: string | null;
    },
  ) => Record<string, unknown>;
} {
  const start = harness.indexOf('const scenarioAllowlist =');
  const end = harness.indexOf('const cases = [', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return runInNewContext(`${harness.slice(start, end)}\n({
    scenarioAllowlist,
    assertionStageAllowlist,
    statusKindAllowlist,
    reasonCodeAllowlist,
    nativeStageAllowlist,
    createFailureDiagnostic,
  })`) as ReturnType<typeof diagnosticDefinitions>;
}

type FixtureScenario = { name: string; enabled: boolean };

function tunnelFixtureEnvLines(scenario: FixtureScenario): string[] {
  const start = harness.indexOf('function tunnelFixtureEnvLines(');
  const end = harness.indexOf('\n\nconst scenarioAllowlist =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const definitions = runInNewContext(`${harness.slice(start, end)}\n({ tunnelFixtureEnvLines })`) as {
    tunnelFixtureEnvLines: (value: FixtureScenario) => string[];
  };
  return [...definitions.tunnelFixtureEnvLines(scenario)];
}

function fixtureScenarios(): FixtureScenario[] {
  const start = harness.indexOf('const cases = [');
  const end = harness.indexOf('\n];', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return runInNewContext(`${harness.slice(start, end + 3)}\ncases`) as FixtureScenario[];
}

test('the disabled Windows scenario omits its token while enabled scenarios retain the sentinel', () => {
  const scenarios = fixtureScenarios();
  const disabled = scenarios.find((scenario) => scenario.name === 'disabled');
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(tunnelFixtureEnvLines(disabled), [
    'PROPR_UI_TUNNEL_ENABLED=false',
  ]);
  for (const scenario of scenarios.filter(({ name }) => name !== 'disabled')) {
    assert.equal(scenario.enabled, true, scenario.name);
    assert.deepEqual(tunnelFixtureEnvLines(scenario), [
      'PROPR_UI_TUNNEL_ENABLED=true',
      'PROPR_UI_TUNNEL_TOKEN=root-token-SENTINEL',
    ], scenario.name);
  }
});

test('the ordinary-user Windows proof covers existing mutation paths', () => {
  assert.match(harness, /await scaffoldStack\(/);
  assert.match(harness, /await manager\.save\(\)/);
  assert.match(harness, /public-instance-identity\.json/);
  assert.match(harness, /config\.json/);
});

test('the ordinary-user Windows diagnostic has fixed allowlists and redacts all other values', () => {
  const definitions = diagnosticDefinitions();
  assert.deepEqual([...definitions.scenarioAllowlist], [
    'ready', 'down', 'disabled', 'restart-required', 'malformed', 'oversized', 'timeout',
    'identity-mismatch', 'secret-sentinel', 'api', 'path-aba', 'authority-malformed', 'authority-oversized',
    'authority-extra-key', 'authority-duplicate', 'authority-stderr', 'authority-nonzero',
    'authority-timeout', 'authority-descriptor-mismatch', 'authority-index-mismatch',
    'authority-kind-mismatch', 'authority-authority-kind-mismatch', 'authority-identity-mismatch',
    'authority-sid-mismatch', 'authority-broad-write', 'authority-inherited-write',
    'authority-unprotected', 'authority-owner-mismatch', 'authority-reparse',
    'authority-missing-system-root', 'authority-mismatched-system-root', 'authority-untrusted-system-root',
  ]);
  assert.deepEqual([...definitions.assertionStageAllowlist], [
    'native-assumptions', 'authority-probe', 'scaffold', 'identity-assertion', 'config-init', 'config-save',
    'config-assertion',
    'write-env', 'spawn', 'signal', 'exit', 'bounds', 'schema', 'status', 'endpoint',
    'identity', 'reasons', 'api-ready', 'restart', 'stderr', 'sentinel', 'api-spawn',
    'api-exit', 'api-count',
  ]);
  assert.deepEqual([...definitions.statusKindAllowlist], [
    'ready', 'internalFailure', 'notReady', 'incompatible', 'invalidConfig', 'timeout',
  ]);
  assert.deepEqual([...definitions.reasonCodeAllowlist], [
    'NOT_CONFIGURED', 'TUNNEL_DISABLED', 'SIDECAR_NOT_RUNNING', 'API_UNREACHABLE', 'API_TIMEOUT',
    'DISCOVERY_UNSUPPORTED', 'DISCOVERY_INVALID', 'DISCOVERY_TOO_LARGE', 'API_INCOMPATIBLE',
    'DESKTOP_AUTHENTICATION_UNSUPPORTED',
    'IDENTITY_MISMATCH', 'ENDPOINT_MISMATCH', 'RESTART_REQUIRED', 'INVALID_ROOT', 'INVALID_ENDPOINT',
    'IDENTITY_UNAVAILABLE', 'INTERNAL_FAILURE', 'ACL_DIAGNOSTIC_UNAVAILABLE',
  ]);
  assert.deepEqual([...definitions.nativeStageAllowlist], [
    'resolver:env', 'resolver:canonical', 'resolver:global-open', 'resolver:global-id',
    'spawn:create', 'spawn:error', 'spawn:timeout', 'spawn:status', 'spawn:stderr',
    'broker:ps-version', 'broker:job', 'broker:fd', 'broker:index-info',
    'broker:security-info', 'broker:acl', 'broker:json',
    'parent:utf8', 'parent:json-shape', 'parent:descriptor-bind', 'parent:post-bind',
  ]);
  const assignedStages = [...harness.matchAll(/currentStage = "([^"]+)";/g)]
    .map((match) => match[1]);
  assert.deepEqual(new Set(assignedStages), new Set(definitions.assertionStageAllowlist));

  const diagnostic = definitions.createFailureDiagnostic('ready', 'stderr', {
    status: 'ready',
    reasonCodes: ['ACL_DIAGNOSTIC_UNAVAILABLE'],
    path: 'private-path-SENTINEL',
    argv: 'argv-SENTINEL',
    stdout: 'raw-stdout-SENTINEL',
    stderr: 'raw-stderr-SENTINEL',
    message: 'assertion-message-SENTINEL',
    environment: 'environment-SENTINEL',
    config: 'config-SENTINEL',
    identity: 'identity-SENTINEL',
    endpoint: 'endpoint-SENTINEL',
    secret: 'secret-SENTINEL',
  } as { status: string; reasonCodes: string[] }, 'broker:fd', {
    extraStdio: 'unusable', alreadyContained: true, nestedJob: 'failed',
  });
  assert.deepEqual(Object.keys(diagnostic), [
    'scenario', 'stage', 'nativeStage', 'status', 'reasonCodes',
    'extraStdio', 'alreadyContained', 'nestedJob',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), {
    scenario: 'ready',
    stage: 'stderr',
    nativeStage: 'broker:fd',
    status: 'ready',
    reasonCodes: ['ACL_DIAGNOSTIC_UNAVAILABLE'],
    extraStdio: 'unusable',
    alreadyContained: true,
    nestedJob: 'failed',
  });
  assert.equal(JSON.stringify(diagnostic).includes('SENTINEL'), false);

  assert.deepEqual(JSON.parse(JSON.stringify(definitions.createFailureDiagnostic(
    'ready', 'native-assumptions', null, null,
    { extraStdio: 'timeout', alreadyContained: 'failed', nestedJob: 'timeout' },
  ))), {
    scenario: 'ready',
    stage: 'native-assumptions',
    nativeStage: null,
    status: null,
    reasonCodes: [],
    extraStdio: 'timeout',
    alreadyContained: 'failed',
    nestedJob: 'timeout',
  });

  const rejected = definitions.createFailureDiagnostic(
    'private-scenario-SENTINEL',
    'raw-output-SENTINEL',
    { status: 'secret-status-SENTINEL', reasonCodes: ['secret-reason-SENTINEL'] },
    'raw-native-stage-SENTINEL',
    { extraStdio: 'secret-SENTINEL', alreadyContained: 'secret-SENTINEL' as unknown as boolean, nestedJob: 'secret-SENTINEL' },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    scenario: 'ready',
    stage: 'write-env',
    nativeStage: null,
    status: null,
    reasonCodes: [],
    extraStdio: null,
    alreadyContained: null,
    nestedJob: null,
  });

  const catchStart = harness.lastIndexOf('} catch {');
  const catchEnd = harness.indexOf('} finally {', catchStart);
  const catchBody = harness.slice(catchStart, catchEnd);
  assert.match(catchBody, /createFailureDiagnostic\(\s*currentScenario, currentStage, failureStatus, currentNativeStage, hostedAssumptions,/);
  assert.match(catchBody, /JSON\.stringify\(\s*diagnostic,\s*\)/);
  assert.doesNotMatch(catchBody, /(?:result|api|error)\.(?:stdout|stderr|message|path|argv|env|config)/i);
});

test('the hosted proof measures both rejected assumptions and production uses a standard handle', () => {
  assert.match(windowsAuthority, /'_get_osfhandle' 'msvcrt\.dll'/);
  assert.match(windowsAuthority, /_get_osfhandle\(3\)/);
  assert.match(windowsAuthority, /AssignProcessToJobObject/);
  assert.match(harness, /runWindowsHostedAssumptionProbe\(assumptionFd\)/);
  assert.match(harness, /extra-stdio=\$\{hostedAssumptions\.extraStdio\}/);
  assert.match(harness, /nested-job=\$\{hostedAssumptions\.nestedJob\}/);
  assert.match(harness, /ready=standard-handle-passed/);

  const productionSourceStart = windowsAuthority.indexOf('export const WINDOWS_INSPECTION_SOURCE');
  const productionSourceEnd = windowsAuthority.indexOf('const WINDOWS_EXTRA_STDIO_ASSUMPTION_SOURCE', productionSourceStart);
  const productionSource = windowsAuthority.slice(productionSourceStart, productionSourceEnd);
  assert.match(productionSource, /GetStdHandle\(-10\)/);
  assert.doesNotMatch(productionSource, /_get_osfhandle|AssignProcessToJobObject|CreateJobObject|Start-Process|CreateProcess/);
  assert.match(windowsAuthority, /stdio: extraFd === undefined \? \[stdin, "pipe", "pipe"\]/);
  assert.match(windowsAuthority, /WINDOWS_INSPECTOR_CREATES_CHILD_PROCESSES = false/);
});

test('hosted assumptions isolate fd3, containment, and sacrificial nested-job outcomes', () => {
  const result = (
    status: number | null,
    stdout = '',
    error?: NodeJS.ErrnoException,
  ) => ({ status, signal: null, error, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
  const timeout = () => result(null, '', Object.assign(new Error('redacted'), { code: 'ETIMEDOUT' }));

  assert.deepEqual(interpretWindowsHostedAssumptionResults(
    timeout(),
    result(0, '{"version":1,"alreadyContained":false}'),
    result(0),
  ), { version: 1, extraStdio: 'timeout', alreadyContained: false, nestedJob: 'succeeded' });
  assert.deepEqual(interpretWindowsHostedAssumptionResults(
    result(81),
    timeout(),
    result(83),
  ), { version: 1, extraStdio: 'unusable', alreadyContained: 'timeout', nestedJob: 'failed' });
  assert.deepEqual(interpretWindowsHostedAssumptionResults(
    result(0, '{"version":1,"extraStdio":"usable"}'),
    result(82),
    timeout(),
  ), { version: 1, extraStdio: 'usable', alreadyContained: 'failed', nestedJob: 'timeout' });

  assert.match(windowsAuthority, /WINDOWS_HOSTED_ASSUMPTION_TIMEOUT_MS = 15_000/);
  assert.match(windowsAuthority, /timeout = WINDOWS_INSPECTION_TIMEOUT_MS/);
  assert.match(windowsAuthority, /WINDOWS_EXTRA_STDIO_ASSUMPTION_SOURCE/);
  assert.match(windowsAuthority, /WINDOWS_JOB_CONTAINMENT_ASSUMPTION_SOURCE/);
  assert.match(windowsAuthority, /WINDOWS_NESTED_JOB_ASSUMPTION_SOURCE/);
  const nestedSourceStart = windowsAuthority.indexOf('const WINDOWS_NESTED_JOB_ASSUMPTION_SOURCE');
  const nestedSourceEnd = windowsAuthority.indexOf('\n`;\n', nestedSourceStart);
  const nestedSource = windowsAuthority.slice(nestedSourceStart, nestedSourceEnd);
  assert.match(nestedSource, /AssignProcessToJobObject/);
  assert.doesNotMatch(nestedSource, /ConvertTo-Json|Console\]::Out/);
});

test('legacy probe outcomes continue to the production standard-handle proof while infrastructure fails closed', () => {
  const result = (error?: NodeJS.ErrnoException) => ({
    status: error ? null : 0,
    signal: null,
    error,
    stdout: Buffer.from('{"version":1,"extraStdio":"unusable"}'),
    stderr: Buffer.alloc(0),
  });
  assert.throws(
    () => interpretWindowsHostedAssumptionResults(
      result(Object.assign(new Error('redacted'), { code: 'ENOENT' })),
      { ...result(), stdout: Buffer.from('{"version":1,"alreadyContained":true}') },
      { ...result(), stdout: Buffer.alloc(0) },
    ),
    (error) => error instanceof WindowsNativeStageError && error.stage === 'spawn:error',
  );

  const assumptionCall = harness.indexOf('runWindowsHostedAssumptionProbe(assumptionFd)');
  const productionMatrix = harness.indexOf('for (const scenario of cases)', assumptionCall);
  const productionSpawn = harness.indexOf('const result = spawnSync(process.execPath', productionMatrix);
  assert.ok(assumptionCall < productionMatrix && productionMatrix < productionSpawn);
  const probeStart = windowsAuthority.indexOf('export function runWindowsHostedAssumptionProbe');
  const probeEnd = windowsAuthority.indexOf('\n}\n\nexport function windowsInspectionEntryKind', probeStart);
  const probe = windowsAuthority.slice(probeStart, probeEnd);
  assert.match(probe, /const executable = resolveWindowsPowerShell\(\);/);
  assert.doesNotMatch(probe, /catch\s*\{/);
});

test('the hostile path ABA remains replaced through validation and is rejected as INVALID_ROOT', () => {
  assert.match(harness, /\{ name: "path-aba", mode: "path-aba", reason: "INVALID_ROOT" \}/);
  assert.doesNotMatch(harness, /name: "path-aba"[^\n]+status: "ready"/);
  assert.match(processMock, /attacker-replacement-SENTINEL/);
  assert.match(processMock, /process\.once\("exit", \(\) => \{/);
  const replacement = processMock.indexOf('writeFileSync(envPath');
  const exitHook = processMock.indexOf('process.once("exit"', replacement);
  const spawn = processMock.indexOf('return originalSpawnSync(command, args, options);', replacement);
  const restore = processMock.indexOf('renameSync(detached, envPath);', replacement);
  assert.ok(
    replacement < exitHook && exitHook < restore && restore < spawn,
    'restoration must be registered only for process exit before the CLI resumes',
  );
});
