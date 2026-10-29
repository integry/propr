import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentCredentialArgs, buildServiceSpec, defaultHostClaudeJson, resolveConfig, validateEnv,
} from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

function envValues(args, name) {
  return args.flatMap((arg, i) => (arg === '-e' && args[i + 1]?.startsWith(`${name}=`) ? [args[i + 1].slice(name.length + 1)] : []));
}

function hostHome() {
  const home = mkdtempSync(join(tmpdir(), 'propr-claude-json-'));
  mkdirSync(join(home, '.claude'));
  return home;
}

const BASE_ENV = { PROPR_DATA_DIR: '/data', PROPR_LOGS_DIR: '/logs', PROPR_REPOS_DIR: '/repos' };

test('the default Claude config is the .claude.json next to HOST_CLAUDE_DIR', () => {
  assert.equal(defaultHostClaudeJson('/root/.claude'), '/root/.claude.json');
  assert.equal(defaultHostClaudeJson('/home/me/.claude/'), '/home/me/.claude.json');
});

test('launcher mounts an existing host .claude.json read-only into the worker and api at the same path', () => {
  const home = hostHome();
  const claudeJson = join(home, '.claude.json');
  writeFileSync(claudeJson, '{"userID":"host"}');
  const cfg = resolveConfig({ ...BASE_ENV, HOST_CLAUDE_DIR: join(home, '.claude') }, { manifestPath });
  assert.equal(cfg.hostClaudeJson, claudeJson);

  for (const service of ['worker', 'api']) {
    const { args } = buildServiceSpec(cfg, service);
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    assert.ok(mounts.includes(`type=bind,source=${claudeJson},target=${claudeJson},readonly`), service);
    assert.deepEqual(envValues(args, 'CLAUDE_JSON_PATH'), [claudeJson], service);
    assert.equal(args.some(arg => arg.startsWith(`${claudeJson}:`)), false, `${service} must not bind it read-write`);
  }
  assert.deepEqual(validateEnv(cfg).errors.filter(error => /CLAUDE_JSON/.test(error)), []);
});

test('launcher adds no Claude config mount when the host has no .claude.json', () => {
  const home = hostHome();
  const cfg = resolveConfig({ ...BASE_ENV, HOST_CLAUDE_DIR: join(home, '.claude') }, { manifestPath });
  assert.equal(cfg.hostClaudeJson, undefined);
  const args = agentCredentialArgs(cfg);
  assert.deepEqual(envValues(args, 'CLAUDE_CONFIG_PATH'), [join(home, '.claude')]);
  assert.deepEqual(envValues(args, 'CLAUDE_JSON_PATH'), []);
  assert.equal(args.includes('--mount'), false);
  // Credential directories keep their existing HOST:HOST mounts.
  assert.ok(args.includes(`${join(home, '.claude')}:${join(home, '.claude')}`));
});

test('HOST_CLAUDE_JSON overrides the derived path and is validated on the host', () => {
  const home = hostHome();
  writeFileSync(join(home, '.claude.json'), '{}');
  const override = join(home, 'custom-claude.json');
  writeFileSync(override, '{}');
  const env = { ...BASE_ENV, HOST_CLAUDE_DIR: join(home, '.claude'), HOST_CLAUDE_JSON: override };
  const cfg = resolveConfig(env, { manifestPath });
  assert.equal(cfg.hostClaudeJson, override);
  assert.deepEqual(envValues(agentCredentialArgs(cfg, { readOnly: true }), 'CLAUDE_JSON_PATH'), [override]);

  const missing = resolveConfig({ ...env, HOST_CLAUDE_JSON: join(home, 'missing.json') }, { manifestPath, validateHostPaths: true });
  assert.match(validateEnv(missing).errors.join('\n'), /HOST_CLAUDE_JSON .* is not a file/);
  // A launcher running in a container cannot see host files, so it trusts the
  // explicit path (and `--mount` fails loudly) rather than dropping it.
  const containerized = resolveConfig({ ...env, HOST_CLAUDE_JSON: '/host/home/.claude.json' }, { manifestPath });
  assert.deepEqual(envValues(agentCredentialArgs(containerized), 'CLAUDE_JSON_PATH'), ['/host/home/.claude.json']);
  assert.deepEqual(validateEnv(containerized).errors.filter(error => /HOST_CLAUDE_JSON/.test(error)), []);
  const relative = resolveConfig({ ...env, HOST_CLAUDE_JSON: 'claude.json' }, { manifestPath });
  assert.match(validateEnv(relative).errors.join('\n'), /HOST_CLAUDE_JSON must be an absolute path/);
});

test('Claude config mount quotes paths that contain commas', () => {
  const args = agentCredentialArgs({ hostClaudeJson: '/home/a,b/.claude.json' });
  assert.deepEqual(args.slice(0, 2), ['--mount', 'type=bind,"source=/home/a,b/.claude.json","target=/home/a,b/.claude.json",readonly']);
});
