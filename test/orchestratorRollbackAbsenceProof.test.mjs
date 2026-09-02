import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig, startStackAsync } from '../docker/launcher/orchestrator.mjs';

const eventually = async (operation, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await operation(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  return operation();
};

test('rollback proves exact-name absence and fails closed for unusable Docker proofs', { concurrency: false, timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-rollback-proof-'));
  const executable = join(directory, 'docker');
  const stateDir = join(directory, 'state');
  const marker = join(directory, 'created.marker');
  const previous = {
    path: process.env.PATH,
    state: process.env.PROPR_FAKE_STATE_DIR,
    marker: process.env.PROPR_FAKE_MARKER,
    mode: process.env.PROPR_FAKE_PROOF_MODE,
    skip: process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK,
  };
  await mkdir(stateDir);
  await writeFile(executable, `#!/bin/sh
exec /usr/local/bin/node - -- "$@" <<'PROPR_FAKE_NODE'
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); if (args[0] === '--') args.shift();
const dir = process.env.PROPR_FAKE_STATE_DIR; const mode = process.env.PROPR_FAKE_PROOF_MODE;
const marker = process.env.PROPR_FAKE_MARKER; const target = 'propr-redis';
const file = name => path.join(dir, encodeURIComponent(name) + '.json');
const exists = name => fs.existsSync(file(name));
const read = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const remove = name => { try { fs.unlinkSync(file(name)); } catch {} };
const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (args[0] === 'images') { fs.writeSync(1, 'image-id\\n'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { fs.writeSync(1, '[]\\n'); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'ps') {
  const match = args.join(' ').match(/name=\\^\\/?([^$]+)\\$/);
  if (!match) process.exit(0);
  const name = match[1].replace(/\\\\\./g, '.');
  const proof = args.includes('{{json .Names}}');
  if (!proof) { if (exists(name)) fs.writeSync(1, name + '\\n'); process.exit(0); }
  if (name !== target || !exists(name)) process.exit(0);
  if (mode === 'daemon-failure') { fs.writeSync(2, 'RAW_DOCKER_DAEMON_SECRET\\n'); process.exit(42); }
  if (mode === 'permission-failure') { fs.writeSync(2, 'RAW_DOCKER_PERMISSION_SECRET\\n'); process.exit(13); }
  if (mode === 'query-timeout') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000); process.exit(0); }
  if (mode === 'query-signal') { process.kill(process.pid, 'SIGTERM'); }
  if (mode === 'query-malformed') { fs.writeSync(1, 'RAW_DOCKER_MALFORMED_SECRET\\n'); process.exit(0); }
  if (mode === 'query-truncated') { fs.writeSync(1, 'x'.repeat(20_000)); process.exit(0); }
  if (mode === 'query-ambiguous') { fs.writeSync(1, JSON.stringify('not-' + name) + '\\n'); process.exit(0); }
  if (mode === 'query-duplicate') { const row = JSON.stringify(name) + '\\n'; fs.writeSync(1, row + row); process.exit(0); }
  fs.writeSync(1, JSON.stringify(name) + '\\n'); process.exit(0);
}
if (args[0] === 'run') {
  const name = option('--name'); const labels = {};
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--label') { const [key, ...rest] = args[++i].split('='); labels[key] = rest.join('='); }
  if (args.includes('--rm')) process.exit(0);
  fs.writeFileSync(file(name), JSON.stringify(labels)); fs.writeFileSync(marker, name);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000); process.exit(0);
}
if (args[0] === 'inspect') {
  const name = args[args.length - 1];
  if (!exists(name)) process.exit(1);
  if (name === target && mode === 'exact-not-found') { remove(name); process.exit(1); }
  if (name === target && mode === 'generic-inspect-present') { fs.writeSync(2, 'RAW_DOCKER_INSPECT_SECRET\\n'); process.exit(23); }
  if (name === target && ['daemon-failure','permission-failure','query-timeout','query-signal','query-malformed','query-truncated','query-ambiguous','query-duplicate'].includes(mode)) process.exit(23);
  fs.writeSync(1, JSON.stringify(read(name)) + '\\n'); process.exit(0);
}
if (args[0] === 'stop') {
  const name = args[args.length - 1];
  if (mode === 'disappears-between-checks') { remove(name); process.exit(44); }
  process.exit(0);
}
if (args[0] === 'rm') { remove(args[args.length - 1]); process.exit(0); }
process.exit(0);
PROPR_FAKE_NODE
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previous.path ?? ''}`;
  process.env.PROPR_FAKE_STATE_DIR = stateDir;
  process.env.PROPR_FAKE_MARKER = marker;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';

  const root = join(directory, 'app-data', 'desktop', 'local-stack');
  await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'logs'), { mode: 0o700 });
  await mkdir(join(root, 'repos'), { mode: 0o700 });
  await writeFile(join(root, '.env'), '', { mode: 0o600 });
  const cfg = resolveConfig({}, {
    manifestPath: fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url)),
    envFileLocal: join(root, '.env'), envFileHost: join(root, '.env'),
    hostData: join(root, 'data'), hostLogs: join(root, 'logs'), hostRepos: join(root, 'repos'),
  });

  const run = async mode => {
    await rm(stateDir, { recursive: true, force: true }); await mkdir(stateDir);
    await writeFile(marker, ''); process.env.PROPR_FAKE_PROOF_MODE = mode;
    const logs = []; const controller = new AbortController();
    const operation = startStackAsync(cfg, {
      ui: false, docs: false, tunnel: false, signal: controller.signal,
      onLog: value => logs.push(value),
    });
    const observed = operation.then(() => null, error => error);
    await eventually(async () => assert.equal(await readFile(marker, 'utf8'), 'propr-redis'));
    controller.abort();
    return { error: await observed, logs, remains: existsSync(join(stateDir, 'propr-redis.json')) };
  };

  try {
    for (const mode of ['exact-not-found', 'disappears-between-checks']) {
      const result = await run(mode);
      assert.ok(result.error, `${mode} must preserve the original cancellation`);
      assert.notEqual(result.error?.code, 'PROPR_SETUP_CLEANUP_INCOMPLETE', `${mode} conclusively proves absence`);
      assert.equal(result.remains, false, `${mode} leaves no run-owned container`);
      assert.doesNotMatch(JSON.stringify([result.error, result.logs]), /RAW_DOCKER_/);
    }

    for (const mode of [
      'generic-inspect-present', 'daemon-failure', 'permission-failure',
      'query-timeout', 'query-signal', 'query-malformed', 'query-truncated',
      'query-ambiguous', 'query-duplicate',
    ]) {
      const result = await run(mode);
      assert.equal(result.error?.code, 'PROPR_SETUP_CLEANUP_INCOMPLETE', `${mode} must fail closed`);
      assert.equal(result.remains, true, `${mode} must not mutate without proved ownership`);
      assert.match(String(result.error?.message), /cleanup is incomplete/);
      assert.doesNotMatch(JSON.stringify([result.error, result.logs]), /RAW_DOCKER_/);
    }

    const laterRetry = await run('exact-not-found');
    assert.notEqual(laterRetry.error?.code, 'PROPR_SETUP_CLEANUP_INCOMPLETE');
    assert.equal(laterRetry.remains, false, 'a later successful proof retry settles as cancelled');
  } finally {
    process.env.PATH = previous.path;
    for (const [name, value] of [['PROPR_FAKE_STATE_DIR', previous.state], ['PROPR_FAKE_MARKER', previous.marker], ['PROPR_FAKE_PROOF_MODE', previous.mode], ['PROPR_SKIP_REMOTE_IMAGE_CHECK', previous.skip]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
