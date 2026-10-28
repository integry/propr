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
async function plantGate(dir: string, record?: object): Promise<string> {
  const gate = path.join(dir, 'gate');
  await fs.mkdir(gate, { recursive: true });
  if (record) await fs.writeFile(path.join(gate, 'owner'), JSON.stringify(record));
  return gate;
}

test('the holder records itself in the gate and removes the gate when done', async t => {
  const dir = await root(t);
  const lifecycle = new StorageLifecycle(dir, probe(true));
  const seen = await lifecycle.exclusive(async () => JSON.parse(await fs.readFile(path.join(dir, 'gate', 'owner'), 'utf8')));
  assert.equal(seen.owner.pid, process.pid);
  assert.equal(typeof seen.token, 'string');
  await assert.rejects(fs.stat(path.join(dir, 'gate')), { code: 'ENOENT' });
});

test('a gate whose holder is gone is reclaimed instead of waited on forever', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'old', takenAt: Date.now() });
  const warn = mock.method(console, 'warn', () => undefined);
  t.after(async () => warn.mock.restore());
  const lifecycle = new StorageLifecycle(dir, probe(false));
  assert.equal(await lifecycle.exclusive(async () => 'ran', 2_000), 'ran');
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('abandoned storage lifecycle gate')));
});

test('a gate held by a live process is respected', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'live', takenAt: Date.now() });
  const lifecycle = new StorageLifecycle(dir, probe(true));
  await assert.rejects(lifecycle.exclusive(async () => 'ran', 200), StorageBusyError);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'gate', 'owner'), 'utf8')).token, 'live');
});

test('a gate with no holder record is reclaimed only after the grace period', async t => {
  const dir = await root(t);
  const gate = await plantGate(dir);
  const lifecycle = new StorageLifecycle(dir, probe(true));
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
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'gate', 'owner'), 'utf8')).token, 'theirs');
});

test('a wait for the gate is reported, with the holder, instead of staying silent', async t => {
  const dir = await root(t);
  await plantGate(dir, { owner: deadOwner, token: 'live', takenAt: Date.now() });
  const warnings: string[] = [];
  const warn = mock.method(console, 'warn', (message: unknown) => { warnings.push(String(message)); });
  t.after(async () => warn.mock.restore());
  const lifecycle = new StorageLifecycle(dir, probe(true), { waitWarningMs: 40 });
  const waiting = lifecycle.use(async () => 'done');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(warnings.some(line => line.includes('Still waiting for the storage lifecycle gate') && line.includes(`pid ${deadOwner.pid}`)), warnings.join('\n'));
  await fs.rm(path.join(dir, 'gate'), { recursive: true }); // the holder finishes
  assert.equal(await waiting, 'done');
});
