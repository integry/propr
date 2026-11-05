import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import {
  AGENT_DEFAULT_VERSIONS, agentDockerImageExists, closeConnection, computeContentHash, effectiveAgentBaseImage,
  executeDockerCommand, generateAgentBundleImageTag, getAgentCliVersionMatrix, shutdownQueue,
  type AgentConfig, type AgentRegistry, type AnalysisResult,
} from '@propr/core';
import { createAgentHealthCheck } from '../services/agentHealthCheck.js';
import { resolveHealthCheckImage } from '../routes/agentRoutes.js';

// Probe the real Docker engine before the fake shadows it on PATH.
const realDocker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;

const REVISION = '6a4ae8ecc596130769a0b9ae65b9789689d84e6e';
const PIN = `propr/agent:${REVISION}@sha256:196254e73b4533d8fa5ece08cc6f5eefda4c1cf5a5071938494e2b181181a8dc`;
const PIN_ID = 'sha256:7a8d6b06cc98740d6908732ee8b642dacaddadd3e9ce2e3710ca5b1ede481b37';

/**
 * Fake `docker` with the daemon's reference semantics observed on the Desktop
 * profile: `images -q` filters by repository[:tag] and exits 0 with no output
 * for a combined repo:tag@digest reference, while `image inspect` resolves
 * tags, IDs and digest references. Present references are read per call from
 * FAKE_DOCKER_PRESENT so a test can model the worker pulling the pin.
 */
const fakeRoot = mkdtempSync(join(tmpdir(), 'propr-health-pin-'));
writeFileSync(join(fakeRoot, 'docker'), `#!/bin/sh
is_present() { printf '%s\\n' "$FAKE_DOCKER_PRESENT" | grep -Fqx -- "$1"; }
if [ "$1" = "images" ] && [ "$2" = "-q" ]; then
  case "$3" in *@*) exit 0 ;; esac
  is_present "$3" && echo "7a8d6b06cc98"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  for ref; do :; done
  if ! is_present "$ref"; then echo "Error response from daemon: No such image: $ref" >&2; exit 1; fi
  if [ "$3" = "--format" ]; then echo "${PIN_ID}"; else echo '[{"Id":"${PIN_ID}"}]'; fi
  exit 0
fi
echo "unexpected docker $*" >&2
exit 1
`);
chmodSync(join(fakeRoot, 'docker'), 0o755);
const savedEnv = { ...process.env };
process.env.PATH = `${fakeRoot}${delimiter}${process.env.PATH}`;

function present(...images: string[]): void { process.env.FAKE_DOCKER_PRESENT = images.join('\n'); }
function managedRuntime(): void {
  process.env.PROPR_MANAGED_AGENT_IMAGE = PIN;
  process.env.PROPR_MANAGED_AGENT_REVISION = REVISION;
}

afterEach(() => {
  for (const key of ['PROPR_MANAGED_AGENT_IMAGE', 'PROPR_MANAGED_AGENT_REVISION', 'FAKE_DOCKER_PRESENT']) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});
after(async () => {
  rmSync(fakeRoot, { recursive: true, force: true });
  await shutdownQueue();
  await closeConnection();
});

// Explicit default-version rows as an existing Desktop profile stores them.
const claude: AgentConfig = {
  id: 'claude-1', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest',
  configPath: '~/.claude', supportedModels: ['claude-haiku-4-5-20251001'],
  cliVersionType: 'default', cliVersionResolved: AGENT_DEFAULT_VERSIONS.claude,
};
const codex: AgentConfig = {
  id: 'codex-1', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:latest',
  configPath: '~/.codex', supportedModels: ['gpt-6-luna'],
  cliVersionType: 'default', cliVersionResolved: AGENT_DEFAULT_VERSIONS.codex,
};
const customClaude: AgentConfig = { ...claude, cliVersionType: 'specific', cliVersion: '9.9.9', cliVersionResolved: '9.9.9' };
const bundleImage = (agents: AgentConfig[]) => generateAgentBundleImageTag(getAgentCliVersionMatrix(agents), computeContentHash());

/** Registry stand-in serving `image` once its verification passed, else its unavailable status. */
function registryServing(image: string | undefined, unavailableError?: string): AgentRegistry {
  return {
    isImageRecoveryPending: () => false,
    inspectAgentImageAvailability: async () => {},
    getAgentById: (id: string) => image ? { config: { ...claude, id, dockerImage: image } } : undefined,
    getOperationalStatus: () => ({ unifiedAgentImage: unavailableError
      ? { status: 'unavailable', error: unavailableError, operatorActionRequired: true }
      : { status: 'ready' } }),
    ensureInitialized: async () => {},
    recoverImagesAndRefresh: async () => {},
  } as unknown as AgentRegistry;
}

