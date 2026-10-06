import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

// Regression for scripts/integration-test-images.sh. The harness runs from a
// synthetic checkout with a synthetic .env and key, against fake docker, curl
// and npm binaries. No real credential or configuration file is read.
const repoRoot = resolve(import.meta.dirname, '..');
const harnessScript = join(repoRoot, 'scripts/integration-test-images.sh');
const rootHelper = join(repoRoot, 'scripts/lib/integration-test-root.sh');
const fakeDocker = join(repoRoot, 'test/fixtures/integration-image-harness/fake-docker.mjs');
const unsupported = process.platform === 'win32';
// Root bypasses the permission bits used to emulate a container-owned subtree.
const hostCannotRemovePrivateSubtree = !unsupported && process.getuid?.() !== 0;
const uid = unsupported ? 0 : process.getuid();
const syntheticToken = 'ghs_SyntheticOnlyToken0000000000';
const syntheticKey = 'SYNTHETIC-NOT-A-REAL-KEY\n';

function bash(script, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', script, 'bash', ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function makeWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'itest-harness-test-')));
  const workspace = {
    root,
    bin: join(root, 'bin'),
    state: join(root, 'docker-state'),
    tmp: join(root, 'tmp'),
    home: join(root, 'home'),
    checkout: join(root, 'checkout'),
  };
  for (const directory of [workspace.bin, workspace.state, workspace.tmp, workspace.home, join(workspace.checkout, 'scripts/lib')]) {
    mkdirSync(directory, { recursive: true });
  }
  copyFileSync(harnessScript, join(workspace.checkout, 'scripts/integration-test-images.sh'));
  copyFileSync(rootHelper, join(workspace.checkout, 'scripts/lib/integration-test-root.sh'));
  writeFileSync(join(workspace.checkout, 'synthetic-key.pem'), syntheticKey, { mode: 0o600 });
  writeFileSync(join(workspace.checkout, '.env'), [
    'GH_APP_ID=0',
    'GH_PRIVATE_KEY_PATH=./synthetic-key.pem',
    'SYNTHETIC_SECRET=synthetic-only-value',
    'SESSION_SECRET=overridden-by-the-harness',
    '',
  ].join('\n'), { mode: 0o600 });

  writeFileSync(join(workspace.bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`, { mode: 0o755 });
  // curl records its argv and whether the bearer token arrived via stdin config.
  writeFileSync(join(workspace.bin, 'curl'), `#!/usr/bin/env bash
config=""
for arg in "$@"; do [ "$arg" = "-" ] && config="$(cat)"; done
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/curl-args"
if [ -n "$config" ]; then printf '%s\\n' "$config" >> "$FAKE_DOCKER_STATE/curl-config"; fi
case "$*" in
  *%{http_code}*) printf 200 ;;
  */health*) printf ok ;;
  *) printf '{}' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(workspace.bin, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/npm-calls"
exit "\${FAKE_E2E_EXIT:-0}"
`, { mode: 0o755 });
  return workspace;
}

function forceRemove(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      chmodSync(join(path, entry.name), 0o700);
      forceRemove(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

const userBase = (workspace) => join(workspace.tmp, `propr-itest-${uid}`);
const stackRoot = (workspace, stack = 'propr-itest') => join(userBase(workspace), stack);
const modeOf = (path) => (lstatSync(path).mode & 0o777).toString(8);
const readState = (workspace) => JSON.parse(readFileSync(join(workspace.state, 'state.json'), 'utf8'));
const readObserved = (workspace) => JSON.parse(readFileSync(join(workspace.state, 'observed.json'), 'utf8'));
const dockerCalls = (workspace) => {
  const path = join(workspace.state, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const isMutation = ([command, subcommand]) => ['run', 'rm', 'stop'].includes(command)
  || (command === 'network' && ['rm', 'create'].includes(subcommand));
const networkRemovals = (workspace) => dockerCalls(workspace).filter(([command, subcommand]) => command === 'network' && subcommand === 'rm');
const markerToken = (workspace) => /^token=(.+)$/m.exec(readFileSync(join(stackRoot(workspace), '.propr-itest-owner'), 'utf8'))[1];

function seedUnrelatedDocker(workspace, extra = {}) {
  const state = {
    containers: {
      'personal-propr-api': {
        Id: 'a'.repeat(64), Name: '/personal-propr-api',
        Config: { Labels: { 'propr.stack': 'personal-propr', 'propr.service': 'api' } }, Mounts: [],
      },
      ...extra.containers,
    },
    networks: { 'personal-propr-net': { Id: 'b'.repeat(64) }, ...extra.networks },
  };
  writeFileSync(join(workspace.state, 'state.json'), JSON.stringify(state));
}

async function runHarness(workspace, env = {}) {
  const outside = join(workspace.root, 'outside-sentinel');
  if (!existsSync(outside)) {
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'keep.txt'), 'unrelated');
  }
  if (!existsSync(join(workspace.state, 'state.json'))) seedUnrelatedDocker(workspace);
  const result = await bash('umask 022; exec bash "$HARNESS"', [], {
    HARNESS: join(workspace.checkout, 'scripts/integration-test-images.sh'),
    PATH: `${workspace.bin}:${process.env.PATH}`,
    HOME: workspace.home,
    TMPDIR: workspace.tmp,
    FAKE_DOCKER_STATE: workspace.state,
    PROPR_E2E_TOKEN: syntheticToken,
    PROPR_E2E_SKIP_SLOW: '1',
    STACK: 'propr-itest',
    PROPR_E2E_KEEP_STACK: '',
    PROPR_E2E_REUSE_DATA: '',
    ...env,
  });
  // Unrelated host data and Docker resources always survive.
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(readFileSync(join(workspace.checkout, 'synthetic-key.pem'), 'utf8'), syntheticKey);
  const state = readState(workspace);
  assert.ok(state.containers['personal-propr-api'], 'unrelated container survives');
  assert.ok(state.networks['personal-propr-net'], 'unrelated network survives');
  // The token never reaches output or a process argument list.
  assert.ok(!result.stdout.includes(syntheticToken) && !result.stderr.includes(syntheticToken));
  assert.ok(!JSON.stringify(dockerCalls(workspace)).includes(syntheticToken));
  const curlArgs = join(workspace.state, 'curl-args');
  if (existsSync(curlArgs)) assert.ok(!readFileSync(curlArgs, 'utf8').includes(syntheticToken));
  return result;
}

function assertNoStackContainers(workspace) {
  const remaining = Object.keys(readState(workspace).containers).filter((name) => name.startsWith('propr-itest-'));
  assert.deepEqual(remaining, []);
  assert.ok(!readState(workspace).networks['propr-itest-net']);
}

describe('image integration harness private temporary authority', { skip: unsupported }, () => {
  test('stages a 0700 root with 0600 files under umask 022, never copies the key, and removes only owned data', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /integration test passed/);

    const observed = readObserved(workspace);
    assert.equal(observed.base, '700');
    assert.equal(observed.root, '700');
    assert.equal(observed.marker, '600');
    assert.equal(observed.env, '600');
    assert.deepEqual(observed.directories, { data: '700', logs: '700', repos: '700', 'vibe-prompts': '700' });
    assert.deepEqual(observed.rootEntries, ['.env', '.propr-itest-owner', 'data', 'logs', 'repos', 'vibe-prompts']);
    assert.deepEqual(observed.dataEntries, [], 'the GitHub App key is not copied into the data root');
    assert.equal(observed.hostKey, join(workspace.checkout, 'synthetic-key.pem'));
    assert.equal(observed.inContainerKeyPath, false);
    assert.equal(observed.syntheticSecretKept, true);

    const launcher = dockerCalls(workspace).find((call) => call[0] === 'run' && call.includes('--name') && call.includes('propr-itest-launcher'));
    assert.ok(launcher);
    assert.ok(launcher.includes(`${stackRoot(workspace)}/.env:/app/.env:ro`));
    assert.ok(!launcher.some((arg) => arg.startsWith('/tmp/propr-itest')), 'nothing is mounted from the legacy shared location');
    assert.match(readFileSync(join(workspace.state, 'curl-config'), 'utf8'), new RegExp(`Authorization: Bearer ${syntheticToken}`));
    assert.match(readFileSync(join(workspace.state, 'npm-calls'), 'utf8'), /test:e2e/);

    assert.ok(!existsSync(stackRoot(workspace)), 'the stack root is removed');
    assert.equal(modeOf(userBase(workspace)), '700');
    assertNoStackContainers(workspace);
    if (hostCannotRemovePrivateSubtree) {
      const cleanups = dockerCalls(workspace).filter((call) => call[0] === 'run' && call.includes('find'));
      assert.equal(cleanups.length, 1);
      const [cleanup] = cleanups;
      assert.deepEqual(cleanup.filter((_, index) => cleanup[index - 1] === '--mount'),
        [`type=bind,source=${stackRoot(workspace)},target=/itest-root`]);
      assert.equal(cleanup[cleanup.indexOf('--network') + 1], 'none');
      assert.equal(cleanup[cleanup.indexOf('--cap-drop') + 1], 'ALL');
      assert.ok(!cleanup.includes('-v') && !cleanup.includes('--privileged'));
    }
  });

  test('keeps the original e2e failure exit status and still cleans up', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_E2E_EXIT: '3' });
    assert.equal(result.code, 3);
    assert.doesNotMatch(result.stdout, /integration test passed/);
    assert.ok(!existsSync(stackRoot(workspace)));
    assertNoStackContainers(workspace);
  });

  test('reports a cleanup failure instead of succeeding when generated data remains', { skip: !hostCannotRemovePrivateSubtree }, async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_DOCKER_CLEANUP: 'fail' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /generated integration data remains at/);
    assert.match(result.stderr, /did not remove every owned resource/);

    const second = makeWorkspace();
    t.after(() => forceRemove(second.root));
    const failed = await runHarness(second, { FAKE_DOCKER_CLEANUP: 'fail', FAKE_E2E_EXIT: '4' });
    assert.equal(failed.code, 4, 'the original failure status wins over the cleanup failure');
  });

  test('keep then reuse preserves the marked root, reconciles kept containers, and a fresh run replaces it', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const kept = await runHarness(workspace, { PROPR_E2E_KEEP_STACK: '1' });
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stdout, new RegExp(`data dir: +${stackRoot(workspace)}`));
    assert.equal(modeOf(stackRoot(workspace)), '700');
    const marker = readFileSync(join(stackRoot(workspace), '.propr-itest-owner'), 'utf8');
    assert.ok(readState(workspace).containers['propr-itest-launcher'], 'the kept launcher stays running');
    const launcherRun = dockerCalls(workspace).find((call) => call[0] === 'run' && call.includes('propr-itest-launcher'));
    assert.ok(!launcherRun.includes('--rm'));

    writeFileSync(join(stackRoot(workspace), 'repos', 'reused.txt'), 'from the kept run');
    const reused = await runHarness(workspace, { PROPR_E2E_REUSE_DATA: '1', PROPR_E2E_KEEP_STACK: '1' });
    assert.equal(reused.code, 0, reused.stderr);
    assert.match(reused.stdout, /reusing stack root/);
    assert.equal(readFileSync(join(stackRoot(workspace), 'repos', 'reused.txt'), 'utf8'), 'from the kept run');
    assert.equal(readFileSync(join(stackRoot(workspace), '.propr-itest-owner'), 'utf8'), marker);
    assert.equal(modeOf(join(stackRoot(workspace), '.env')), '600');

    const fresh = await runHarness(workspace);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.ok(!existsSync(stackRoot(workspace)));
    assertNoStackContainers(workspace);
  });
});

describe('image integration harness refuses unsafe temporary targets', { skip: unsupported }, () => {
  async function assertRefused(workspace, env, pattern) {
    const before = dockerCalls(workspace).length;
    const result = await runHarness(workspace, env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, pattern);
    const after = dockerCalls(workspace).slice(before);
    assert.deepEqual(after.filter(isMutation), [], 'no container is started, stopped or removed');
    return result;
  }

  function sentinelTree(path, mode = 0o700) {
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
    writeFileSync(join(path, 'keep.txt'), 'must survive');
  }

  test('a symlinked stack root is refused before any write or deletion', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const target = join(workspace.root, 'symlink-target');
    sentinelTree(target);
    mkdirSync(userBase(workspace), { mode: 0o700 });
    symlinkSync(target, stackRoot(workspace));
    await assertRefused(workspace, {}, /not a real directory/);
    assert.deepEqual(readdirSync(target), ['keep.txt']);
    assert.ok(lstatSync(stackRoot(workspace)).isSymbolicLink());
  });

  test('a symlinked or shared per-user base is refused and left unchanged', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const target = join(workspace.root, 'base-target');
    sentinelTree(target);
    symlinkSync(target, userBase(workspace));
    await assertRefused(workspace, {}, /integration base directory .*not a real directory/);
    assert.deepEqual(readdirSync(target), ['keep.txt']);

    rmSync(userBase(workspace));
    mkdirSync(userBase(workspace), { mode: 0o755 });
    chmodSync(userBase(workspace), 0o755);
    await assertRefused(workspace, {}, /mode 755, expected 700/);
    assert.equal(modeOf(userBase(workspace)), '755');
    assert.deepEqual(readdirSync(userBase(workspace)), []);
  });

  test('unmarked, foreign-marked, or widened stack roots are refused, not repaired or removed', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    mkdirSync(userBase(workspace), { mode: 0o700 });
    sentinelTree(stackRoot(workspace));
    for (const env of [{}, { PROPR_E2E_REUSE_DATA: '1' }]) {
      await assertRefused(workspace, env, /no ownership marker from this harness/);
      assert.deepEqual(readdirSync(stackRoot(workspace)), ['keep.txt']);
    }

    writeFileSync(join(stackRoot(workspace), '.propr-itest-owner'), `propr-itest-root v1\nstack=other\ntoken=${'c'.repeat(32)}`, { mode: 0o600 });
    await assertRefused(workspace, {}, /does not belong to stack propr-itest/);

    writeFileSync(join(stackRoot(workspace), '.propr-itest-owner'), `propr-itest-root v1\nstack=propr-itest\ntoken=${'c'.repeat(32)}`, { mode: 0o600 });
    chmodSync(stackRoot(workspace), 0o755);
    await assertRefused(workspace, {}, /mode 755, expected 700/);
    assert.equal(modeOf(stackRoot(workspace)), '755');

    chmodSync(stackRoot(workspace), 0o700);
    chmodSync(join(stackRoot(workspace), '.propr-itest-owner'), 0o644);
    await assertRefused(workspace, {}, /ownership marker mode 644/);
    assert.equal(modeOf(join(stackRoot(workspace), '.propr-itest-owner')), '644');
    assert.ok(readdirSync(stackRoot(workspace)).includes('keep.txt'));
  });

  test('path-traversal and malformed stack names are refused before anything is created', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    for (const stack of ['../escape', '.', '..', 'a/b', '-leading', 'with space', 'x'.repeat(64)]) {
      await assertRefused(workspace, { STACK: stack }, /STACK must be/);
    }
    assert.deepEqual(readdirSync(workspace.tmp), []);
    assert.ok(!existsSync(join(workspace.root, 'escape')));
  });

  test('same-named containers that do not belong to this root are refused and survive', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const impostor = {
      Id: 'd'.repeat(64), Name: '/propr-itest-api',
      Config: { Labels: { 'propr.stack': 'propr-itest', 'propr.service': 'api' } },
      Mounts: [{ Type: 'bind', Source: '/srv/someone-else/data', Destination: '/usr/src/app/data' }],
    };
    seedUnrelatedDocker(workspace, { containers: { 'propr-itest-api': impostor }, networks: { 'propr-itest-net': { Id: 'e'.repeat(64) } } });
    await assertRefused(workspace, {}, /container propr-itest-api already exists and does not belong/);
    assert.deepEqual(readState(workspace).containers['propr-itest-api'], impostor);
    assert.ok(readState(workspace).networks['propr-itest-net']);
    assert.ok(!existsSync(stackRoot(workspace)), 'only the root this run created is removed');

    // A marked root does not make a foreign same-named container removable.
    const kept = makeWorkspace();
    t.after(() => forceRemove(kept.root));
    assert.equal((await runHarness(kept, { PROPR_E2E_KEEP_STACK: '1' })).code, 0);
    const state = readState(kept);
    state.containers['propr-itest-launcher'].Config.Labels['com.propr.itest.root'] = 'f'.repeat(32);
    writeFileSync(join(kept.state, 'state.json'), JSON.stringify(state));
    await assertRefused(kept, { PROPR_E2E_REUSE_DATA: '1' }, /refusing to remove container propr-itest-launcher/);
    assert.ok(readState(kept).containers['propr-itest-launcher']);
    assert.ok(existsSync(join(stackRoot(kept), '.propr-itest-owner')), 'the kept root is not removed on refusal');
  });

  test('a pre-existing unrelated network with the stack name is left in place', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    seedUnrelatedDocker(workspace, { networks: { 'propr-itest-net': { Id: 'e'.repeat(64) } } });
    const result = await runHarness(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(readState(workspace).networks['propr-itest-net']);
    assert.match(result.stderr, /leaving network propr-itest-net/);

    // The launcher's own teardown (which removes the network) never runs.
    const forcedRemovals = dockerCalls(workspace).filter((call) => call[0] === 'rm' && call[1] === '-f').map((call) => call.at(-1));
    assert.ok(forcedRemovals.length > 0);
    assert.deepEqual(dockerCalls(workspace).filter(([command]) => command === 'stop'), []);

    // An existing marked root without kept containers proves nothing about it.
    const kept = makeWorkspace();
    t.after(() => forceRemove(kept.root));
    assert.equal((await runHarness(kept, { PROPR_E2E_KEEP_STACK: '1' })).code, 0);
    seedUnrelatedDocker(kept, { networks: { 'propr-itest-net': { Id: 'e'.repeat(64) } } });
    const reused = await runHarness(kept, { PROPR_E2E_REUSE_DATA: '1' });
    assert.equal(reused.code, 0, reused.stderr);
    assert.ok(readState(kept).networks['propr-itest-net']);
  });

  test('kept containers do not make a pre-existing network removable on a later run', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const network = { Id: 'e'.repeat(64) };
    seedUnrelatedDocker(workspace, { networks: { 'propr-itest-net': network } });
    const kept = await runHarness(workspace, { PROPR_E2E_KEEP_STACK: '1' });
    assert.equal(kept.code, 0, kept.stderr);
    assert.ok(!existsSync(join(stackRoot(workspace), '.propr-itest-network')), 'no ownership is recorded for a network this run did not create');

    for (const env of [{ PROPR_E2E_REUSE_DATA: '1', PROPR_E2E_KEEP_STACK: '1' }, {}]) {
      const result = await runHarness(workspace, env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readState(workspace).networks['propr-itest-net'], network);
    }
    assert.ok(!existsSync(stackRoot(workspace)));
    assert.deepEqual(Object.keys(readState(workspace).containers).filter((name) => name.startsWith('propr-itest-')), []);
    assert.deepEqual(dockerCalls(workspace).filter(([command]) => command === 'stop'), []);
  });

  test('a kept run records the network it created and a later run removes only that network, by ID', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    assert.equal((await runHarness(workspace, { PROPR_E2E_KEEP_STACK: '1' })).code, 0);
    const created = readState(workspace).networks['propr-itest-net'];
    assert.ok(created);
    assert.ok(!created.launcherCreated, 'the harness, not the launcher, created the network');
    assert.deepEqual(created.Labels, { 'com.propr.itest.root': markerToken(workspace), 'com.propr.itest.stack': 'propr-itest' });
    const record = join(stackRoot(workspace), '.propr-itest-network');
    assert.equal(readFileSync(record, 'utf8'), created.Id);
    assert.equal(modeOf(record), '600');

    // Reuse removes the kept network by ID and records the one it creates next.
    const reused = await runHarness(workspace, { PROPR_E2E_REUSE_DATA: '1', PROPR_E2E_KEEP_STACK: '1' });
    assert.equal(reused.code, 0, reused.stderr);
    const recreated = readState(workspace).networks['propr-itest-net'];
    assert.notEqual(recreated.Id, created.Id);
    assert.equal(readFileSync(record, 'utf8'), recreated.Id);
    assert.deepEqual(networkRemovals(workspace).map((call) => call.at(-1)), [created.Id]);

    const fresh = await runHarness(workspace);
    assert.equal(fresh.code, 0, fresh.stderr);
    assertNoStackContainers(workspace);
    // The fresh run removes the recorded network, then the one it created itself.
    const removed = networkRemovals(workspace).map((call) => call.at(-1));
    assert.deepEqual(removed.slice(0, 2), [created.Id, recreated.Id]);
    assert.equal(removed.length, 3);
    const creates = dockerCalls(workspace).filter(([command, subcommand]) => command === 'network' && subcommand === 'create');
    assert.equal(creates.length, 3);
  });

  test('a recorded ID does not make an unlabelled same-named network removable', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    assert.equal((await runHarness(workspace, { PROPR_E2E_KEEP_STACK: '1' })).code, 0);
    const foreign = { Id: 'e'.repeat(64) };
    const state = readState(workspace);
    state.networks['propr-itest-net'] = foreign;
    writeFileSync(join(workspace.state, 'state.json'), JSON.stringify(state));
    writeFileSync(join(stackRoot(workspace), '.propr-itest-network'), foreign.Id, { mode: 0o600 });

    for (const env of [{ PROPR_E2E_REUSE_DATA: '1', PROPR_E2E_KEEP_STACK: '1' }, {}]) {
      const result = await runHarness(workspace, env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readState(workspace).networks['propr-itest-net'], foreign);
    }
    assert.deepEqual(networkRemovals(workspace), []);
  });

  test('a foreign network created after the absence check is refused, not used, removed or recorded', async (t) => {
    for (const keep of ['', '1']) {
      const workspace = makeWorkspace();
      t.after(() => forceRemove(workspace.root));
      const result = await runHarness(workspace, { FAKE_DOCKER_NETWORK_RACE: '1', PROPR_E2E_KEEP_STACK: keep, FAKE_E2E_EXIT: '5' });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /could not create network propr-itest-net/);
      assert.deepEqual(readState(workspace).networks['propr-itest-net'], { Id: 'e'.repeat(64), foreign: true });
      assert.ok(!dockerCalls(workspace).some((call) => call[0] === 'run' && call.includes('propr-itest-launcher')), 'the launcher never starts');
      assert.deepEqual(networkRemovals(workspace), []);
      assert.ok(!existsSync(join(stackRoot(workspace), '.propr-itest-network')));
      assert.ok(!existsSync(join(workspace.state, 'npm-calls')));
    }
  });

  test('a same-named network replacing the created one before cleanup is preserved and never recorded', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_DOCKER_REPLACE_NETWORK: '1', FAKE_E2E_EXIT: '3' });
    assert.equal(result.code, 3, 'the original failure status is kept');
    assert.match(result.stderr, /leaving network propr-itest-net: it is not the network this harness created/);
    assert.equal(readState(workspace).networks['propr-itest-net'].Id, 'e'.repeat(64));
    assert.deepEqual(networkRemovals(workspace), []);
    assert.ok(!existsSync(stackRoot(workspace)));

    const kept = makeWorkspace();
    t.after(() => forceRemove(kept.root));
    const keptRun = await runHarness(kept, { FAKE_DOCKER_REPLACE_NETWORK: '1', PROPR_E2E_KEEP_STACK: '1' });
    assert.equal(keptRun.code, 0, keptRun.stderr);
    assert.ok(!existsSync(join(stackRoot(kept), '.propr-itest-network')), 'the replacement ID is not persisted');
    const later = await runHarness(kept);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(readState(kept).networks['propr-itest-net'].Id, 'e'.repeat(64));
    assert.deepEqual(networkRemovals(kept), []);
  });

  test('extra stack-labelled containers outside the verified set survive cleanup', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const extra = {
      Id: '9'.repeat(64), Name: '/propr-itest-extra',
      Config: { Labels: { 'propr.stack': 'propr-itest', 'propr.service': 'extra' } }, Mounts: [],
    };
    seedUnrelatedDocker(workspace, { containers: { 'propr-itest-extra': extra } });
    const result = await runHarness(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readState(workspace).containers['propr-itest-extra'], extra);
    assert.deepEqual(Object.keys(readState(workspace).containers).filter((name) => name.startsWith('propr-itest-')), ['propr-itest-extra']);
    assert.ok(!existsSync(stackRoot(workspace)));
  });
});

describe('image integration root helper', { skip: unsupported }, () => {
  function helper(script, env) {
    return bash(`set -euo pipefail; umask 022; source "$ROOT_HELPER"; ${script}`, [], { ROOT_HELPER: rootHelper, ...env });
  }

  test('refuses to remove a root whose identity was replaced after validation', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const base = join(workspace.tmp, 'base');
    mkdirSync(base, { mode: 0o700 });
    const root = join(base, 'stack');
    const created = await helper('itest_root_create "$R" "$B" stack; printf "%s %s" "$ITEST_ROOT_IDENTITY" "$ITEST_ROOT_TOKEN"', { R: root, B: base });
    assert.equal(created.code, 0, created.stderr);
    const [identity, token] = created.stdout.split(' ');
    assert.equal(modeOf(root), '700');
    assert.equal(modeOf(join(root, '.propr-itest-owner')), '600');

    // Swap in a different directory carrying a copy of the marker.
    renameSync(root, join(base, 'moved'));
    mkdirSync(root, { mode: 0o700 });
    copyFileSync(join(base, 'moved', '.propr-itest-owner'), join(root, '.propr-itest-owner'));
    chmodSync(join(root, '.propr-itest-owner'), 0o600);
    writeFileSync(join(root, 'keep.txt'), 'replacement');
    const removed = await helper('itest_remove_root "$R" "$B" stack "$I" "$T" image', {
      R: root, B: base, I: identity, T: token, PATH: `${workspace.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: workspace.state,
    });
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, /identity changed/);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'replacement');
    assert.deepEqual(dockerCalls(workspace), []);
  });

  test('writes private files 0600 from creation and refuses symlinked targets', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const directory = join(workspace.tmp, 'private');
    mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, 'synthetic.env');
    const written = await helper('printf "SYNTHETIC=1\\n" | itest_write_private_file "$F"', { F: file });
    assert.equal(written.code, 0, written.stderr);
    assert.equal(modeOf(file), '600');

    const outside = join(workspace.root, 'outside.env');
    writeFileSync(outside, 'unrelated', { mode: 0o644 });
    const link = join(directory, 'linked.env');
    symlinkSync(outside, link);
    const refused = await helper('printf "SYNTHETIC=1\\n" | itest_write_private_file "$F"', { F: link });
    assert.notEqual(refused.code, 0);
    assert.equal(readFileSync(outside, 'utf8'), 'unrelated');
    assert.equal(modeOf(outside), '644');
  });
});
