import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  dockerCalls, forceRemove, isMutation, makeWorkspace, modeOf, readState, runHarness, seedUnrelatedDocker, stackRoot,
  unsupported, userBase,
} from './fixtures/integration-image-harness/harness.mjs';

// Regression for scripts/integration-test-images.sh: unsafe stack roots, names,
// same-named containers and pre-existing networks are refused or left alone.
// Split from integrationImageHarness.test.mjs to keep each unit well inside
// the per-unit timeout on a contended runner.

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
