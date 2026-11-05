import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claimOwnerGone, currentClaimOwner, type ClaimOwnerProbe } from '../src/storage/claimOwner.ts';
import { StorageLifecycle } from '../src/storage/lifecycle.ts';

const HOST = 'aaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbb';
const owner = (host: string, startedAt = 1_000_000, pid = 42) => ({ host, pid, startedAt });
function probe(containers: Record<string, number | null | undefined>, livePids: number[] = []): ClaimOwnerProbe {
  return {
    hostname: () => HOST,
    pidExists: pid => livePids.includes(pid),
    containerStartedAt: async host => (host in containers ? containers[host] : undefined),
  };
}

test('a claim is released only when its owner is provably gone', async () => {
  // Another container that was removed, or restarted after the owner started.
  assert.equal(await claimOwnerGone(owner(OTHER), probe({ [OTHER]: null })), true);
  assert.equal(await claimOwnerGone(owner(OTHER), probe({ [OTHER]: 2_000_000 })), true);
  // The same container incarnation: only a missing PID proves it gone.
  assert.equal(await claimOwnerGone(owner(HOST), probe({ [HOST]: 900_000 }, [])), true);
  assert.equal(await claimOwnerGone(owner(HOST), probe({ [HOST]: 900_000 }, [42])), false);
  // A live container that started before the owner keeps the claim.
  assert.equal(await claimOwnerGone(owner(OTHER), probe({ [OTHER]: 900_000 })), false);
  // Uncertainty (Docker unavailable, a host that is not a container) keeps it.
  assert.equal(await claimOwnerGone(owner(OTHER), probe({})), false);
  assert.equal(await claimOwnerGone(owner(HOST), probe({}, [])), false, 'without Docker, a PID alone is not proof');
});

async function lifecycle(probeOverride: ClaimOwnerProbe) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-claims-'));
  const storage = new StorageLifecycle(path.join(root, 'lifecycle'), probeOverride);
  await storage.initialize();
  const free = (await fs.statfs(root)).bavail * (await fs.statfs(root)).bsize;
  // A dead process's claim reserves more than the filesystem has free.
  await fs.writeFile(path.join(root, 'lifecycle', 'readers', 'stale'), JSON.stringify({ reservedBytes: free, owner: owner(OTHER) }));
  return { root, storage, admission: { filesystem: root, reserveBytes: 1, taskBytes: 1 } };
}

test('admission releases a dead owner\'s claim instead of failing for its reservation', async () => {
  const { root, storage, admission } = await lifecycle(probe({ [OTHER]: null }));
  try {
    assert.equal(await storage.use(async () => 'ran', admission), 'ran');
    assert.deepEqual(await fs.readdir(path.join(root, 'lifecycle', 'readers')), [], 'the stale claim and the run\'s own claim are gone');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('admission keeps a live owner\'s claim and its reservation', async () => {
  const { root, storage, admission } = await lifecycle(probe({ [OTHER]: 900_000 }));
  try {
    await assert.rejects(storage.use(async () => 'ran', admission), /admission reserve unavailable/);
    assert.deepEqual(await fs.readdir(path.join(root, 'lifecycle', 'readers')), ['stale']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('new claims record their owning process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-claims-'));
  try {
    const storage = new StorageLifecycle(path.join(root, 'lifecycle'), probe({}));
    await storage.use(async () => {
      const [name] = await fs.readdir(path.join(root, 'lifecycle', 'readers'));
      const record = JSON.parse(await fs.readFile(path.join(root, 'lifecycle', 'readers', name), 'utf8'));
      assert.deepEqual(record, { reservedBytes: 7, owner: currentClaimOwner() });
    }, { filesystem: root, reserveBytes: 1, taskBytes: 7 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('maintenance claims warn while waiting for a gate and retain their barrier until released', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-wait-'));
  const storage = new StorageLifecycle(root);
  await storage.initialize();
  await fs.writeFile(path.join(root, 'last-use'), '1000');
  await fs.mkdir(path.join(root, 'gate'));
  let warned = false;
  const completed = storage.use(async () => {
    assert.equal(await storage.busy(), true);
  }, undefined, { recordUse: false, waitWarning: { afterMs: 10, warn: () => { warned = true; } } });
  try {
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(warned, true);
    assert.equal(await storage.busy(), true, 'waiting never steals the gate or drops intent');
    await fs.rmdir(path.join(root, 'gate'));
    await completed;
    assert.equal(await storage.busy(), false);
    assert.equal(await fs.readFile(path.join(root, 'last-use'), 'utf8'), '1000');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('actual use nested in maintenance still updates the use clock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-nested-use-'));
  const storage = new StorageLifecycle(root);
  await storage.initialize();
  await fs.writeFile(path.join(root, 'last-use'), '1000');
  try {
    await storage.use(async () => {
      await storage.use(async () => {
        assert.ok((await storage.lastUse())! > 1000);
      });
    }, undefined, { recordUse: false });
    assert.ok((await storage.lastUse())! > 1000);
    assert.equal(await storage.busy(), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
