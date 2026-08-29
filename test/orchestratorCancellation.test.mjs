import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dockerAsync, resolveConfig, startStackAsync } from '../docker/launcher/orchestrator.mjs';

const eventually = async (operation, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await operation(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  return operation();
};

test('dockerAsync cancellation terminates the spawned process group before settling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-docker-cancel-'));
  const executable = join(directory, 'docker');
  const descendantPath = join(directory, 'descendant.pid');
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  process.env.PROPR_TEST_DESCENDANT_PATH = descendantPath;
  try {
    await writeFile(executable, '#!/bin/sh\nsleep 30 &\necho "$!" > "$PROPR_TEST_DESCENDANT_PATH"\nwait\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const controller = new AbortController();
    const operation = dockerAsync(['pull', 'example'], { signal: controller.signal });
    const descendantPid = Number(await eventually(async () => readFile(descendantPath, 'utf8')));
    controller.abort();
    const result = await operation;
    assert.equal(result.error?.code, 'ABORT_ERR');
    await eventually(async () => {
      try {
        const state = (await readFile(`/proc/${descendantPid}/stat`, 'utf8')).split(' ')[2];
        assert.equal(state, 'Z', 'descendant must be terminated (a container PID 1 may leave it as a zombie)');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
  } finally {
    process.env.PATH = previousPath;
    delete process.env.PROPR_TEST_DESCENDANT_PATH;
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup abort cleans daemon-created run-owned containers and leaves preexisting and foreign containers untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-docker-daemon-cancel-'));
  const executable = join(directory, 'docker');
  const statePath = join(directory, 'containers.json');
  const markerPath = join(directory, 'created.marker');
  const previous = { path: process.env.PATH, state: process.env.PROPR_FAKE_STATE, marker: process.env.PROPR_FAKE_MARKER, target: process.env.PROPR_FAKE_ABORT_TARGET, skip: process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK };
  const initial = {
    'propr-api': { 'propr.stack': 'propr', 'propr.service': 'api', foreign: 'preexisting', __running: false },
    foreign: { foreign: 'true', __running: true },
  };
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(executable, `#!/bin/sh
exec /usr/local/bin/node - -- "$@" <<'PROPR_FAKE_NODE'
const fs = require('node:fs');
const args = process.argv.slice(2); if (args[0] === '--') args.shift();
const statePath = process.env.PROPR_FAKE_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = value => fs.writeFileSync(statePath, JSON.stringify(value));
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (args[0] === 'images') { console.log('image-id'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { console.log('[]'); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'ps') {
  const match = args.join(' ').match(/name=\\^([^$]+)\\$/);
  const name = match && match[1];
  const entry = name && load()[name];
  if (entry && (args.includes('-a') || entry.__running)) console.log(name);
  process.exit(0);
}
if (args[0] === 'inspect') {
  const name = args[args.length - 1];
  const labels = load()[name];
  if (!labels) process.exit(1);
  console.log(JSON.stringify(labels));
  process.exit(0);
}
if (args[0] === 'run') {
  const name = option('--name');
  const labels = {};
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--label') { const [key, ...rest] = args[++i].split('='); labels[key] = rest.join('='); }
  labels.__running = true;
  const state = load(); state[name] = labels; save(state);
  fs.writeFileSync(process.env.PROPR_FAKE_MARKER, name);
  if (name === process.env.PROPR_FAKE_ABORT_TARGET) setTimeout(() => {}, 30_000);
  else { if (args.includes('--rm')) { delete state[name]; save(state); } console.log(name); process.exit(0); }
} else if (args[0] === 'stop') process.exit(0);
else if (args[0] === 'rm') { const name = args[args.length - 1]; const state = load(); delete state[name]; save(state); process.exit(0); }
else process.exit(0);
PROPR_FAKE_NODE
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previous.path ?? ''}`;
  process.env.PROPR_FAKE_STATE = statePath;
  process.env.PROPR_FAKE_MARKER = markerPath;
  process.env.PROPR_FAKE_ABORT_TARGET = 'propr-redis';
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
  const cfg = resolveConfig({}, { manifestPath, envFileLocal: '/stack/.env', envFileHost: '/stack/.env', hostData: '/stack/data', hostLogs: '/stack/logs', hostRepos: '/stack/repos' });
  try {
    const controller = new AbortController();
    const operation = startStackAsync(cfg, { ui: false, docs: false, tunnel: false, signal: controller.signal });
    const rejected = assert.rejects(operation);
    await Promise.race([
      eventually(async () => { assert.equal(await readFile(markerPath, 'utf8'), 'propr-redis'); }),
      operation.then(() => { throw new Error('stack unexpectedly completed'); }, error => { throw error; }),
    ]);
    controller.abort();
    await rejected;
    const settled = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(Object.keys(settled).sort(), ['foreign', 'propr-api']);
    assert.equal(settled['propr-api'].foreign, 'preexisting');
    assert.equal(settled.foreign.foreign, 'true');
    assert.equal(Object.values(settled).some(labels => labels['propr.setup-run']), false);
  } finally {
    process.env.PATH = previous.path;
    for (const [name, value] of [['PROPR_FAKE_STATE', previous.state], ['PROPR_FAKE_MARKER', previous.marker], ['PROPR_FAKE_ABORT_TARGET', previous.target], ['PROPR_SKIP_REMOTE_IMAGE_CHECK', previous.skip]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
