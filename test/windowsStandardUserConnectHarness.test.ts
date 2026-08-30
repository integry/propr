import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const harness = readFileSync('scripts/verify-windows-standard-user-connect.mjs', 'utf8');

function diagnosticDefinitions(): {
  scenarioAllowlist: string[];
  assertionStageAllowlist: string[];
  statusKindAllowlist: string[];
  reasonCodeAllowlist: string[];
  createFailureDiagnostic: (
    scenario: string,
    stage: string,
    failureStatus: { status?: unknown; reasonCodes?: unknown } | null,
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
    createFailureDiagnostic,
  })`) as ReturnType<typeof diagnosticDefinitions>;
}

test('the ordinary-user Windows diagnostic has fixed allowlists and redacts all other values', () => {
  const definitions = diagnosticDefinitions();
  assert.deepEqual([...definitions.scenarioAllowlist], [
    'ready', 'down', 'disabled', 'restart-required', 'malformed', 'oversized', 'timeout',
    'identity-mismatch', 'secret-sentinel', 'api',
  ]);
  assert.deepEqual([...definitions.assertionStageAllowlist], [
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
    'IDENTITY_MISMATCH', 'ENDPOINT_MISMATCH', 'RESTART_REQUIRED', 'INVALID_ROOT', 'INVALID_ENDPOINT',
    'IDENTITY_UNAVAILABLE', 'INTERNAL_FAILURE', 'ACL_DIAGNOSTIC_UNAVAILABLE',
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
  } as { status: string; reasonCodes: string[] });
  assert.deepEqual(Object.keys(diagnostic), ['scenario', 'stage', 'status', 'reasonCodes']);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), {
    scenario: 'ready',
    stage: 'stderr',
    status: 'ready',
    reasonCodes: ['ACL_DIAGNOSTIC_UNAVAILABLE'],
  });
  assert.equal(JSON.stringify(diagnostic).includes('SENTINEL'), false);

  const rejected = definitions.createFailureDiagnostic(
    'private-scenario-SENTINEL',
    'raw-output-SENTINEL',
    { status: 'secret-status-SENTINEL', reasonCodes: ['secret-reason-SENTINEL'] },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    scenario: 'ready',
    stage: 'write-env',
    status: null,
    reasonCodes: [],
  });

  const catchStart = harness.lastIndexOf('} catch {');
  const catchEnd = harness.indexOf('} finally {', catchStart);
  const catchBody = harness.slice(catchStart, catchEnd);
  assert.match(catchBody, /createFailureDiagnostic\(currentScenario, currentStage, failureStatus\)/);
  assert.match(catchBody, /JSON\.stringify\(\s*diagnostic,\s*\)/);
  assert.doesNotMatch(catchBody, /(?:result|api|error)\.(?:stdout|stderr|message|path|argv|env|config)/i);
});
