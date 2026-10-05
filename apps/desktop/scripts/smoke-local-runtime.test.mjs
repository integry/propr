import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

const smokeScript = resolve(import.meta.dirname, 'smoke-local-runtime.sh');
const cleanupHelper = resolve(import.meta.dirname, 'smoke-local-runtime-cleanup.sh');
const fakeDocker = resolve(import.meta.dirname, 'fixtures/runtime-smoke/fake-docker.mjs');
const revision = 'c'.repeat(40);
const compatibility = '2026-06-27';
const unsupported = process.platform === 'win32';
// Root bypasses the permission bits used to emulate a container-owned subtree.
const hostCannotRemovePrivateSubtree = !unsupported && process.getuid?.() !== 0;

function run(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function makeWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-smoke-test-')));
  const bin = join(root, 'bin');
  const state = join(root, 'docker-state');
  const tmp = join(root, 'tmp');
  for (const directory of [bin, state, tmp]) mkdirSync(directory);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`, { mode: 0o755 });
  return { root, bin, state, tmp };
}

function dockerCalls(workspace) {
  const path = join(workspace.state, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function dockerState(workspace) {
  return JSON.parse(readFileSync(join(workspace.state, 'state.json'), 'utf8'));
}

function smokeRoots(workspace) {
  return readdirSync(workspace.tmp).filter((name) => name.startsWith('propr-desktop-runtime-smoke.'));
}

function forceRemove(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      chmodSync(join(path, entry.name), 0o700);
      forceRemove(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

describe('desktop source runtime smoke cleanup', { skip: unsupported }, () => {
  let server;
  let port;
  let discovery;

  before(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(discovery));
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    port = server.address().port;
  });
  after(() => new Promise((resolvePromise) => server.close(resolvePromise)));

  function contract(apiCompatibility = compatibility) {
    return {
      schemaVersion: 1, product: 'ProPR', apiCompatibility, uiCompatibility: compatibility,
      publicInstanceIdentity: '0f8fad5b-d9cb-469f-a165-70867728950e',
      desktopAuthentication: {
        protocolVersion: 2, browserPairing: true, instanceBearerTokens: true, socketIoBearerAuthentication: true,
      },
    };
  }

  async function runSmoke(workspace, env = {}) {
    // Unrelated state that must survive: another stack's container and another
    // run's identically shaped temporary root.
    writeFileSync(join(workspace.state, 'state.json'), JSON.stringify({
      containers: { 'personal-propr-api': { labels: { 'dev.propr.stack': 'personal' } } },
      networks: { 'personal-propr-network': { labels: {} } },
    }));
    const otherRun = join(workspace.tmp, 'propr-desktop-runtime-smoke.Other1');
    mkdirSync(join(otherRun, 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(join(otherRun, 'data', 'keep.txt'), 'other run');
    const result = await run('bash', [smokeScript, revision, compatibility], {
      PATH: `${workspace.bin}:${process.env.PATH}`, TMPDIR: workspace.tmp,
      FAKE_DOCKER_STATE: workspace.state, FAKE_API_PORT: String(port), ...env,
    });
    assert.equal(readFileSync(join(otherRun, 'data', 'keep.txt'), 'utf8'), 'other run');
    assert.deepEqual(dockerState(workspace).containers, { 'personal-propr-api': { labels: { 'dev.propr.stack': 'personal' } } });
    assert.deepEqual(Object.keys(dockerState(workspace).networks), ['personal-propr-network']);
    return { result, otherRun };
  }

  test('passes and removes a container-owned private data subtree', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    discovery = contract();
    const { result, otherRun } = await runSmoke(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Desktop runtime smoke passed .* on isolated port ${port}`));
    assert.deepEqual(smokeRoots(workspace), [otherRun.split('/').at(-1)]);

    if (hostCannotRemovePrivateSubtree) {
      const cleanups = dockerCalls(workspace).filter((call) => call[0] === 'run' && call.includes('--rm'));
      assert.equal(cleanups.length, 1);
      const [cleanup] = cleanups;
      const mounts = cleanup.filter((_, index) => cleanup[index - 1] === '--mount');
      assert.equal(mounts.length, 1);
      assert.match(mounts[0], new RegExp(`^type=bind,source=${workspace.tmp}/propr-desktop-runtime-smoke\\.[A-Za-z0-9]{6},target=/smoke-root$`));
      assert.ok(!cleanup.includes('-v') && !cleanup.includes('--privileged'));
      assert.equal(cleanup[cleanup.indexOf('--network') + 1], 'none');
      assert.equal(cleanup[cleanup.indexOf('--cap-drop') + 1], 'ALL');
    }
  });

  test('fails an incompatible runtime while still removing every owned resource', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    discovery = contract('2000-01-01');
    const { result, otherRun } = await runSmoke(workspace);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not expose the complete desktop contract/);
    assert.deepEqual(smokeRoots(workspace), [otherRun.split('/').at(-1)]);
  });

  test('fails instead of reporting success when generated data cannot be removed', { skip: !hostCannotRemovePrivateSubtree }, async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    discovery = contract();
    const { result } = await runSmoke(workspace, { FAKE_DOCKER_CLEANUP: 'fail' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /generated smoke data remains at/);
    assert.match(result.stderr, /did not remove every owned resource/);
  });
});

