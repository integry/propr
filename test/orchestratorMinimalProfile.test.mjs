import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALL_IN_ONE_SERVICE, CORE_SERVICES, buildServiceSpec, parseStackStatus, resolveConfig,
  stackServicesToStart, validateEnv,
} from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
const BASE_ENV = { PROPR_DATA_DIR: '/data', PROPR_LOGS_DIR: '/logs', PROPR_REPOS_DIR: '/repos', PROPR_ENV_FILE: '/stack/.env' };

function envValues(args, name) {
  return args.flatMap((arg, i) => (arg === '-e' && args[i + 1]?.startsWith(`${name}=`) ? [args[i + 1].slice(name.length + 1)] : []));
}

function volumes(args) {
  return args.filter((_, i) => args[i - 1] === '-v');
}

function minimal(env = {}, overrides = {}) {
  return resolveConfig({ ...BASE_ENV, ...env }, { manifestPath, ...overrides });
}

test('the full multi-container profile stays the default and is unchanged', () => {
  const cfg = resolveConfig(BASE_ENV, { manifestPath });
  assert.equal(cfg.profile, 'full');
  assert.deepEqual(stackServicesToStart(cfg, { ui: true, docs: false, tunnel: false }), [...CORE_SERVICES, 'ui']);
  assert.equal(cfg.frontendUrl, 'http://localhost:5173');
  assert.deepEqual(buildServiceSpec(cfg, 'api').command, ['node', 'dist/packages/api/server.js']);
});

test('PROPR_PROFILE=minimal (or the CLI override) starts redis + all-in-one only', () => {
  for (const cfg of [minimal({ PROPR_PROFILE: 'minimal' }), minimal({}, { profile: 'minimal' }), minimal({ PROPR_PROFILE: ' Minimal ' })]) {
    assert.equal(cfg.profile, 'minimal');
    // The UI toggle has no container to start in this profile.
    assert.deepEqual(stackServicesToStart(cfg, { ui: true, docs: false, tunnel: false }), ['redis', ALL_IN_ONE_SERVICE]);
  }
  const cfg = minimal({ PROPR_PROFILE: 'minimal', PROPR_UI_TUNNEL_TOKEN: 'token', PROPR_INSTANCE_ID: 'abc123' });
  assert.deepEqual(stackServicesToStart(cfg, { ui: true, docs: true, tunnel: true }), ['redis', ALL_IN_ONE_SERVICE, 'docs', 'tunnel']);
});

test('PROPR_INDEXING=separate keeps the indexing worker as its own container', () => {
  const cfg = minimal({ PROPR_PROFILE: 'minimal', PROPR_INDEXING: 'separate' });
  assert.deepEqual(stackServicesToStart(cfg, { ui: false, docs: false, tunnel: false }), ['redis', ALL_IN_ONE_SERVICE, 'indexing-worker']);
  assert.deepEqual(envValues(buildServiceSpec(cfg, ALL_IN_ONE_SERVICE).args, 'PROPR_INDEXING'), ['separate']);
});

test('the all-in-one container runs allInOne.js with the union of component mounts and serves the UI', () => {
  const cfg = minimal({ PROPR_PROFILE: 'minimal' });
  const spec = buildServiceSpec(cfg, ALL_IN_ONE_SERVICE);
  assert.equal(spec.image, cfg.images.app);
  assert.deepEqual(spec.command, ['node', 'dist/src/allInOne.js']);
  const mounts = volumes(spec.args);
  for (const mount of [
    '/data:/usr/src/app/data', '/logs:/usr/src/app/logs', '/repos:/usr/src/app/repos',
    '/stack/.env:/usr/src/app/.env:ro', '/tmp/pr-worktrees:/tmp/pr-worktrees',
    '/tmp/claude-logs:/tmp/claude-logs', '/tmp/propr-egress:/tmp/propr-egress',
    '/var/run/docker.sock:/var/run/docker.sock',
  ]) assert.ok(mounts.includes(mount), mount);
  assert.equal(new Set(mounts).size, mounts.length, 'no duplicate mounts');
  assert.ok(spec.args.includes(`${cfg.apiPort}:4000`));
  assert.deepEqual(envValues(spec.args, 'PROPR_SERVE_UI'), ['1']);
  assert.deepEqual(envValues(spec.args, 'PROPR_SERVED_UI_API_URL'), ['']);
  assert.deepEqual(envValues(spec.args, 'PROPR_INDEXING'), ['inline']);
  // Same-origin: the frontend is the API's public origin, not a UI port.
  assert.equal(cfg.frontendUrl, cfg.apiPublicUrl);
  assert.deepEqual(envValues(spec.args, 'FRONTEND_URL'), [cfg.apiPublicUrl]);
  assert.deepEqual(envValues(spec.args, 'GITHUB_BOT_USERNAME'), [cfg.githubBotUsername]);
});

test('an explicit FRONTEND_URL still wins in the minimal profile', () => {
  const cfg = minimal({ PROPR_PROFILE: 'minimal', FRONTEND_URL: 'https://ui.example.com' });
  assert.equal(cfg.frontendUrl, 'https://ui.example.com');
});

test('the tunnel sidecar joins the all-in-one network namespace in the minimal profile', () => {
  const env = { PROPR_UI_TUNNEL_TOKEN: 'token', PROPR_INSTANCE_ID: 'abc123' };
  assert.equal(buildServiceSpec(minimal(env), 'tunnel').networkMode, 'container:propr-api');
  assert.equal(buildServiceSpec(minimal({ ...env, PROPR_PROFILE: 'minimal' }), 'tunnel').networkMode, `container:propr-${ALL_IN_ONE_SERVICE}`);
});

test('validateEnv rejects unknown profiles and indexing modes', () => {
  assert.ok(validateEnv(minimal({ PROPR_PROFILE: 'tiny' })).errors.some(error => /PROPR_PROFILE \("tiny"\)/.test(error)));
  assert.ok(validateEnv(minimal({ PROPR_PROFILE: 'minimal', PROPR_INDEXING: 'later' })).errors.some(error => /PROPR_INDEXING \("later"\)/.test(error)));
  const ok = validateEnv(minimal({ PROPR_PROFILE: 'minimal', PROPR_INDEXING: 'off' })).errors;
  assert.deepEqual(ok.filter(error => /PROPR_PROFILE|PROPR_INDEXING/.test(error)), []);
});

test('status lists the profile services, and the other profile only while its containers exist', () => {
  const full = resolveConfig(BASE_ENV, { manifestPath });
  const fullStatus = parseStackStatus(full, '');
  assert.equal(fullStatus.services.some(s => s.service === ALL_IN_ONE_SERVICE), false);

  const cfg = minimal({ PROPR_PROFILE: 'minimal' });
  const status = parseStackStatus(cfg, [
    'propr-redis\trunning\tUp 1 minute\t',
    `propr-${ALL_IN_ONE_SERVICE}\trunning\tUp 1 minute\t127.0.0.1:4000->4000/tcp`,
    'propr-worker\texited\tExited (0)\t',
  ].join('\n'));
  assert.deepEqual(status.services.map(s => s.service), ['redis', ALL_IN_ONE_SERVICE, 'docs', 'tunnel', 'worker']);
  assert.equal(status.running, true);
  // A lone all-in-one container counts as a running stack for either profile.
  assert.equal(parseStackStatus(full, `propr-${ALL_IN_ONE_SERVICE}\trunning\tUp\t`).running, true);
});
