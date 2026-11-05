import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StorageLifecycle, StorageBusyError } from '../src/storage/lifecycle.js';
import type { ClaimOwnerProbe } from '../src/storage/claimOwner.js';

// A container-like host, so the probe's start time decides liveness the way it does in production.
const HOST = 'abcdef123456';
const probe = (alive: boolean): ClaimOwnerProbe => ({
  hostname: () => HOST,
  pidExists: () => alive,
  containerStartedAt: async () => 1_000,
});
const deadOwner = { host: HOST, pid: 4242, startedAt: 2_000 };

async function root(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-gate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function plantGate(dir: string, record?: { token: string }): Promise<string> {
  const gate = path.join(dir, 'gate');
  await fs.mkdir(gate, { recursive: true });
  if (record) await fs.writeFile(path.join(gate, `owner-${record.token}`), JSON.stringify(record));
  return gate;
}
/** The holder's record as a waiter reads it: the single `owner-<token>` entry. */
async function gateRecord(dir: string): Promise<{ token: string } | null> {
  const entries = (await fs.readdir(path.join(dir, 'gate'))).filter(name => name.startsWith('owner-'));
  assert.ok(entries.length <= 1, `one record at most: ${entries.join(', ')}`);
  return entries.length ? JSON.parse(await fs.readFile(path.join(dir, 'gate', entries[0]), 'utf8')) : null;
}
/** Probes a holder only after this long, so a reclaim is observable within a test's wait. */
const quickProbe = { orphanCheckMs: 50 };

test('the holder records itself in the gate and removes the gate when done', async t => {
  const dir = await root(t);
  const lifecycle = new StorageLifecycle(dir, probe(true));
  const seen = await lifecycle.exclusive(async () => {
    const [file] = await fs.readdir(path.join(dir, 'gate'));
    return { file, record: JSON.parse(await fs.readFile(path.join(dir, 'gate', file), 'utf8')) };
  });
  assert.equal(seen.record.owner.pid, process.pid);
  assert.equal(typeof seen.record.token, 'string');
  assert.equal(seen.file, `owner-${seen.record.token}`, 'the record is named by its token');
  await assert.rejects(fs.stat(path.join(dir, 'gate')), { code: 'ENOENT' });
});

test('a gate whose holder is gone is reclaimed instead of waited on forever', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'old', takenAt: Date.now() });
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  const lifecycle = new StorageLifecycle(dir, probe(false), quickProbe);
  assert.equal(await lifecycle.exclusive(async () => 'ran', 2_000), 'ran');
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('abandoned storage lifecycle gate')));
});

test('the holder is not probed during routine contention', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'brief', takenAt: Date.now() });
  const probed: string[] = [];
  const lifecycle = new StorageLifecycle(dir, { ...probe(false), containerStartedAt: async host => { probed.push(host); return 1_000; } }, { orphanCheckMs: 500 });
  const waiting = lifecycle.exclusive(async () => 'ran', 2_000);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(probed, [], 'a wait shorter than the probe interval spawns no probe');
  await fs.rm(path.join(dir, 'gate'), { recursive: true }); // the holder finishes
  assert.equal(await waiting, 'ran');
  assert.deepEqual(probed, []);
});

test('a gate held by a live process is respected', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'live', takenAt: Date.now() });
  const lifecycle = new StorageLifecycle(dir, probe(true), quickProbe);
  await assert.rejects(lifecycle.exclusive(async () => 'ran', 200), StorageBusyError);
  assert.equal((await gateRecord(dir))?.token, 'live');
});

test('a gate with no holder record is reclaimed only after the grace period', async t => {
  const dir = await root(t);
  const gate = await plantGate(dir);
  const lifecycle = new StorageLifecycle(dir, probe(true), quickProbe);
  await assert.rejects(lifecycle.exclusive(async () => 'ran', 200), StorageBusyError);
  const old = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(gate, old, old);
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  assert.equal(await lifecycle.exclusive(async () => 'ran', 2_000), 'ran');
});