describe('desktop source runtime smoke root boundary', { skip: unsupported }, () => {
  async function removeRoot(workspace, root, identity) {
    return run('bash', ['-c', 'set -euo pipefail; source "$1"; shift; remove_smoke_root "$@"', 'remove', cleanupHelper,
      root, workspace.tmp, identity, 'propr-desktop-local/app:test', 'dev.propr.desktop-runtime-smoke', 'stack'], {
      PATH: `${workspace.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: workspace.state,
    });
  }

  async function identityOf(workspace, path) {
    const result = await run('bash', ['-c', 'source "$1"; smoke_root_identity "$2"', 'identity', cleanupHelper, path], {});
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  }

  function privateRoot(workspace, name = 'propr-desktop-runtime-smoke.Ab12Cd') {
    const root = join(workspace.tmp, name);
    mkdirSync(join(root, 'data', 'web-push'), { recursive: true });
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'data', 'web-push', 'vapid.json'), '{}');
    chmodSync(join(root, 'data', 'web-push'), 0o000);
    return root;
  }

  function unrelatedTree(workspace) {
    const unrelated = join(workspace.root, 'personal-data');
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(unrelated, 'credentials.json'), 'secret');
    return unrelated;
  }

  test('removes its own root even when a container-owned subdirectory blocks the host user', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const root = privateRoot(workspace);
    const result = await removeRoot(workspace, root, await identityOf(workspace, root));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(root), false);
    assert.equal(dockerCalls(workspace).length, hostCannotRemovePrivateSubtree ? 1 : 0);
  });

  test('refuses a symlink that impersonates the smoke root', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const unrelated = unrelatedTree(workspace);
    const root = join(workspace.tmp, 'propr-desktop-runtime-smoke.Ab12Cd');
    symlinkSync(unrelated, root);
    const result = await removeRoot(workspace, root, await identityOf(workspace, unrelated));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing/);
    assert.equal(readFileSync(join(unrelated, 'credentials.json'), 'utf8'), 'secret');
    assert.deepEqual(dockerCalls(workspace), []);
  });

  test('refuses a directory outside the private temporary base or name shape', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const unrelated = unrelatedTree(workspace);
    for (const target of [unrelated, join(workspace.tmp, '..', 'personal-data'), workspace.tmp]) {
      const result = await removeRoot(workspace, target, await identityOf(workspace, target));
      assert.notEqual(result.code, 0, target);
      assert.match(result.stderr, /refusing/);
    }
    const misnamed = join(workspace.tmp, 'propr-desktop-runtime-smoke.Ab12Cd-personal');
    mkdirSync(misnamed, { mode: 0o700 });
    const result = await removeRoot(workspace, misnamed, await identityOf(workspace, misnamed));
    assert.notEqual(result.code, 0);
    assert.ok(existsSync(misnamed));
    assert.equal(readFileSync(join(unrelated, 'credentials.json'), 'utf8'), 'secret');
    assert.deepEqual(dockerCalls(workspace), []);
  });

  test('refuses a root replaced since creation or exposed to other users', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const root = privateRoot(workspace);
    const identity = await identityOf(workspace, root);
    // Keep the original alive elsewhere so the replacement cannot reuse its inode.
    renameSync(root, join(workspace.root, 'moved-away'));
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'replacement.txt'), 'not ours');
    const replaced = await removeRoot(workspace, root, identity);
    assert.notEqual(replaced.code, 0);
    assert.match(replaced.stderr, /identity changed/);
    assert.ok(existsSync(join(root, 'replacement.txt')));

    chmodSync(root, 0o755);
    const exposed = await removeRoot(workspace, root, await identityOf(workspace, root));
    assert.notEqual(exposed.code, 0);
    assert.match(exposed.stderr, /mode 755/);
    assert.ok(existsSync(join(root, 'replacement.txt')));
    assert.equal(statSync(root).mode & 0o777, 0o755);
    assert.deepEqual(dockerCalls(workspace), []);
  });
});
