import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildServiceSpec, resolveHostConfig } from '../docker/launcher/orchestrator.mjs';
import { createDesktopRuntimeManifest } from '../apps/desktop/scripts/desktop-runtime-manifest.mjs';

const REVISION = 'd2a18303b2c4bcab68783edd4f84246dd37a98fe';
const digest = (hex) => `sha256:${hex.repeat(64)}`;
const PIN = `propr/agent:${REVISION}@sha256:2d28d73aa7f5cffc18dc9929f4d910894848346f5ae65690eaa95610f2f33fd9`;
const APP_SERVICES = ['api', 'worker', 'daemon', 'indexing-worker'];
const genericManifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

// The signed manifest exactly as the Desktop release tooling creates it.
function signedManifest(options = {}) {
  return createDesktopRuntimeManifest({ version: '0.9.0', registry: 'propr', images: { redis: 'redis:7-alpine' } }, {
    distribution: 'published',
    sourceRevision: REVISION,
    apiCompatibility: '2026-10-01',
    appImage: `propr/app:${REVISION}@${digest('a')}`,
    uiImage: `propr/ui:${REVISION}@${digest('b')}`,
    agentImage: PIN,
    ...options,
  });
}

function profile(envLines, manifest = signedManifest()) {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-managed-agent-'));
  writeFileSync(join(rootDir, '.env'), [...envLines, ''].join('\n'));
  const manifestPath = join(rootDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { rootDir, manifestPath };
}

// Values Docker applies for NAME: --env-file first, then every later -e.
function effectiveEnv(args, envFileValues, name) {
  let value = envFileValues[name];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-e' && args[index + 1].startsWith(`${name}=`)) value = args[index + 1].slice(name.length + 1);
  }
  return value;
}

test('an existing profile .env with the legacy latest default runs every app container on the signed pin', () => {
  const { rootDir, manifestPath } = profile(['NODE_ENV=production', 'AGENT_DOCKER_IMAGE=propr/agent:latest']);
  // A developer shell value never describes the containers' --env-file.
  const cfg = resolveHostConfig({ rootDir, env: { AGENT_DOCKER_IMAGE: 'shell/agent:ignored' }, manifestPath });
  assert.equal(cfg.images.agent, PIN);
  for (const service of APP_SERVICES) {
    const { args } = buildServiceSpec(cfg, service);
    const fromFile = { AGENT_DOCKER_IMAGE: 'propr/agent:latest' };
    assert.ok(args.indexOf('--env-file') < args.indexOf(`AGENT_DOCKER_IMAGE=${PIN}`), service);
    assert.equal(effectiveEnv(args, fromFile, 'AGENT_DOCKER_IMAGE'), PIN, service);
    assert.equal(effectiveEnv(args, {}, 'PROPR_MANAGED_AGENT_IMAGE'), PIN, service);
    assert.equal(effectiveEnv(args, {}, 'PROPR_MANAGED_AGENT_REVISION'), REVISION, service);
  }
});

test('an intentional custom AGENT_DOCKER_IMAGE is preserved, and an unset value stays unset', () => {
  for (const [line, expected] of [['AGENT_DOCKER_IMAGE=registry.example/agent:custom', 'registry.example/agent:custom'], ['# no override', undefined]]) {
    const { rootDir, manifestPath } = profile([line]);
    const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });
    const { args } = buildServiceSpec(cfg, 'worker');
    assert.equal(effectiveEnv(args, expected ? { AGENT_DOCKER_IMAGE: expected } : {}, 'AGENT_DOCKER_IMAGE'), expected);
    assert.equal(effectiveEnv(args, {}, 'PROPR_MANAGED_AGENT_IMAGE'), PIN);
  }
});

test('generic and unbound manifests keep the existing app container environment', () => {
  const manifests = [
    JSON.parse(JSON.stringify(signedManifest({ agentImage: undefined }))),
    { ...signedManifest(), images: { ...signedManifest().images, agent: `propr/agent:${REVISION}@${digest('c')}` } },
    { ...signedManifest(), images: { ...signedManifest().images, app: `propr/app:${'e'.repeat(40)}@${digest('a')}` } },
  ];
  const cases = [
    resolveHostConfig({ rootDir: profile(['AGENT_DOCKER_IMAGE=propr/agent:latest']).rootDir, env: {}, manifestPath: genericManifestPath }),
    ...manifests.map(manifest => {
      const { rootDir, manifestPath } = profile(['AGENT_DOCKER_IMAGE=propr/agent:latest'], manifest);
      return resolveHostConfig({ rootDir, env: {}, manifestPath });
    }),
  ];
  for (const cfg of cases) {
    assert.equal(cfg.managedAgent, undefined);
    for (const service of APP_SERVICES) {
      const { args } = buildServiceSpec(cfg, service);
      assert.ok(!args.some(arg => /^(AGENT_DOCKER_IMAGE|PROPR_MANAGED_AGENT_IMAGE|PROPR_MANAGED_AGENT_REVISION)=/.test(arg)), service);
    }
  }
});