/** The route's dependency wiring with the real Docker lookups and a recording worker queue. */
const reply = (fields: Partial<Pick<AnalysisResult, 'success' | 'response' | 'error'>>): AnalysisResult => ({ success: true, response: '', modelUsed: 'probe', executionTimeMs: 1, ...fields });

function routeHealthCheck(agents: () => AgentConfig[], registry: () => AgentRegistry, analyze = async () => reply({ response: 'OK' })) {
  const prepared: string[] = [];
  const probed: string[] = [];
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  const check = createAgentHealthCheck({
    loadAgents: async () => agents(),
    imageExists: image => agentDockerImageExists(image),
    // Worker-owned preparation completes only when the test says so.
    prepareImage: async image => { prepared.push(image); await preparation; },
    resolveExecutionImage: config => resolveHealthCheckImage(config, registry()),
    createAgent: config => ({ analyze: async () => { probed.push(config.dockerImage); return analyze(); } }),
  });
  return { check, prepared, probed, finishPreparation };
}

test('the fake engine reproduces the Desktop defect: images -q misses the cached pin, the shared lookup finds it', async () => {
  present(PIN, 'propr/agent:tagged', PIN_ID);
  const legacy = await executeDockerCommand('docker', ['images', '-q', PIN], { timeout: 10000 });
  assert.equal(legacy.exitCode, 0);
  assert.equal(legacy.stdout.trim(), '');
  assert.equal(await agentDockerImageExists(PIN), true);
  // Tag and image-ID lookups keep their meaning; absent references stay absent.
  assert.equal(await agentDockerImageExists('propr/agent:tagged'), true);
  assert.equal(await agentDockerImageExists(PIN_ID), true);
  assert.equal(await agentDockerImageExists('propr/agent:absent'), false);
  assert.equal(await agentDockerImageExists(PIN.replace(/[0-9a-f]{64}$/, '0'.repeat(64))), false);
});

test('a cached managed pin is probed directly with real provider health and no legacy bundle request', async () => {
  managedRuntime();
  present(PIN);
  assert.equal(effectiveAgentBaseImage([claude, codex]), PIN);
  let result = reply({ response: 'OK' });
  const { check, prepared, probed } = routeHealthCheck(() => [claude, codex], () => registryServing(PIN), async () => result);
  assert.deepEqual(await check(claude.id), { agentId: claude.id, model: 'claude-haiku-4-5-20251001', status: 'ready' });
  assert.equal((await check(codex.id))?.status, 'ready');
  assert.deepEqual(probed, [PIN, PIN]);

  // Provider errors surface honestly instead of as preparation failures.
  result = reply({ success: false, error: '401 Unauthorized: not logged in' });
  const auth = await check(claude.id, true);
  assert.equal(auth?.status, 'error');
  assert.equal(auth?.errorCode, 'auth_required');
  result = reply({ success: false, error: 'You have hit your usage limit' });
  assert.equal((await check(codex.id, true))?.errorCode, 'rate_limit');

  // A fresh check after login probes again on the same pin.
  result = reply({ response: 'OK' });
  assert.equal((await check(claude.id, true))?.status, 'ready');
  assert.deepEqual(probed, [PIN, PIN, PIN, PIN, PIN]);
  assert.deepEqual(prepared, []);
});

test('a missing pin requests worker preparation of the pin itself, then probes it once pulled', async () => {
  managedRuntime();
  present();
  const { check, prepared, probed, finishPreparation } = routeHealthCheck(() => [claude, codex], () => registryServing(PIN));
  assert.equal((await check(claude.id))?.status, 'preparing');
  assert.equal((await check(codex.id))?.status, 'preparing');
  assert.deepEqual(prepared, [PIN]);
  assert.ok(!prepared.some(image => image.includes(':bundle-')));
  assert.deepEqual(probed, []);
  present(PIN); // The worker pulled the pin by digest.
  finishPreparation();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await check(claude.id))?.status, 'ready');
  assert.deepEqual(probed, [PIN]);
});

