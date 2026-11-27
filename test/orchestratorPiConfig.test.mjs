import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentCredentialArgs, resolveConfig, validateEnv } from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
const BASE_ENV = { PROPR_DATA_DIR: '/data', PROPR_LOGS_DIR: '/logs', PROPR_REPOS_DIR: '/repos' };

test('launcher mounts HOST_PI_DIR at the same path and points PI_CONFIG_PATH at it', () => {
  const cfg = resolveConfig({ ...BASE_ENV, HOST_PI_DIR: '/home/me/.pi/agent' }, { manifestPath });
  assert.equal(cfg.hostPiDir, '/home/me/.pi/agent');
  const args = agentCredentialArgs(cfg);
  assert.ok(args.includes('/home/me/.pi/agent:/home/me/.pi/agent'));
  assert.ok(args.includes('PI_CONFIG_PATH=/home/me/.pi/agent'));
  assert.ok(agentCredentialArgs(cfg, { readOnly: true }).includes('/home/me/.pi/agent:/home/me/.pi/agent:ro'));
  assert.deepEqual(agentCredentialArgs(resolveConfig(BASE_ENV, { manifestPath })).filter(arg => /pi/i.test(arg)), []);
});

test('launcher validates HOST_PI_DIR as a bind path and requires it with PI_CONFIG_PATH', () => {
  const relative = resolveConfig({ ...BASE_ENV, HOST_PI_DIR: 'pi-agent' }, { manifestPath });
  assert.match(validateEnv(relative).errors.join('\n'), /HOST_PI_DIR/);
  const orphan = resolveConfig({ ...BASE_ENV, PI_CONFIG_PATH: '/home/me/.pi/agent' }, { manifestPath });
  assert.match(validateEnv(orphan).errors.join('\n'), /PI_CONFIG_PATH is set but HOST_PI_DIR is not/);
});
