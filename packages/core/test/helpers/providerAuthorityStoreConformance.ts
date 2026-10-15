import assert from 'node:assert/strict';
import type { HostedAuthorityStore, StoredAuthority } from '../../src/providerAuthority/index.js';

/** Reusable deterministic adapter contract. Later Fleet adapters should run this
 * against independently opened handles backed by the same control root. */
export async function providerAuthorityStoreConformance(open: () => Promise<HostedAuthorityStore>) {
  const a = await open(); const b = await open();
  const key = 'conformance:isolated-control-root';
  assert.equal(await a.read(key), null);
  const creates = await Promise.all([a.compareAndSwap(key, null, 'first'), b.compareAndSwap(key, null, 'second')]);
  assert.equal(creates.filter(Boolean).length, 1);
  const first = (await b.read(key))!;
  assert.equal(first.revision, 0);
  assert.equal(first.bytes, creates[0] ? 'first' : 'second');
  const detached = (await a.read(key))! as { revision: number; bytes: string };
  detached.bytes = 'caller-mutation';
  assert.deepEqual(await b.read(key), first);
  assert.equal(await a.compareAndSwap(key, null, 'overwrite'), false);
  assert.equal(await a.compareAndSwap(key, first.revision + 1, 'skip'), false);
  assert.deepEqual(await a.read(key), first);
  const updates = await Promise.all([a.compareAndSwap(key, first.revision, 'next-a'), b.compareAndSwap(key, first.revision, 'next-b')]);
  assert.equal(updates.filter(Boolean).length, 1);
  const second = (await (await open()).read(key))!;
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.bytes, updates[0] ? 'next-a' : 'next-b');
  assert.equal(await b.compareAndSwap(key, first.revision, 'stale'), false);
  assert.deepEqual(await b.read(key), second);
}

/** Test fixture only. Never exported by Core, never accepted as a default. */
export class TestControlRoot implements HostedAuthorityStore {
  readonly custody = 'durable-permissioned-control-root' as const;
  constructor(readonly rows = new Map<string, StoredAuthority>()) {}
  fault: 'before-read' | 'after-read' | 'before-cas' | 'after-cas' | undefined;
  fail(point: typeof this.fault) {
    if (this.fault === point) { this.fault = undefined; throw new Error('PRIVATE-LOCATOR-SECRET-IN-ADAPTER-ERROR'); }
  }
  async read(key: string) {
    this.fail('before-read');
    const result = this.rows.get(key);
    this.fail('after-read');
    return result ? structuredClone(result) : null;
  }
  async compareAndSwap(key: string, expected: number | null, bytes: string) {
    this.fail('before-cas');
    const prior = this.rows.get(key);
    if (expected === null ? !!prior : !prior || prior.revision !== expected) return false;
    this.rows.set(key, { revision: prior ? prior.revision + 1 : 0, bytes });
    this.fail('after-cas');
    return true;
  }
}