test('a pin that fails registry verification reports the honest error without running or preparing elsewhere', async () => {
  managedRuntime();
  present(PIN);
  const failure = `Managed agent image ${PIN} failed verification: its revision label does not match ${REVISION}`;
  const { check, prepared, probed } = routeHealthCheck(() => [claude], () => registryServing(undefined, failure));
  const result = await check(claude.id);
  assert.equal(result?.status, 'error');
  assert.notEqual(result?.errorCode, 'preparation_failed');
  assert.match(result?.error ?? '', /cannot be prepared: Managed agent image .* failed verification/);
  assert.deepEqual(probed, []);
  assert.deepEqual(prepared, []);
});

test('custom CLI versions, generic stacks and mismatched pins keep the generated bundle target', async () => {
  for (const scenario of ['custom', 'generic', 'mismatched'] as const) {
    delete process.env.PROPR_MANAGED_AGENT_IMAGE;
    delete process.env.PROPR_MANAGED_AGENT_REVISION;
    if (scenario !== 'generic') managedRuntime();
    if (scenario === 'mismatched') process.env.PROPR_MANAGED_AGENT_REVISION = 'f'.repeat(40);
    const agents = scenario === 'custom' ? [customClaude, codex] : [claude, codex];
    const bundle = bundleImage(agents);
    assert.equal(effectiveAgentBaseImage(agents), bundle, scenario);
    present(PIN); // A cached pin must not stand in for a different matrix.
    const { check, prepared, probed } = routeHealthCheck(() => agents, () => registryServing(bundle));
    assert.equal((await check(codex.id))?.status, 'preparing', scenario);
    assert.deepEqual(prepared, [bundle], scenario);
    assert.deepEqual(probed, [], scenario);
  }
});

test('configuration changes between pin and custom matrices re-resolve the target before probing', async () => {
  managedRuntime();
  present(PIN);
  let agents = [claude, codex];
  let registry = registryServing(PIN);
  const { check, prepared, probed } = routeHealthCheck(() => agents, () => registry);
  assert.equal((await check(codex.id))?.status, 'ready');

  // A sibling switches to a custom CLI: the shared image becomes a bundle.
  agents = [customClaude, codex];
  registry = registryServing(undefined, 'Unified agent image has not been prepared by the worker');
  assert.equal((await check(codex.id))?.status, 'preparing');
  assert.deepEqual(prepared, [bundleImage(agents)]);

  // Back on defaults, the cached pin serves again without another request.
  agents = [claude, codex];
  registry = registryServing(PIN);
  assert.equal((await check(codex.id, true))?.status, 'ready');
  assert.deepEqual(probed, [PIN, PIN]);
  assert.deepEqual(prepared, [bundleImage([customClaude, codex])]);
});

test('a failed pin preparation stays reported until a fresh check retries the pin', async () => {
  managedRuntime();
  present();
  let preparations = 0;
  const check = createAgentHealthCheck({
    loadAgents: async () => [claude],
    imageExists: image => agentDockerImageExists(image),
    prepareImage: async image => { assert.equal(image, PIN); preparations++; throw new Error('pull failed'); },
    resolveExecutionImage: config => resolveHealthCheckImage(config, registryServing(PIN)),
    createAgent: () => { throw new Error('Must not probe a missing pin'); },
  });
  assert.equal((await check(claude.id))?.status, 'preparing');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await check(claude.id))?.errorCode, 'preparation_failed');
  assert.equal(preparations, 1);
  assert.equal((await check(claude.id, true))?.status, 'preparing');
  assert.equal(preparations, 2);
});

test('real Docker resolves a locally cached repo:tag@digest reference that images -q misses', { skip: !realDocker && 'Docker engine unavailable' }, async t => {
  const env = { ...process.env, PATH: savedEnv.PATH };
  const listing = execFileSync('docker', ['images', '--digests', '--format', '{{.Repository}}:{{.Tag}}@{{.Digest}}'], { encoding: 'utf8', env });
  const reference = listing.split('\n').find(line => /^[^<\s]+:[^<\s@]+@sha256:[0-9a-f]{64}$/.test(line));
  if (!reference) {
    t.skip('No locally cached image carries a repository digest');
    return;
  }
  process.env.PATH = savedEnv.PATH;
  try {
    assert.equal(execFileSync('docker', ['images', '-q', reference], { encoding: 'utf8', env }).trim(), '');
    assert.equal(await agentDockerImageExists(reference), true);
    assert.equal(await agentDockerImageExists(reference.replace(/[0-9a-f]{64}$/, '0'.repeat(64))), false);
  } finally {
    process.env.PATH = `${fakeRoot}${delimiter}${savedEnv.PATH}`;
  }
});
