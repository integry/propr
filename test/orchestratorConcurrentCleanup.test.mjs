import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('full nine-container cancellation cleans delayed journal entries concurrently and surfaces residuals', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-concurrent-cleanup-'));
  const executable = join(directory, 'docker');
  const stateDir = join(directory, 'containers');
  const marker = join(directory, 'final-status.marker');
  await mkdir(stateDir);
  const previous = {
    path: process.env.PATH,
    state: process.env.PROPR_FAKE_STATE_DIR,
    marker: process.env.PROPR_FAKE_MARKER,
    residual: process.env.PROPR_FAKE_RESIDUAL,
    skip: process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK,
  };
  await writeFile(executable, `#!/bin/sh
exec /usr/local/bin/node - -- "$@" <<'PROPR_FAKE_NODE'
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); if (args[0] === '--') args.shift();
const dir = process.env.PROPR_FAKE_STATE_DIR;
const file = name => path.join(dir, encodeURIComponent(name) + '.json');
const names = () => fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => decodeURIComponent(name.slice(0, -5)));
const read = name => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } };
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === 'images') { fs.writeSync(1, 'image-id\\n'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { fs.writeSync(1, '[]\\n'); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'ps') {
  const match = args.join(' ').match(/name=\\^([^$]+)\\$/);
  if (match) {
    const name = match[1].replace(/^\\//, '');
    if (read(name)) fs.writeSync(1, args.includes('{{json .Names}}') ? JSON.stringify(name) + '\\n' : name + '\\n');
    process.exit(0);
  }
  const current = names();
  const services = ['redis','daemon','worker','analysis-worker','indexing-worker','api','ui','docs','tunnel'];
  if (services.every(service => current.includes('propr-' + service))) {
    fs.writeFileSync(process.env.PROPR_FAKE_MARKER, 'ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
  for (const name of current) fs.writeSync(1, name + '\\trunning\\tUp\\t\\n');
  process.exit(0);
}
if (args[0] === 'run') {
  const name = option('--name'); const labels = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') { const [key, ...value] = args[++i].split('='); labels[key] = value.join('='); }
  fs.writeFileSync(file(name), JSON.stringify(labels));
  if (args.includes('--rm')) fs.unlinkSync(file(name));
  fs.writeSync(1, name + '\\n'); process.exit(0);
}
if (args[0] === 'inspect') {
  const value = read(args[args.length - 1]); if (!value) process.exit(1);
  fs.writeSync(1, JSON.stringify(value) + '\\n'); process.exit(0);
}
if (args[0] === 'stop') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800); process.exit(0); }
if (args[0] === 'rm') {
  const name = args[args.length - 1];
  if (name !== process.env.PROPR_FAKE_RESIDUAL) { try { fs.unlinkSync(file(name)); } catch {} }
  process.exit(0);
}
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
  const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'fake-tunnel-token' }, {
    manifestPath,
    envFileLocal: join(root, '.env'), envFileHost: join(root, '.env'),
    hostData: join(root, 'data'), hostLogs: join(root, 'logs'), hostRepos: join(root, 'repos'),
    uiTunnelEnabled: true,
  });
  const run = async (residual) => {
    await rm(stateDir, { recursive: true, force: true }); await mkdir(stateDir);
    await writeFile(marker, '');
    if (residual) process.env.PROPR_FAKE_RESIDUAL = residual; else delete process.env.PROPR_FAKE_RESIDUAL;
    const controller = new AbortController();
    const operation = startStackAsync(cfg, { ui: true, docs: true, tunnel: true, signal: controller.signal });
    const observed = operation.then(() => null, failure => failure);
    await eventually(async () => assert.equal(await readFile(marker, 'utf8'), 'ready'));
    const cancelledAt = Date.now();
    controller.abort();
    const error = await observed;
    return { error, elapsed: Date.now() - cancelledAt, names: (await readdir(stateDir)).filter(name => name.endsWith('.json')) };
  };
  try {
    const clean = await run(undefined);
    assert.ok(clean.error, 'cancellation must reject');
    assert.deepEqual(clean.names, []);
    assert.ok(clean.elapsed < 9_000, `concurrent cleanup took ${clean.elapsed}ms`);

    const residual = await run('propr-ui');
    assert.equal(residual.error?.code, 'PROPR_SETUP_CLEANUP_INCOMPLETE');
    assert.match(String(residual.error?.message), /cleanup is incomplete|run-owned containers remain/);
    assert.deepEqual(residual.names, ['propr-ui.json']);
  } finally {
    process.env.PATH = previous.path;
    for (const [name, value] of [['PROPR_FAKE_STATE_DIR', previous.state], ['PROPR_FAKE_MARKER', previous.marker], ['PROPR_FAKE_RESIDUAL', previous.residual], ['PROPR_SKIP_REMOTE_IMAGE_CHECK', previous.skip]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