test('a holder whose gate was reclaimed and retaken leaves the new holder alone', async t => {
  const dir = await root(t);
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  const lifecycle = new StorageLifecycle(dir, probe(true));
  await lifecycle.exclusive(async () => {
    // Another process judged us dead, removed the gate and took it.
    await fs.rm(path.join(dir, 'gate'), { recursive: true });
    await plantGate(dir, { owner: deadOwner, token: 'theirs', takenAt: Date.now() });
  });
  assert.equal((await gateRecord(dir))?.token, 'theirs');
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('reclaimed while held')));
});

test('a reclaim whose probe resolves after another waiter has retaken the gate leaves that waiter alone', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'dead', takenAt: Date.now() - 60_000 });
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  // Both waiters read the dead holder's record; the slow waiter's probe (a `docker inspect`
  // on a loaded host) answers only once the quick waiter has reclaimed and retaken the gate.
  let answerSlowProbe: (() => void) | undefined;
  const slowProbeAnswered = new Promise<void>(resolve => { answerSlowProbe = resolve; });
  const slowProbe = {
    ...probe(false),
    containerStartedAt: async (host: string) => { if (host === HOST) await slowProbeAnswered; return host === HOST ? null : 1_000; },
  };
  const quick = new StorageLifecycle(dir, probe(false), quickProbe);
  const slow = new StorageLifecycle(dir, slowProbe, quickProbe);
  const events: string[] = [];
  let releaseQuick: (() => void) | undefined;
  const quickReleased = new Promise<void>(resolve => { releaseQuick = resolve; });

  const slowRun = slow.exclusive(async () => { events.push('slow entered'); }, 5_000);
  await new Promise(resolve => setTimeout(resolve, 100)); // the slow waiter is inside its probe
  const quickRun = quick.exclusive(async () => {
    events.push('quick entered');
    const mine = await gateRecord(dir);
    answerSlowProbe?.();
    await new Promise(resolve => setTimeout(resolve, 300)); // the slow waiter's probe resolves and it tries to reclaim
    assert.deepEqual(events, ['quick entered'], 'the slow waiter does not enter while the quick holder is inside');
    assert.deepEqual(await gateRecord(dir), mine, 'the quick holder\'s record survives the stale reclaim');
    await quickReleased;
  }, 5_000);
  releaseQuick?.();
  await Promise.all([quickRun, slowRun]);
  assert.deepEqual(events, ['quick entered', 'slow entered']);
  await assert.rejects(fs.stat(path.join(dir, 'gate')), { code: 'ENOENT' });
  const reclaims = warn.mock.calls.filter(call => String(call.arguments[0]).includes('abandoned storage lifecycle gate'));
  assert.equal(reclaims.length, 1, 'only the waiter whose unlink succeeded reports a reclaim');
  assert.ok(!warn.mock.calls.some(call => String(call.arguments[0]).includes('reclaimed while held')), 'the quick holder released its own gate');
});

