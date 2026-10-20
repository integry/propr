import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig, buildServiceSpec } from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
const APP_SERVICES = ['daemon', 'worker', 'indexing-worker', 'api'];

function writeEnvFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'propr-instance-id-')), '.env');
  writeFileSync(path, contents);
  return path;
}

// The container's final environment as Docker assembles it from a `docker run`
// argument list: every --env-file entry (Docker's literal parsing) followed by
// every -e entry, without deduplication — which is how `.Config.Env` records it.
function dockerRunEnv(args) {
  const env = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--env-file') {
      for (const rawLine of readFileSync(args[i + 1], 'utf8').split('\n')) {
        const line = rawLine.replace(/\r$/, '').trimStart();
        if (line && !line.startsWith('#') && line.includes('=')) env.push(line);
      }
    } else if (args[i] === '-e') {
      env.push(args[i + 1]);
    }
  }
  return env;
}

function instanceIdBindings(args) {
  return dockerRunEnv(args).filter((entry) => entry.startsWith('PROPR_INSTANCE_ID='));
}

function hostedConfig(envFileContents, env = {}) {
  return resolveConfig({
    PROPR_LAUNCHER_ENV_FILE: writeEnvFile(envFileContents),
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
    PROPR_ENV_FILE: '/host/propr/.env',
    ...env,
  }, { manifestPath });
}

test('hosted api container receives exactly one PROPR_INSTANCE_ID binding from the shared env file', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID=abc123\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), ['PROPR_INSTANCE_ID=abc123']);
  assert.ok(!args.some((arg) => arg.startsWith('PROPR_INSTANCE_ID=')), 'no command-line identity override');
  // Tunnel URL derivation and the remaining tunnel env are unchanged.
  const env = dockerRunEnv(args);
  assert.ok(env.includes('PROPR_UI_PUBLIC_API_URL=https://t-abc123.propr.dev'));
  assert.ok(env.includes('API_PUBLIC_URL=https://t-abc123.propr.dev'));
  assert.ok(env.includes('PROPR_UI_TUNNEL_ENABLED=true'));
});

test('every managed app service exposes exactly one PROPR_INSTANCE_ID entry', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID=abc123\n');
  for (const service of APP_SERVICES) {
    assert.deepEqual(instanceIdBindings(buildServiceSpec(cfg, service).args), ['PROPR_INSTANCE_ID=abc123'], service);
  }
});

test('api still lowercases a mixed-case env file instance id on the command line', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID=AbC123\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), ['PROPR_INSTANCE_ID=AbC123', 'PROPR_INSTANCE_ID=abc123']);
  assert.equal(cfg.uiPublicApiUrl, 'https://t-abc123.propr.dev');
});

test('api keeps the override when Docker would bind a different literal than the parsed value', () => {
  // Docker does not strip quotes from --env-file values, so the container would
  // otherwise see `"abc123"` rather than the canonical id.
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID="abc123"\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args).at(-1), 'PROPR_INSTANCE_ID=abc123');
});

test('api keeps the override when the instance id comes only from the process environment', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\n', { PROPR_INSTANCE_ID: 'abc123' });
  assert.deepEqual(instanceIdBindings(buildServiceSpec(cfg, 'api').args), ['PROPR_INSTANCE_ID=abc123']);

  const differing = hostedConfig('NODE_ENV=production\nPROPR_INSTANCE_ID=old\n', { PROPR_INSTANCE_ID: 'new' });
  assert.deepEqual(instanceIdBindings(buildServiceSpec(differing, 'api').args).at(-1), 'PROPR_INSTANCE_ID=new');
});

test('local stack without an instance id gets no PROPR_INSTANCE_ID binding', () => {
  const cfg = hostedConfig('NODE_ENV=production\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), []);
  assert.ok(dockerRunEnv(args).includes('PROPR_UI_TUNNEL_ENABLED=false'));
});
