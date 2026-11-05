import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertNoStackContainers, dockerCalls, forceRemove, makeWorkspace, markerToken, modeOf, networkRemovals, readState,
  runHarness, stackRoot, unsupported,
} from './fixtures/integration-image-harness/harness.mjs';

// Regression for scripts/integration-test-images.sh: a kept run's network
// record only ever authorizes removing the network this harness created.
// Split from integrationImageHarness.test.mjs to keep each unit well inside
// the per-unit timeout on a contended runner.

describe('image integration harness refuses unsafe temporary targets: network ownership records', { skip: unsupported }, () => {
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
});
