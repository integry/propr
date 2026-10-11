import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fakeDockerClient } from './fixtures/integration-image-harness/fake-docker.mjs';
import {
  assertNoStackContainers, bash, dockerCalls, fakeDockerDaemon, forceRemove, hostCannotRemovePrivateSubtree, makeWorkspace,
  modeOf, networkRemovals, readObserved, readState, rootHelper, runHarness, seedUnrelatedDocker, stackRoot, syntheticToken,
  unsupported, userBase,
} from './fixtures/integration-image-harness/harness.mjs';

// Regression for scripts/integration-test-images.sh: private temporary
// authority and cleanup. The unsafe-target and network-ownership cases are in
// integrationImageHarnessUnsafeTargets.test.mjs and
// integrationImageHarnessNetworkOwnership.test.mjs, so each file stays well
// inside the per-unit timeout on a contended runner.

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

  test('a sibling the launcher creates during the first cleanup inspection is removed before the root', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_DOCKER_LATE_SIBLING: 'worker' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readState(workspace).lateSibling, undefined, 'the worker appeared while cleanup was inspecting');
    const calls = dockerCalls(workspace);
    const launcherKill = calls.findIndex((call) => call[0] === 'rm');
    const lastWorkerInspect = calls.findLastIndex((call) => call[0] === 'container' && call.at(-1) === 'propr-itest-worker');
    assert.ok(launcherKill >= 0 && lastWorkerInspect > launcherKill, 'siblings are inspected again after the launcher is gone');
    assertNoStackContainers(workspace);
    assert.ok(!existsSync(stackRoot(workspace)));
  });

  test('a launcher that cannot be terminated keeps its siblings, network and root, and fails', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_DOCKER_LAUNCHER_RM: 'fail' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /could not terminate launcher propr-itest-launcher/);
    assert.match(result.stderr, /did not remove every owned resource/);
    const state = readState(workspace);
    assert.ok(state.containers['propr-itest-launcher'] && state.containers['propr-itest-worker']);
    assert.ok(state.networks['propr-itest-net']);
    assert.deepEqual(networkRemovals(workspace), []);
    assert.ok(!dockerCalls(workspace).some((call) => call[0] === 'run' && call.includes('find')), 'no data deletion is attempted');
    assert.ok(existsSync(join(stackRoot(workspace), '.env')), 'the stack root is kept');

    const failed = await runHarness(workspace, { FAKE_DOCKER_LAUNCHER_RM: 'fail', FAKE_E2E_EXIT: '5' });
    assert.equal(failed.code, 1, 'a later run refuses to reuse or remove the root while the launcher survives');
    assert.ok(existsSync(join(stackRoot(workspace), '.env')));
  });

  test('losing Docker access after launch keeps the root and running stack, and fails', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_E2E_DENY_DOCKER: '1' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /could not inspect container propr-itest-launcher/);
    assert.match(result.stderr, /did not remove every owned resource/);
    const state = readState(workspace);
    assert.ok(state.containers['propr-itest-launcher'] && state.containers['propr-itest-api'], 'the stack keeps running');
    assert.ok(state.networks['propr-itest-net']);
    assert.ok(!dockerCalls(workspace).some((call) => call[0] === 'rm' || (call[0] === 'run' && call.includes('find'))), 'nothing is removed');
    assert.ok(existsSync(join(stackRoot(workspace), '.env')), 'the stack root is kept');
    assert.ok(existsSync(join(stackRoot(workspace), '.propr-itest-owner')));
  });

  test('losing Docker access after the launcher is killed keeps the root and siblings, and fails', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    const result = await runHarness(workspace, { FAKE_DOCKER_DENY_AFTER_RM: '1' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /could not inspect container propr-itest-launcher/);
    assert.match(result.stderr, /could not terminate launcher propr-itest-launcher/);
    const state = readState(workspace);
    assert.ok(!state.containers['propr-itest-launcher']);
    assert.ok(state.containers['propr-itest-api'] && state.containers['propr-itest-worker'], 'siblings keep running');
    assert.equal(dockerCalls(workspace).filter((call) => call[0] === 'rm').length, 1, 'only the launcher kill was issued');
    assert.ok(!dockerCalls(workspace).some((call) => call[0] === 'run' && call.includes('find')), 'no data deletion is attempted');
    assert.ok(existsSync(join(stackRoot(workspace), '.env')), 'the stack root is kept');
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

describe('image integration harness fake Docker transport', { skip: unsupported }, () => {
  // A Node cold start per fake Docker call made each harness run a long chain
  // of processes that host contention stretched past the per-unit timeout.
  function runClient(script, args, env) {
    return new Promise((resolvePromise) => {
      const child = spawn(script, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  test('docker calls are served in-process and replay output, errors and exit status using only bash', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    seedUnrelatedDocker(workspace);
    // Nothing but bash is reachable, so the client cannot start Node or any other helper.
    const onlyBash = join(workspace.root, 'only-bash');
    mkdirSync(onlyBash);
    symlinkSync((await bash('command -v bash', [], {})).stdout.trim(), join(onlyBash, 'bash'));
    const docker = (args, env = {}) => runClient(join(workspace.bin, 'docker'), args, { PATH: onlyBash, FAKE_DOCKER_STATE: workspace.state, ...env });
    const served = fakeDockerDaemon.served();

    const found = await docker(['container', 'inspect', 'personal-propr-api']);
    assert.equal(found.code, 0, found.stderr);
    assert.equal(found.stderr, '');
    assert.equal(JSON.parse(found.stdout)[0].Id, 'a'.repeat(64));

    const missing = await docker(['container', 'inspect', 'missing']);
    assert.deepEqual(missing, { code: 1, stdout: '', stderr: 'Error: No such container: missing\n' });

    // FAKE_DOCKER_* switches reach the daemon; other variables do not matter to it.
    const raced = await docker(['network', 'create', '--label', 'a=b c', 'raced-net'], { FAKE_DOCKER_NETWORK_RACE: '1' });
    assert.equal(raced.code, 1);
    assert.match(raced.stderr, /network with name raced-net already exists/);

    const logs = await docker(['logs', '--tail', '', 'name with  spaces']);
    assert.deepEqual(logs, { code: 0, stdout: 'fake logs\n', stderr: '' });

    assert.deepEqual(dockerCalls(workspace), [
      ['container', 'inspect', 'personal-propr-api'],
      ['container', 'inspect', 'missing'],
      ['network', 'create', '--label', 'a=b c', 'raced-net'],
      ['logs', '--tail', '', 'name with  spaces'],
    ]);
    assert.equal(fakeDockerDaemon.served() - served, 4);

    // An unreachable daemon fails the call instead of passing it.
    const closed = createServer();
    await new Promise((resolvePromise) => closed.listen(0, '127.0.0.1', resolvePromise));
    const { port } = closed.address();
    await new Promise((resolvePromise) => closed.close(resolvePromise));
    const unreachable = join(workspace.bin, 'docker-unreachable');
    writeFileSync(unreachable, fakeDockerClient(port), { mode: 0o755 });
    const refused = await runClient(unreachable, ['container', 'inspect', 'personal-propr-api'], { PATH: onlyBash, FAKE_DOCKER_STATE: workspace.state });
    assert.equal(refused.code, 125);
    assert.match(refused.stderr, /fake docker daemon unreachable/);
    assert.equal(dockerCalls(workspace).length, 4);
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
