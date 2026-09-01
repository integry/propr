import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dockerAsync, resolveConfig, startStackAsync } from '../docker/launcher/orchestrator.mjs';

const eventually = async (operation, timeoutMs = 15_000) => {
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

test('setup abort during launch and final status cleans run-owned containers and leaves preexisting and foreign containers untouched', { concurrency: false, timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-docker-daemon-cancel-'));
  const executable = join(directory, 'docker');
  const statePath = join(directory, 'containers.json');
  const markerPath = join(directory, 'created.marker');
  const previous = { path: process.env.PATH, state: process.env.PROPR_FAKE_STATE, marker: process.env.PROPR_FAKE_MARKER, target: process.env.PROPR_FAKE_ABORT_TARGET, stopMode: process.env.PROPR_FAKE_STOP_MODE, skip: process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK };
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
const save = value => { const temporary = statePath + '.' + process.pid; fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, statePath); };
const lockPath = statePath + '.lock';
const mutate = operation => {
  for (;;) {
    try { fs.mkdirSync(lockPath); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
  }
  try { const state = load(); const result = operation(state); save(state); return result; }
  finally { fs.rmdirSync(lockPath); }
};
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (args[0] === 'images') { console.log('image-id'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { console.log('[]'); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'ps') {
  const match = args.join(' ').match(/name=\\^([^$]+)\\$/);
  const name = match && match[1].replace(/^\\//, '');
  const state = load();
  const entry = name && state[name];
  const allCoreLaunched = ['redis', 'daemon', 'worker', 'analysis-worker', 'indexing-worker', 'api']
    .every(service => state['propr-' + service]?.['propr.setup-run'] && state['propr-' + service].__running);
  if (!name && state.foreign?.statusError && allCoreLaunched) {
    fs.writeSync(2, 'synthetic docker ps failure\\n');
    process.exit(23);
  } else if (!name && state.foreign?.abortFinal && allCoreLaunched) {
    fs.writeFileSync(process.env.PROPR_FAKE_MARKER, 'final-status');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    process.exit(0);
  } else {
    if (entry && (args.includes('-a') || entry.__running)) {
      fs.writeSync(1, args.includes('{{json .Names}}') ? JSON.stringify(name) + '\\n' : name + '\\n');
    }
    process.exit(0);
  }
}
if (args[0] === 'inspect') {
  const name = args[args.length - 1];
  const labels = load()[name];
  if (!labels) process.exit(1);
  const value = args.join(' ').includes('.HostConfig.Binds') ? labels.__hostConfig?.Binds : labels;
  fs.writeSync(1, JSON.stringify(value) + '\\n');
  process.exit(0);
}
if (args[0] === 'run') {
  const name = option('--name');
  const labels = {};
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--label') { const [key, ...rest] = args[++i].split('='); labels[key] = rest.join('='); }
  labels.__hostConfig = { Binds: args.flatMap((value, index) => value === '-v' ? [args[index + 1]] : []) };
  labels.__running = true;
  mutate(state => { state[name] = labels; if (args.includes('--rm')) delete state[name]; });
  fs.writeFileSync(process.env.PROPR_FAKE_MARKER, name);
  if (name === process.env.PROPR_FAKE_ABORT_TARGET) setTimeout(() => {}, 30_000);
  else { console.log(name); process.exit(0); }
} else if (args[0] === 'stop') {
  const name = args[args.length - 1];
  if (name === 'propr-redis' && process.env.PROPR_FAKE_STOP_MODE === 'owned-remains') {
    mutate(state => { if (state[name]) state[name].__running = false; });
    process.exit(42);
  }
  if (name === 'propr-redis' && process.env.PROPR_FAKE_STOP_MODE === 'foreign-replacement') {
    mutate(state => { state[name] = { foreign: 'replacement', __running: false }; });
    process.exit(42);
  }
  process.exit(0);
}
else if (args[0] === 'rm') { const name = args[args.length - 1]; mutate(state => { delete state[name]; }); process.exit(0); }
else process.exit(0);
PROPR_FAKE_NODE
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previous.path ?? ''}`;
  process.env.PROPR_FAKE_STATE = statePath;
  process.env.PROPR_FAKE_MARKER = markerPath;
  process.env.PROPR_FAKE_ABORT_TARGET = 'propr-redis';
  process.env.PROPR_FAKE_STOP_MODE = 'owned-remains';
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
  const stableRoot = join(directory, 'app-data', 'desktop', 'local-stack');
  await mkdir(join(stableRoot, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(stableRoot, 'logs'), { mode: 0o700 });
  await mkdir(join(stableRoot, 'repos'), { mode: 0o700 });
  await writeFile(join(stableRoot, '.env'), '', { mode: 0o600 });
  const cfg = resolveConfig({}, {
    manifestPath,
    envFileLocal: join(stableRoot, '.env'),
    envFileHost: join(stableRoot, '.env'),
    hostData: join(stableRoot, 'data'),
    hostLogs: join(stableRoot, 'logs'),
    hostRepos: join(stableRoot, 'repos'),
  });
  try {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await writeFile(statePath, JSON.stringify(initial));
      await writeFile(markerPath, '');
      process.env.PROPR_FAKE_ABORT_TARGET = 'propr-redis';
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
      assert.deepEqual(Object.keys(settled).sort(), ['foreign', 'propr-api'], `iteration ${iteration + 1}`);
      assert.equal(settled['propr-api'].foreign, 'preexisting');
      assert.equal(settled.foreign.foreign, 'true');
      assert.equal(Object.values(settled).some(labels => labels['propr.setup-run']), false);
    }

    await writeFile(statePath, JSON.stringify(initial));
    await writeFile(markerPath, '');
    process.env.PROPR_FAKE_STOP_MODE = 'foreign-replacement';
    const replacementController = new AbortController();
    const replacementOperation = startStackAsync(cfg, { ui: false, docs: false, tunnel: false, signal: replacementController.signal });
    await eventually(async () => { assert.equal(await readFile(markerPath, 'utf8'), 'propr-redis'); });
    replacementController.abort();
    await assert.rejects(replacementOperation);
    const replacementSettled = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(replacementSettled['propr-redis']?.foreign, 'replacement');
    assert.equal(replacementSettled['propr-api'].foreign, 'preexisting');
    assert.equal(replacementSettled.foreign.foreign, 'true');
    process.env.PROPR_FAKE_STOP_MODE = 'owned-remains';

    const finalInitial = {
      'propr-ui': { 'propr.stack': 'propr', 'propr.service': 'ui', foreign: 'preexisting', __running: false },
      foreign: { foreign: 'true', abortFinal: true, __running: true },
    };
    await writeFile(statePath, JSON.stringify(finalInitial));
    await writeFile(markerPath, '');
    process.env.PROPR_FAKE_ABORT_TARGET = 'final-status';
    const finalController = new AbortController();
    const finalOperation = startStackAsync(cfg, { ui: false, docs: false, tunnel: false, signal: finalController.signal });
    await Promise.race([
      eventually(async () => { assert.equal(await readFile(markerPath, 'utf8'), 'final-status'); }, 5_000),
      finalOperation.then(() => { throw new Error('stack unexpectedly completed'); }, error => { throw error; }),
    ]);
    finalController.abort();
    await assert.rejects(finalOperation);
    const finalSettled = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(Object.keys(finalSettled).sort(), ['foreign', 'propr-ui']);
    assert.equal(finalSettled['propr-ui'].foreign, 'preexisting');
    assert.equal(finalSettled.foreign.foreign, 'true');
    assert.equal(Object.values(finalSettled).some(labels => labels['propr.setup-run']), false);

    const errorInitial = {
      'propr-docs': { 'propr.stack': 'propr', 'propr.service': 'docs', foreign: 'preexisting', __running: false },
      foreign: { foreign: 'true', statusError: true, __running: true },
    };
    await writeFile(statePath, JSON.stringify(errorInitial));
    process.env.PROPR_FAKE_ABORT_TARGET = 'status-error';
    await assert.rejects(
      startStackAsync(cfg, { ui: false, docs: false, tunnel: false }),
      /Failed to inspect stack status: synthetic docker ps failure/,
    );
    const errorSettled = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(Object.keys(errorSettled).sort(), ['foreign', 'propr-docs']);
    assert.equal(errorSettled['propr-docs'].foreign, 'preexisting');
    assert.equal(errorSettled.foreign.foreign, 'true');
    assert.equal(Object.values(errorSettled).some(labels => labels['propr.setup-run']), false);

    // A successful create persists only the stable app-owned bind sources.
    // Toggle the fake daemon's running state to model an automatic Docker
    // restart after the creating Electron authority has gone away; HostConfig
    // remains byte-for-byte unchanged and contains no PID/fd path.
    await writeFile(statePath, JSON.stringify({ foreign: { foreign: 'true', __running: true } }));
    process.env.PROPR_FAKE_ABORT_TARGET = 'none';
    await startStackAsync(cfg, { ui: false, docs: false, tunnel: false });
    const created = JSON.parse(readFileSync(statePath, 'utf8'));
    const createdNames = Object.keys(created).filter(name => name.startsWith('propr-'));
    assert.ok(createdNames.length > 0);
    for (const name of createdNames) {
      const inspected = await dockerAsync(['inspect', '--format', '{{json .HostConfig.Binds}}', name]);
      assert.equal(inspected.status, 0);
      const binds = JSON.parse(inspected.stdout);
      for (const bind of binds.filter(value => value.startsWith(stableRoot))) {
        const source = bind.split(':')[0];
        assert.ok(source === join(stableRoot, '.env') || source.startsWith(`${stableRoot}/`));
        assert.doesNotMatch(source, /(?:^|\/)proc\/[0-9]+\/fd\/|(?:^|\/)dev\/fd\//);
      }
      created[name].__running = false;
      created[name].__running = true;
    }
    await writeFile(statePath, JSON.stringify(created));
    const restarted = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const name of createdNames) assert.deepEqual(restarted[name].__hostConfig, created[name].__hostConfig);
  } finally {
    process.env.PATH = previous.path;
    for (const [name, value] of [['PROPR_FAKE_STATE', previous.state], ['PROPR_FAKE_MARKER', previous.marker], ['PROPR_FAKE_ABORT_TARGET', previous.target], ['PROPR_FAKE_STOP_MODE', previous.stopMode], ['PROPR_SKIP_REMOTE_IMAGE_CHECK', previous.skip]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
