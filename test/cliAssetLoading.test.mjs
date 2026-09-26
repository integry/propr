import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const orchestratorPath = new URL('../packages/cli/dist/orchestrator/orchestrator.mjs', import.meta.url);
const manifestPath = new URL('../packages/cli/dist/orchestrator/manifest.json', import.meta.url);
const envExamplePath = new URL('../packages/cli/dist/assets/env.example.txt', import.meta.url);
const skillPath = new URL('../packages/cli/dist/skill/propr/SKILL.md', import.meta.url);
const skillMetadataPath = new URL('../packages/cli/dist/skill/propr/agents/openai.yaml', import.meta.url);

const distReady = existsSync(orchestratorPath) && existsSync(manifestPath) && existsSync(envExamplePath) && existsSync(skillPath) && existsSync(skillMetadataPath);

// Building the CLI workspace inside a unit test is slow and environment-
// dependent, so it only happens when explicitly requested. CI should build
// before running tests; this test then verifies the build output directly.
const buildOnDemand = process.env.PROPR_TEST_BUILD_CLI === '1';

test('built CLI can load bundled orchestrator assets', { skip: !distReady && !buildOnDemand ? 'CLI not built — run `npm run build --workspace @propr/cli` first, or set PROPR_TEST_BUILD_CLI=1' : false }, async () => {
  if (!distReady) {
    const build = spawnSync('npm', ['run', 'build', '--workspace', '@propr/cli'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  assert.equal(existsSync(orchestratorPath), true);
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(envExamplePath), true);
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(skillMetadataPath), true);

  const { loadOrchestrator } = await import('../packages/cli/dist/orchestrator/index.js');
  const orchestrator = await loadOrchestrator();

  assert.equal(typeof orchestrator.resolveHostConfig, 'function');
  assert.equal(typeof orchestrator.startStack, 'function');
});
