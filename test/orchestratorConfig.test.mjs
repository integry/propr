import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig, resolveHostConfig, validateEnv } from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

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

test('empty process env values override stack .env values before defaults apply', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'REDIS_EXTERNAL_PORT=6380',
    'HOST_OPENCODE_XDG_DIR=/from-env-file',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({
    rootDir,
    env: { REDIS_EXTERNAL_PORT: '', HOST_OPENCODE_XDG_DIR: '' },
    manifestPath,
  });

  assert.equal(cfg.redisExternalPort, '');
  assert.equal(cfg.hostOpencodeXdgDir, '');
});

test('empty explicit overrides win over env and defaults', () => {
  const cfg = resolveConfig({
    PROPR_STACK: 'from-env',
    API_PORT: '4400',
    UI_PORT: '5174',
    DOCS_PORT: '9090',
  }, {
    stack: '',
    apiPort: '',
    uiPort: '',
    docsPort: '',
    manifestPath,
  });

  assert.equal(cfg.stack, '');
  assert.equal(cfg.apiPort, '');
  assert.equal(cfg.uiPort, '');
  assert.equal(cfg.docsPort, '');
});

test('UI tunnel defaults: disabled, no public API url, default cloudflared image', () => {
  const cfg = resolveConfig({}, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, false);
  assert.equal(cfg.uiTunnelToken, undefined);
  assert.equal(cfg.proprInstanceId, undefined);
  assert.equal(cfg.uiPublicApiUrl, undefined);
  assert.equal(cfg.cloudflaredImage, 'cloudflare/cloudflared:latest');
  // local-dev defaults stay intact
  assert.equal(cfg.apiPublicUrl, 'http://localhost:4000');
  assert.equal(cfg.frontendUrl, 'http://localhost:5173');
});

test('PROPR_UI_TUNNEL_TOKEN alone enables the tunnel', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'tok-123' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.uiTunnelToken, 'tok-123');
});

test('PROPR_UI_TUNNEL_ENABLED=true enables the tunnel without a token', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: 'true' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.uiTunnelToken, undefined);
});

test('CLI tunnel override wins over token-derived tunnel state', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'tok-123' }, {
    manifestPath,
    uiTunnelEnabled: false,
  });

  assert.equal(cfg.uiTunnelEnabled, false);
  assert.equal(cfg.uiTunnelToken, 'tok-123');
});

test('PROPR_INSTANCE_ID derives the proxy public API url when none is explicit', () => {
  const cfg = resolveConfig({ PROPR_INSTANCE_ID: 'abc123' }, { manifestPath });

  assert.equal(cfg.proprInstanceId, 'abc123');
  assert.equal(cfg.uiPublicApiUrl, 'https://abc123.proxy.propr.dev');
});

test('explicit PROPR_UI_PUBLIC_API_URL wins over the instance-id derivation', () => {
  const cfg = resolveConfig({
    PROPR_INSTANCE_ID: 'abc123',
    PROPR_UI_PUBLIC_API_URL: 'https://custom.example.com',
  }, { manifestPath });

  assert.equal(cfg.uiPublicApiUrl, 'https://custom.example.com');
});

test('PROPR_CLOUDFLARED_IMAGE overrides the default cloudflared image', () => {
  const cfg = resolveConfig({ PROPR_CLOUDFLARED_IMAGE: 'cloudflare/cloudflared:2024.1.0' }, { manifestPath });

  assert.equal(cfg.cloudflaredImage, 'cloudflare/cloudflared:2024.1.0');
});

test('launcher config does not stat host bind paths inside the launcher container', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
    HOST_GH_PRIVATE_KEY: '/host/propr/key.pem',
  }, { manifestPath });

  assert.equal(cfg.validateHostPaths, false);
  assert.deepEqual(validateEnv(cfg).errors, []);
});

test('host config validates stack directories on the host', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), 'API_PORT=4400\n');
  mkdirSync(join(rootDir, 'data'));
  mkdirSync(join(rootDir, 'logs'));

  const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });

  assert.equal(cfg.validateHostPaths, true);
  assert.match(validateEnv(cfg).errors.join('\n'), /PROPR_REPOS_DIR/);
});

test('validateEnv rejects stack names that are not valid Docker names', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_STACK: 'bad name!',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  const errors = validateEnv(cfg).errors.join('\n');
  assert.match(errors, /PROPR_STACK/);
  assert.match(errors, /PROPR_NETWORK/);
});
