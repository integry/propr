import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getStackStatusAsync,
  isLifecycleStackRunningAsync,
  recoverStackAsync,
  resolveHostConfig,
  startStackAsync,
  stopLifecycleStackAsync,
} from '../docker/launcher/orchestrator.mjs';

test('fixed-root lifecycle safely survives stop/start/restart and rejects replacements', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-lifecycle-recovery-'));
  const executable = join(directory, 'docker');
  const statePath = join(directory, 'containers.json');
  const oldPath = process.env.PATH;
  const oldState = process.env.PROPR_FAKE_STATE;
  const oldReplaceOnStop = process.env.PROPR_FAKE_REPLACE_ON_STOP;
  const oldSkip = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  await writeFile(statePath, '{}');
  await writeFile(executable, `#!/bin/sh
exec /usr/local/bin/node - -- "$@" <<'PROPR_FAKE_NODE'
const fs = require('node:fs');
const args = process.argv.slice(2); if (args[0] === '--') args.shift();
const statePath = process.env.PROPR_FAKE_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = state => fs.writeFileSync(statePath, JSON.stringify(state));
const byId = (state, id) => Object.entries(state).find(([, entry]) => entry.id === id);
const idFor = name => Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === 'images') { fs.writeSync(1, 'image-id\\n'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { fs.writeSync(1, '[]\\n'); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'ps') {
  const state = load();
  const match = args.join(' ').match(/name=\\^([^$]+)\\$/);
  if (match) {
    const entry = state[match[1]];
    if (entry && (args.includes('-a') || entry.running)) fs.writeSync(1, match[1] + '\\n');
    process.exit(0);
  }
  for (const [name, entry] of Object.entries(state)) {
    fs.writeSync(1, name + '\\t' + (entry.running ? 'running' : 'exited') + '\\t' + (entry.running ? 'Up' : 'Exited') + '\\t\\n');
  }
  process.exit(0);
}
if (args[0] === 'run') {
  const name = option('--name'); const labels = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') { const [key, ...value] = args[++i].split('='); labels[key] = value.join('='); }
  const binds = args.flatMap((value, index) => value === '-v' ? [args[index + 1]] : []);
  const state = load(); state[name] = { id: idFor(name), labels, binds, running: true }; save(state);
  if (args.includes('--rm')) { delete state[name]; save(state); }
  fs.writeSync(1, name + '\\n'); process.exit(0);
}
if (args[0] === 'inspect') {
  const name = args[args.length - 1]; const entry = load()[name];
  if (!entry) { fs.writeSync(2, 'Error: No such object: ' + name + '\\n'); process.exit(1); }
  fs.writeSync(1, JSON.stringify([{ Id: entry.id, Name: '/' + name, Config: { Labels: entry.labels }, HostConfig: { Binds: entry.binds }, State: { Running: entry.running } }]) + '\\n');
  process.exit(0);
}
if (args[0] === 'stop') {
  const state = load(); const found = byId(state, args[args.length - 1]);
  if (found && process.env.PROPR_FAKE_REPLACE_ON_STOP === found[0]) {
    state[found[0]] = { id: 'e'.repeat(64), labels: { 'propr.stack': 'foreign', 'propr.service': found[1].labels['propr.service'] }, binds: [], running: false, sentinel: 'replacement-untouched' };
  } else if (found) found[1].running = false;
  save(state); process.exit(found ? 0 : 1);
}
if (args[0] === 'start') { const state = load(); const found = byId(state, args[args.length - 1]); if (!found) process.exit(1); found[1].running = true; save(state); process.exit(0); }
if (args[0] === 'rm') { const state = load(); delete state[args[args.length - 1]]; save(state); process.exit(0); }
process.exit(0);
PROPR_FAKE_NODE
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${oldPath ?? ''}`;
  process.env.PROPR_FAKE_STATE = statePath;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  const rootDir = join(directory, 'app-data', 'desktop', 'local-stack');
  await mkdir(join(rootDir, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(rootDir, 'logs'), { mode: 0o700 });
  await mkdir(join(rootDir, 'repos'), { mode: 0o700 });
  await writeFile(join(rootDir, '.env'), 'DOCS_ENABLED=true\n', { mode: 0o600 });
  const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
  const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });
  try {
    await startStackAsync(cfg, { ui: true, docs: true, tunnel: false });
    assert.equal((await getStackStatusAsync(cfg)).running, true, 'setup then reopen status');
    assert.equal(await isLifecycleStackRunningAsync(cfg), true);

    assert.deepEqual(await stopLifecycleStackAsync(cfg), { failed: [] });
    assert.equal((await getStackStatusAsync(cfg)).running, false);
    assert.equal(await isLifecycleStackRunningAsync(cfg), false);
    assert.deepEqual(await recoverStackAsync(cfg, { ui: true, docs: true, tunnel: false }), { recovered: true });
    assert.equal((await getStackStatusAsync(cfg)).running, true);

    const partial = JSON.parse(await readFile(statePath, 'utf8'));
    partial['propr-worker'].running = false;
    partial['propr-ui'].running = false;
    partial['propr-docs'].running = false;
    await writeFile(statePath, JSON.stringify(partial));
    await recoverStackAsync(cfg, { ui: true, docs: true, tunnel: false });
    const recovered = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(recovered['propr-worker'].running, true);
    assert.equal(recovered['propr-ui'].running, true);
    assert.equal(recovered['propr-docs'].running, true);

    await stopLifecycleStackAsync(cfg);
    await recoverStackAsync(cfg, { ui: true, docs: true, tunnel: false });
    assert.equal((await getStackStatusAsync(cfg)).running, true, 'restart sequence');

    await stopLifecycleStackAsync(cfg);
    const foreign = JSON.parse(await readFile(statePath, 'utf8'));
    foreign['propr-api'] = { id: 'f'.repeat(64), labels: { 'propr.stack': 'foreign', 'propr.service': 'api' }, binds: [], running: false, sentinel: 'untouched' };
    await writeFile(statePath, JSON.stringify(foreign));
    await assert.rejects(isLifecycleStackRunningAsync(cfg), /left untouched/);
    await assert.rejects(recoverStackAsync(cfg, { ui: true, docs: true, tunnel: false }), /left untouched/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8'))['propr-api'].sentinel, 'untouched');

    const mismatched = JSON.parse(await readFile(statePath, 'utf8'));
    mismatched['propr-api'] = { ...recovered['propr-api'], running: false, binds: ['/foreign:/usr/src/app/.env:ro'], sentinel: 'mismatch' };
    await writeFile(statePath, JSON.stringify(mismatched));
    await assert.rejects(recoverStackAsync(cfg, { ui: true, docs: true, tunnel: false }), /fixed-root binds/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8'))['propr-api'].sentinel, 'mismatch');

    await writeFile(statePath, JSON.stringify(recovered));
    process.env.PROPR_FAKE_REPLACE_ON_STOP = 'propr-worker';
    const replacedStop = await stopLifecycleStackAsync(cfg);
    assert.ok(replacedStop.failed.includes('propr-worker'));
    assert.equal(JSON.parse(await readFile(statePath, 'utf8'))['propr-worker'].sentinel, 'replacement-untouched');
  } finally {
    process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.PROPR_FAKE_STATE; else process.env.PROPR_FAKE_STATE = oldState;
    if (oldReplaceOnStop === undefined) delete process.env.PROPR_FAKE_REPLACE_ON_STOP; else process.env.PROPR_FAKE_REPLACE_ON_STOP = oldReplaceOnStop;
    if (oldSkip === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = oldSkip;
    await rm(directory, { recursive: true, force: true });
  }
});
