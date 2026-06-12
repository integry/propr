import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('built CLI can load bundled orchestrator assets', async () => {
  const build = spawnSync('npm', ['run', 'build', '--workspace', '@propr/cli'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(build.status, 0, build.stderr || build.stdout);

  const orchestratorPath = new URL('../packages/cli/dist/orchestrator/orchestrator.mjs', import.meta.url);
  const manifestPath = new URL('../packages/cli/dist/orchestrator/manifest.json', import.meta.url);
  const envExamplePath = new URL('../packages/cli/dist/assets/env.example.txt', import.meta.url);

  assert.equal(existsSync(orchestratorPath), true);
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(envExamplePath), true);

  const { loadOrchestrator } = await import('../packages/cli/dist/orchestrator/index.js');
  const orchestrator = await loadOrchestrator();

  assert.equal(typeof orchestrator.resolveHostConfig, 'function');
  assert.equal(typeof orchestrator.startStack, 'function');
});
