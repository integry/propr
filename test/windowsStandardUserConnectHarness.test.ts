import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import {
  parseWindowsNativeProbeOutput,
  WINDOWS_INSPECTION_CLEANUP_TIMEOUT_MS,
  WINDOWS_INSPECTION_TIMEOUT_MS,
  WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS,
  WindowsNativeStageError,
  windowsNativeTimingBucket,
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
  probeMilestoneAllowlist: string[];
  probeTimingAllowlist: string[];
  createFailureDiagnostic: (
    scenario: string,
    stage: string,
    failureStatus: { status?: unknown; reasonCodes?: unknown } | null,
    nativeStage: string | null,
    probe: { milestone: string | null; timing: string | null },
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
    probeMilestoneAllowlist,
    probeTimingAllowlist,
    createFailureDiagnostic,
  })`) as ReturnType<typeof diagnosticDefinitions>;
}

type FixtureScenario = { name: string; enabled: boolean; authorityMode?: string };
type SystemRootMode = 'missing' | 'mismatched' | 'untrusted' | undefined;

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

function windowsRootEnvironment(systemRootMode: SystemRootMode): Record<string, string> {
  const start = harness.indexOf('function windowsRootEnvironment(');
  const end = harness.indexOf('\n\nconst scenarioAllowlist =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const definitions = runInNewContext(`${harness.slice(start, end)}\n({ windowsRootEnvironment })`) as {
    windowsRootEnvironment: (
      mode: SystemRootMode,
      systemRoot: string,
      windir: string,
      untrustedRoot: string,
    ) => Record<string, string>;
  };
  return { ...definitions.windowsRootEnvironment(
    systemRootMode,
    'C:\\canonical-system-root',
    'C:\\canonical-windir',
    'D:\\untrusted-fixture',
  ) };
}

function missingWindowsRootFixtureEnvironment(systemRootMode: SystemRootMode): Record<string, string> {
  const start = harness.indexOf('const WINDOWS_ROOT_MISSING_MARKER =');
  const end = harness.indexOf('\n\nconst scenarioAllowlist =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const definitions = runInNewContext(`${harness.slice(start, end)}\n({ missingWindowsRootFixtureEnvironment })`) as {
    missingWindowsRootFixtureEnvironment: (mode: SystemRootMode) => Record<string, string>;
  };
  return { ...definitions.missingWindowsRootFixtureEnvironment(systemRootMode) };
}

function untrustedWindowsRootFixtureEnvironment(systemRootMode: SystemRootMode): Record<string, string> {
  const start = harness.indexOf('const WINDOWS_ROOT_MISSING_MARKER =');
  const end = harness.indexOf('\n\nconst scenarioAllowlist =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const definitions = runInNewContext(`${harness.slice(start, end)}\n({ untrustedWindowsRootFixtureEnvironment })`) as {
    untrustedWindowsRootFixtureEnvironment: (
      mode: SystemRootMode,
      root: string,
    ) => Record<string, string>;
  };
  return { ...definitions.untrustedWindowsRootFixtureEnvironment(systemRootMode, '/fixture-root') };
}

function consumeWindowsRootFixtureEnvironment(
  environment: Record<string, string>,
  fixtureRoot = '/fixture-root',
): Record<string, string> {
  const start = processMock.indexOf('const WINDOWS_ROOT_MISSING_MARKER =');
  const end = processMock.indexOf('\n\nconst originalSpawnSync =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = { process: { env: { ...environment }, cwd: () => fixtureRoot }, resolve };
  return runInNewContext(
    `${processMock.slice(start, end)}\nprocess.env`,
    context,
  ) as Record<string, string>;
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

test('the Windows authority fixtures isolate pre-import root injection markers', () => {
  const missing = windowsRootEnvironment('missing');
  assert.deepEqual(missing, {});
  assert.equal(Object.hasOwn(missing, 'SYSTEMROOT'), false);
  assert.equal(Object.hasOwn(missing, 'WINDIR'), false);
  assert.deepEqual(windowsRootEnvironment('mismatched'), {
    SYSTEMROOT: 'C:\\canonical-system-root',
    WINDIR: 'D:\\untrusted-fixture',
  });
  assert.deepEqual(windowsRootEnvironment('untrusted'), {
    SYSTEMROOT: 'C:\\canonical-system-root',
    WINDIR: 'C:\\canonical-windir',
  });
  assert.deepEqual(windowsRootEnvironment(undefined), {
    SYSTEMROOT: 'C:\\canonical-system-root',
    WINDIR: 'C:\\canonical-windir',
  });
  assert.match(
    harness,
    /\.\.\.windowsRootEnvironment\(\s*scenario\.systemRootMode,\s*process\.env\.SystemRoot,\s*process\.env\.WINDIR,\s*fixture,\s*\),/,
  );
  assert.deepEqual(missingWindowsRootFixtureEnvironment('missing'), {
    PROPR_TEST_WINDOWS_ROOT_MISSING: 'windows-root-missing-v1',
  });
  for (const mode of ['mismatched', 'untrusted', undefined] as const) {
    assert.deepEqual(missingWindowsRootFixtureEnvironment(mode), {}, String(mode));
  }
  assert.match(
    harness,
    /\.\.\.missingWindowsRootFixtureEnvironment\(scenario\.systemRootMode\),/,
  );
  assert.deepEqual(untrustedWindowsRootFixtureEnvironment('untrusted'), {
    PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'windows-root-untrusted-v1',
    PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH: '/fixture-root',
  });
  for (const mode of ['missing', 'mismatched', undefined] as const) {
    assert.deepEqual(untrustedWindowsRootFixtureEnvironment(mode), {}, String(mode));
  }
  assert.match(
    harness,
    /\.\.\.untrustedWindowsRootFixtureEnvironment\(scenario\.systemRootMode, fixture\),/,
  );

  const consumed = consumeWindowsRootFixtureEnvironment({
    PROPR_TEST_WINDOWS_ROOT_MISSING: 'windows-root-missing-v1',
    SystemRoot: 'C:\\Windows',
    SYSTEMROOT: 'D:\\Windows',
    windir: 'C:\\Windows',
    WiNdIr: 'D:\\Windows',
    SAFE_FIXTURE_VALUE: 'retained',
  });
  assert.deepEqual({ ...consumed }, { SAFE_FIXTURE_VALUE: 'retained' });

  for (const mode of ['mismatched', 'untrusted', undefined] as const) {
    const untouched = windowsRootEnvironment(mode);
    assert.deepEqual(
      { ...consumeWindowsRootFixtureEnvironment(untouched) },
      untouched,
      String(mode),
    );
  }
  for (const untouchedMarker of [
    {
      PROPR_TEST_WINDOWS_ROOT_MISSING: 'not-the-fixed-marker',
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'D:\\untrusted-fixture',
    },
    {
      propr_test_windows_root_missing: 'windows-root-missing-v1',
      SYSTEMROOT: 'D:\\untrusted-fixture',
      WINDIR: 'D:\\untrusted-fixture',
    },
  ]) {
    assert.deepEqual(
      { ...consumeWindowsRootFixtureEnvironment(untouchedMarker) },
      untouchedMarker,
    );
  }

  const untrusted = consumeWindowsRootFixtureEnvironment({
    PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'windows-root-untrusted-v1',
    PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH: '/fixture-root',
    SystemRoot: 'C:\\Windows',
    SYSTEMROOT: 'D:\\Windows',
    systemroot: 'E:\\Windows',
    windir: 'C:\\Windows',
    WiNdIr: 'D:\\Windows',
    SAFE_FIXTURE_VALUE: 'retained',
  });
  assert.deepEqual({ ...untrusted }, {
    SAFE_FIXTURE_VALUE: 'retained',
    SystemRoot: '/fixture-root',
    WINDIR: '/fixture-root',
  });
  assert.equal(Object.hasOwn(untrusted, 'PROPR_TEST_WINDOWS_ROOT_UNTRUSTED'), false);
  assert.equal(Object.hasOwn(untrusted, 'PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH'), false);

  for (const untouchedMarker of [
    {
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'not-the-fixed-marker',
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH: '/fixture-root',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
    {
      propr_test_windows_root_untrusted: 'windows-root-untrusted-v1',
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH: '/fixture-root',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
    {
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'windows-root-untrusted-v1',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
    {
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'windows-root-untrusted-v1',
      propr_test_windows_root_untrusted_path: '/fixture-root',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
    {
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED: 'windows-root-untrusted-v1',
      PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH: '/outside-fixture',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
  ]) {
    assert.deepEqual(
      { ...consumeWindowsRootFixtureEnvironment(untouchedMarker) },
      untouchedMarker,
    );
  }

  const missingFixtureConsumer = processMock.indexOf('consumeMissingWindowsRootFixtureMarker();');
  const untrustedFixtureConsumer = processMock.indexOf('consumeUntrustedWindowsRootFixtureMarker();');
  const fixtureMockInstall = processMock.indexOf('const originalSpawnSync =');
  const processFixtureImport = harness.indexOf('"--import", processFixture');
  const fetchFixtureImport = harness.indexOf('"--import", fetchFixture');
  assert.ok(missingFixtureConsumer !== -1 && missingFixtureConsumer < fixtureMockInstall);
  assert.ok(untrustedFixtureConsumer !== -1 && untrustedFixtureConsumer < fixtureMockInstall);
  assert.ok(processFixtureImport !== -1 && processFixtureImport < fetchFixtureImport);
  assert.match(harness, /spawnSync\(process\.execPath, \[\s*\.\.\.fixtureNodeArgs,\s*cli,/);

  const productionSource = readdirSync('packages/cli/src', { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    .map((entry) => readFileSync(`packages/cli/src/${entry}`, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    productionSource,
    /PROPR_TEST_WINDOWS_ROOT_(?:MISSING|UNTRUSTED)|windows-root-(?:missing|untrusted)-v1/,
  );

  assert.match(harness, /const configDirectory = join\(fixture, "config"\);/);
  assert.equal(harness.match(/new ConfigManager\(/g)?.length, 1);
  assert.doesNotMatch(harness, /userInfo\(\)\.homedir|(?:writeFileSync|new ConfigManager)\([^\n]*(?:USERPROFILE|\.propr)/);
});

test('the ordinary-user Windows proof retains native security paths and bounds result-matrix reuse', () => {
  assert.match(harness, /await scaffoldStack\(/);
  assert.match(harness, /await manager\.save\(\)/);
  assert.match(harness, /public-instance-identity\.json/);
  assert.match(harness, /config\.json/);
  const scenarios = fixtureScenarios();
  const ready = scenarios.find((scenario) => scenario.name === 'ready');
  assert.ok(ready);
  assert.equal(ready.authorityMode, undefined);
  for (const scenario of scenarios.filter(({ name }) => name !== 'ready')) {
    assert.equal(scenario.authorityMode, 'valid-authority', scenario.name);
  }
  assert.match(
    processMock,
    /else if \(mode !== "nonzero"\) child\.stdout\.write\(authorityDocument\(args, options, mode, invocation\)\);/,
  );
  assert.match(harness, /\{ name: "path-aba", mode: "path-aba", reason: "INVALID_ROOT" \}/);
  assert.match(harness, /\{ name: "authority-missing-system-root", systemRootMode: "missing", nativeStage: "resolver:env" \}/);
  assert.match(harness, /\{ name: "authority-untrusted-system-root", systemRootMode: "untrusted", nativeStage: "resolver:global-id" \}/);
});

test('the ordinary-user Windows diagnostic has fixed allowlists and redacts all other values', () => {
  const definitions = diagnosticDefinitions();
  assert.deepEqual([...definitions.scenarioAllowlist], [
    'ready', 'down', 'disabled', 'restart-required', 'malformed', 'oversized', 'timeout',
    'identity-mismatch', 'secret-sentinel', 'api', 'path-aba', 'authority-malformed', 'authority-oversized',
    'authority-extra-key', 'authority-duplicate', 'authority-entry-count', 'authority-entry-shape',
    'authority-stderr', 'authority-nonzero',
    'authority-timeout', 'authority-descriptor-mismatch', 'authority-index-mismatch',
    'authority-kind-mismatch', 'authority-authority-kind-mismatch', 'authority-identity-mismatch',
    'authority-sid-mismatch', 'authority-broad-write', 'authority-inherited-write',
    'authority-unprotected', 'authority-owner-mismatch', 'authority-reparse',
    'authority-missing-system-root', 'authority-mismatched-system-root', 'authority-untrusted-system-root',
  ]);
  assert.deepEqual([...definitions.assertionStageAllowlist], [
    'native-timing', 'authority-probe', 'scaffold', 'identity-assertion', 'config-init', 'config-save',
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
    'spawn:create', 'spawn:error', 'spawn:timeout', 'spawn:status', 'spawn:stderr', 'spawn:cleanup',
    'probe:entry', 'probe:baseline', 'probe:reflection-emit', 'probe:win32', 'probe:standard-handle', 'probe:output',
    'broker:ps-version', 'broker:job', 'broker:fd', 'broker:fd-duplicate', 'broker:index-info-initial',
    'broker:security-info', 'broker:acl', 'broker:json', 'broker:current-user-sid',
    'broker:index-info-revalidation', 'broker:index-info-decode', 'broker:index-info-compose', 'broker:entry-format',
    'broker:entry-flags', 'broker:entry-rules', 'broker:entry-build',
    'parent:utf8', 'parent:json-parse', 'parent:json-canonical', 'parent:document-shape',
    'parent:entry-count', 'parent:entry-shape', 'parent:json-shape', 'parent:descriptor-bind', 'parent:post-bind',
  ]);
  assert.deepEqual([...definitions.probeMilestoneAllowlist], [
    'none', 'entry-ps51-desktop-x64', 'constant-json', 'reflection-emit', 'harmless-win32',
    'standard-handle-identity',
  ]);
  assert.deepEqual([...definitions.probeTimingAllowlist], [
    'under-5s', '5-to-15s', '15-to-30s', '30-to-45s', '45-to-60s', 'at-least-60s',
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
    milestone: 'standard-handle-identity', timing: '15-to-30s',
  });
  assert.deepEqual(Object.keys(diagnostic), [
    'scenario', 'stage', 'nativeStage', 'status', 'reasonCodes',
    'probeMilestone', 'probeTiming',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), {
    scenario: 'ready',
    stage: 'stderr',
    nativeStage: 'broker:fd',
    status: 'ready',
    reasonCodes: ['ACL_DIAGNOSTIC_UNAVAILABLE'],
    probeMilestone: 'standard-handle-identity',
    probeTiming: '15-to-30s',
  });
  assert.equal(JSON.stringify(diagnostic).includes('SENTINEL'), false);

  assert.deepEqual(JSON.parse(JSON.stringify(definitions.createFailureDiagnostic(
    'ready', 'native-timing', null, 'spawn:timeout',
    { milestone: 'reflection-emit', timing: 'at-least-60s' },
  ))), {
    scenario: 'ready',
    stage: 'native-timing',
    nativeStage: 'spawn:timeout',
    status: null,
    reasonCodes: [],
    probeMilestone: 'reflection-emit',
    probeTiming: 'at-least-60s',
  });

  const rejected = definitions.createFailureDiagnostic(
    'private-scenario-SENTINEL',
    'raw-output-SENTINEL',
    { status: 'secret-status-SENTINEL', reasonCodes: ['secret-reason-SENTINEL'] },
    'raw-native-stage-SENTINEL',
    { milestone: 'secret-SENTINEL', timing: '12345ms-SENTINEL' },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    scenario: 'ready',
    stage: 'write-env',
    nativeStage: null,
    status: null,
    reasonCodes: [],
    probeMilestone: null,
    probeTiming: null,
  });

  const catchStart = harness.lastIndexOf('} catch {');
  const catchEnd = harness.indexOf('} finally {', catchStart);
  const catchBody = harness.slice(catchStart, catchEnd);
  assert.match(catchBody, /createFailureDiagnostic\(\s*currentScenario, currentStage, failureStatus, currentNativeStage, nativeProbe,/);
  assert.match(catchBody, /JSON\.stringify\(\s*diagnostic,\s*\)/);
  assert.doesNotMatch(catchBody, /(?:result|api|error)\.(?:stdout|stderr|message|path|argv|env|config)/i);
});

test('the staged hosted probe and production inspector both use the inherited standard handle', () => {
  assert.doesNotMatch(windowsAuthority, /_get_osfhandle|AssignProcessToJobObject|CreateJobObject/);
  assert.match(harness, /runWindowsNativeTimingProbe\(probeFd\)/);
  assert.match(harness, /openSync\(\s*fixture,\s*constants\.O_RDONLY \| constants\.O_DIRECTORY \| constants\.O_NOFOLLOW,\s*\)/);
  assert.match(harness, /native-timing=\$\{nativeProbe\.evidence\}/);
  assert.match(harness, /;total:\$\{nativeProbe\.timing\}/);
  assert.match(harness, /ready=standard-handle-passed/);

  const productionSourceStart = windowsAuthority.indexOf('export const WINDOWS_INSPECTION_SOURCE');
  const productionSourceEnd = windowsAuthority.indexOf('export const WINDOWS_NATIVE_PROBE_MILESTONES', productionSourceStart);
  const productionSource = windowsAuthority.slice(productionSourceStart, productionSourceEnd);
  assert.match(productionSource, /GetStdHandle\(-10\)/);
  assert.doesNotMatch(productionSource, /_get_osfhandle|AssignProcessToJobObject|CreateJobObject|Start-Process|CreateProcess/);
  assert.match(windowsAuthority, /stdio: \[stdin, "pipe", "pipe"\]/);
  assert.match(windowsAuthority, /stdio: \[pinnedFd, "pipe", "pipe"\]/);
  assert.doesNotMatch(productionSource, /__PROPR_|\bindex=|\bkind=|authorityKind=/);
  assert.match(windowsAuthority, /powerShellArguments\(WINDOWS_INSPECTION_SOURCE\)/);
  assert.doesNotMatch(windowsAuthority, /inspectionSource\(target|\.replace\("__PROPR_/);
  assert.match(windowsAuthority, /WINDOWS_INSPECTOR_CREATES_CHILD_PROCESSES = false/);
  assert.match(windowsAuthority, /WINDOWS_INSPECTOR_WRITES_FILESYSTEM = false/);
});

test('the production inspector duplicates its standard handle before the split native operations', () => {
  const productionSourceStart = windowsAuthority.indexOf('export const WINDOWS_INSPECTION_SOURCE');
  const productionSourceEnd = windowsAuthority.indexOf('export const WINDOWS_NATIVE_PROBE_MILESTONES', productionSourceStart);
  const productionSource = windowsAuthority.slice(productionSourceStart, productionSourceEnd);
  assert.match(productionSource, /\$stage=80\s+if\(-not \[ProprReadOnlyAuthority\]::DuplicateHandle\(\s*\[ProprReadOnlyAuthority\]::GetCurrentProcess\(\),\$originalHandle,\s*\[ProprReadOnlyAuthority\]::GetCurrentProcess\(\),\[ref\]\$privateHandle,0,\$false,2\)\)\{exit \$stage\}/);
  assert.match(productionSource, /\$stage=74\s+\$before=\[Runtime\.InteropServices\.Marshal\]::AllocHGlobal\(52\)\s+if\(-not \[ProprReadOnlyAuthority\]::GetFileInformationByHandle\(\$privateHandle,\$before\)\)\{exit \$stage\}/);
  assert.match(productionSource, /\$stage=78\s+\$current=\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\s+if\(\$null-eq \$current\)\{exit \$stage\}\s+\$currentSid=\$current\.Value/);
  assert.match(productionSource, /GetSecurityInfo\(\$privateHandle,1,5,\[ref\]\$owner,\[ref\]\$group,\[ref\]\$dacl,\[ref\]\$sacl,\[ref\]\$descriptor\)/);
  assert.match(productionSource, /\$stage=79\s+\$after=\[Runtime\.InteropServices\.Marshal\]::AllocHGlobal\(52\)\s+if\(-not \[ProprReadOnlyAuthority\]::GetFileInformationByHandle\(\$privateHandle,\$after\)\)\{exit \$stage\}/);
  assert.equal(productionSource.match(/::CloseHandle\(\$privateHandle\)/g)?.length, 1);
  assert.match(productionSource, /finally \{if\(\$privateHandleOwned\)\{\$null=\[ProprReadOnlyAuthority\]::CloseHandle\(\$privateHandle\)\}\}/);
  assert.doesNotMatch(productionSource, /CloseHandle\(\$originalHandle\)/);
  assert.doesNotMatch(windowsAuthority, /"broker:index-info"/);
  assert.match(windowsAuthority, /74: "broker:index-info-initial"/);
  assert.match(windowsAuthority, /78: "broker:current-user-sid", 79: "broker:index-info-revalidation", 80: "broker:fd-duplicate"/);
});

test('the staged probe accepts only ordered milestone tokens and coarse timing buckets', () => {
  const prefix = [
    'PROPR_NATIVE_PROBE_V1|entry-ps51-desktop-x64|under-5s',
    'PROPR_NATIVE_PROBE_V1|constant-json|5-to-15s',
    'PROPR_NATIVE_PROBE_V1|reflection-emit|15-to-30s',
    '',
  ].join('\r\n');
  assert.deepEqual(parseWindowsNativeProbeOutput(prefix).map(({ milestone }) => milestone), [
    'entry-ps51-desktop-x64', 'constant-json', 'reflection-emit',
  ]);
  assert.deepEqual([4_999, 5_000, 15_000, 30_000, 45_000, 60_000].map(windowsNativeTimingBucket), [
    'under-5s', '5-to-15s', '15-to-30s', '30-to-45s', '45-to-60s', 'at-least-60s',
  ]);
  assert.throws(
    () => parseWindowsNativeProbeOutput('private-path-SENTINEL raw-exception-SENTINEL\r\n'),
    (error) => error instanceof WindowsNativeStageError
      && error.stage === 'probe:output'
      && !error.message.includes('SENTINEL'),
  );
  assert.match(windowsAuthority, /\$baseline='\{"version":1,"baseline":"constant"\}'/);
  assert.match(windowsAuthority, /DefineDynamicAssembly/);
  assert.match(windowsAuthority, /GetCurrentProcessId/);
  assert.match(windowsAuthority, /GetStdHandle\(-10\)/);
  assert.match(windowsAuthority, /GetFileInformationByHandle/);
});

test('the diagnostic allowance precedes one bounded concurrent standard-handle proof', () => {
  assert.equal(WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS, 60_000);
  assert.equal(WINDOWS_INSPECTION_TIMEOUT_MS, 60_000);
  assert.equal(WINDOWS_INSPECTION_CLEANUP_TIMEOUT_MS, 5_000);
  assert.match(
    windowsAuthority,
    /export const WINDOWS_INSPECTION_TIMEOUT_MS = 60_000;/,
  );
  assert.match(harness, /const WINDOWS_PRODUCT_AUTHORITY_PHASE_COUNT = 2;/);
  assert.match(harness, /const WINDOWS_PRODUCT_SCENARIO_OVERHEAD_MS = 15_000;/);
  assert.match(
    harness,
    /const WINDOWS_PRODUCT_SCENARIO_TIMEOUT_MS = \(\s*WINDOWS_PRODUCT_AUTHORITY_PHASE_COUNT \* nativeAuthority\.WINDOWS_INSPECTION_TIMEOUT_MS\s*\) \+ WINDOWS_PRODUCT_SCENARIO_OVERHEAD_MS;/,
  );
  const windowsProductScenarioTimeoutMs = (
    2 * WINDOWS_INSPECTION_TIMEOUT_MS
  ) + 15_000;
  assert.equal(windowsProductScenarioTimeoutMs, 135_000);
  assert.equal(Number.isFinite(windowsProductScenarioTimeoutMs), true);
  assert.equal(Number.isSafeInteger(windowsProductScenarioTimeoutMs), true);
  assert.ok(WINDOWS_INSPECTION_CLEANUP_TIMEOUT_MS < WINDOWS_INSPECTION_TIMEOUT_MS);
  assert.match(windowsAuthority, /startBroker: \(index\) => spawnInspectionBroker\(executable, targets\[index\]\.pinnedFd\)/u);
  assert.match(windowsAuthority, /const deadlineTimer = setTimeout\(\(\) => fail\("spawn:timeout"\), deadlineMs\)/u);
  assert.match(windowsAuthority, /deadlineMs: WINDOWS_INSPECTION_TIMEOUT_MS/u);
  const productionInspection = windowsAuthority.slice(
    windowsAuthority.indexOf('export async function runWindowsReadOnlyInspection'),
    windowsAuthority.indexOf('function probeFailureStage'),
  );
  assert.doesNotMatch(productionInspection, /spawnSync|windowsInspectionTimeoutForElapsed/u);
  const probeCall = harness.indexOf('runWindowsNativeTimingProbe(probeFd)');
  const productionMatrix = harness.indexOf('for (const scenario of cases)', probeCall);
  const productionSpawn = harness.indexOf('const result = spawnSync(process.execPath', productionMatrix);
  assert.ok(probeCall < productionMatrix && productionMatrix < productionSpawn);
  const probeStart = windowsAuthority.indexOf('export function runWindowsNativeTimingProbe');
  const probeEnd = windowsAuthority.indexOf('\n}\n\nexport function windowsInspectionEntryKind', probeStart);
  const probe = windowsAuthority.slice(probeStart, probeEnd);
  assert.match(probe, /const executable = resolveWindowsPowerShell\(\);/);
  assert.doesNotMatch(probe, /catch\s*\{/);
  assert.doesNotMatch(harness, /extraStdio|alreadyContained|nestedJob|runWindowsHostedAssumptionProbe/);
});

test('the hostile path ABA remains replaced through validation and is rejected as INVALID_ROOT', () => {
  assert.match(harness, /\{ name: "path-aba", mode: "path-aba", reason: "INVALID_ROOT" \}/);
  assert.doesNotMatch(harness, /name: "path-aba"[^\n]+status: "ready"/);
  assert.match(processMock, /attacker-replacement-SENTINEL/);
  assert.match(processMock, /process\.once\("exit", \(\) => \{/);
  const replacement = processMock.indexOf('writeFileSync(envPath');
  const exitHook = processMock.indexOf('process.once("exit"', replacement);
  const spawn = processMock.indexOf('return originalSpawn(command, args, options);', replacement);
  const restore = processMock.indexOf('renameSync(detached, envPath);', replacement);
  assert.ok(
    replacement < exitHook && exitHook < restore && restore < spawn,
    'restoration must be registered only for process exit before the CLI resumes',
  );
});