/** Holds one of the lifecycle's `fs` calls on `target` until released, after the real call has completed. */
function holdCall(method: 'stat' | 'mkdir', target: string, calls = 1): { holding: () => boolean; release: () => void; restore: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  const original = fs[method] as (...a: unknown[]) => Promise<unknown>;
  const mocked = mock.method(fs, method, async (...args: unknown[]) => {
    const result = await original.apply(fs, args);
    if (args[0] === target && held++ < calls) await gate;
    return result;
  });
  return { holding: () => held > 0, release, restore: () => mocked.mock.restore() };
}
/** Polls until `condition` holds, so the interleavings below do not depend on the host's speed. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('two reclaimers of an ownerless gate never both enter, even when one is late and the other has not yet published', async t => {
  const dir = await root(t);
  const gate = await plantGate(dir);
  const old = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(gate, old, old);
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  // Both waiters complete the age check on the same ownerless directory. A stalls
  // before acting on it; B reclaims and retakes the gate, stalling (if the protocol
  // has such a moment) after creating the gate directory and before publishing its record.
  const staleCheck = holdCall('stat', gate);
  const creation = holdCall('mkdir', gate);
  t.after(async () => { staleCheck.restore(); creation.restore(); });
  const a = new StorageLifecycle(dir, probe(true), quickProbe);
  const b = new StorageLifecycle(dir, probe(true), quickProbe);
  const events: string[] = [];
  const section = (name: string) => async () => {
    events.push(`${name} entered`);
    await new Promise(resolve => setTimeout(resolve, 200));
    events.push(`${name} left`);
  };
  const runA = a.exclusive(section('A'), 5_000);
  await until(() => staleCheck.holding(), 'A is inside its age check');
  const runB = b.exclusive(section('B'), 5_000);
  await until(() => creation.holding() || events.includes('B entered'), 'B has retaken the old gate, or is about to publish its record');
  staleCheck.release(); // A acts on its stale authorization
  await new Promise(resolve => setTimeout(resolve, 100));
  creation.release();
  await Promise.all([runA, runB]);
  assert.equal(events.length, 4, events.join(', '));
  for (let i = 0; i < events.length; i += 2) {
    assert.equal(events[i + 1], events[i].replace('entered', 'left'), `critical sections do not overlap: ${events.join(', ')}`);
  }
  await assert.rejects(fs.stat(gate), { code: 'ENOENT' });
  assert.ok(!warn.mock.calls.some(call => String(call.arguments[0]).includes('reclaimed while held')), 'each holder released its own gate');
});

test('a stale reclaim cannot consume a gate between its creation and its holder\'s record', async t => {
  const dir = await root(t);
  const gate = await plantGate(dir);
  const old = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(gate, old, old);
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  const staleCheck = holdCall('stat', gate);
  t.after(async () => staleCheck.restore());
  const reclaimer = new StorageLifecycle(dir, probe(true), quickProbe);
  const events: string[] = [];
  const runReclaimer = reclaimer.exclusive(async () => {
    events.push('reclaimer entered');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(events, ['reclaimer entered'], 'the acquirer does not enter while the reclaimer holds the gate');
  }, 5_000);
  await until(() => staleCheck.holding(), 'the reclaimer has judged the old gate abandoned');
  staleCheck.restore();
  await fs.rmdir(gate); // the old gate goes away as the reclaimer's check would have it
  // A fresh acquirer creates the gate directory and stalls before publishing its record.
  const creation = holdCall('mkdir', gate);
  t.after(async () => creation.restore());
  const acquirer = new StorageLifecycle(dir, probe(true), quickProbe);
  const runAcquirer = acquirer.exclusive(async () => { events.push('acquirer entered'); }, 5_000);
  await until(() => creation.holding(), 'the acquirer has created the gate directory');
  assert.deepEqual(await fs.readdir(gate), [], 'the acquirer\'s directory exists without a record');
  staleCheck.release(); // the reclaimer acts on its stale authorization against that directory
  await new Promise(resolve => setTimeout(resolve, 50));
  creation.release();
  await Promise.all([runReclaimer, runAcquirer]);
  assert.deepEqual(events, ['reclaimer entered', 'acquirer entered']);
  await assert.rejects(fs.stat(gate), { code: 'ENOENT' });
  assert.ok(!warn.mock.calls.some(call => String(call.arguments[0]).includes('reclaimed while held')), 'each holder released its own gate');
});

test('a wait for the gate is reported, with the holder, instead of staying silent', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'live', takenAt: Date.now() });
  const warnings: string[] = [];
  const warn = mock.method(console, 'warn', (message: unknown) => { warnings.push(String(message)); });
  t.after(async () => warn.mock.restore());
  const lifecycle = new StorageLifecycle(dir, probe(true), { waitWarningMs: 40, ...quickProbe });
  const waiting = lifecycle.use(async () => 'done');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(warnings.some(line => line.includes('Still waiting for the storage lifecycle gate') && line.includes(`pid ${deadOwner.pid}`)), warnings.join('\n'));
  await fs.rm(path.join(dir, 'gate'), { recursive: true }); // the holder finishes
  assert.equal(await waiting, 'done');
});
