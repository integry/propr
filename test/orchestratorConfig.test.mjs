import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveHostConfig } from '../docker/launcher/orchestrator.mjs';

const manifestPath = new URL('../docker/launcher/manifest.json', import.meta.url).pathname;

test('resolveHostConfig honors stack .env values for ports and docs', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'API_PORT=4400',
    'UI_PORT=5174',
    'DOCS_PORT=9090',
    'REDIS_EXTERNAL_PORT=6380',
    'DOCS_ENABLED=true',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });

  assert.equal(cfg.apiPort, '4400');
  assert.equal(cfg.uiPort, '5174');
  assert.equal(cfg.docsPort, '9090');
  assert.equal(cfg.redisExternalPort, '6380');
  assert.equal(cfg.docsEnabled, true);
});

test('process env values override stack .env values', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'API_PORT=4400',
    'DOCS_ENABLED=true',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({
    rootDir,
    env: { API_PORT: '4500', DOCS_ENABLED: 'false' },
    manifestPath,
  });

  assert.equal(cfg.apiPort, '4500');
  assert.equal(cfg.docsEnabled, false);
});
