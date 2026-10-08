import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUsageTipsSelectionRunner, type UsageTipsRunnerDependencies } from '../src/usageTipsSelectionRunner.js';
import type { UsageTipSelection } from '@propr/shared';

function fixture() {
  let selected: UsageTipSelection | null = null;
  let enabled = true;
  let now = 1_000_000;
  let owner: string | null = null;
  let selections = 0;
  const epochs: number[] = [];
  const deps: UsageTipsRunnerDependencies = {
    redis: {
      set: async (_key: string, token: string) => { if (owner) return null; owner = token; return 'OK'; },
      eval: async (script: string, _n: number, _key: string, token: string) => {
        if (owner !== token) return 0;
        if (script.includes("'del'")) owner = null;
        return 1;
      },
    } as UsageTipsRunnerDependencies['redis'],
    store: {
      settings: async () => ({ enabled }),
      current: async () => selected,
      persist: async (next, previous) => {
        if (previous !== (selected?.rotationEpoch ?? null)) return false;
        selected = next; return true;
      },
    },
    collect: async () => ({ tasks: 12 }),
    select: async (signals, epoch) => {
      selections++; epochs.push(epoch);
      return { candidates: [], source: 'heuristic', signals, rotationEpoch: epoch, generatedAt: now, model: null };
    },
    now: () => now,
  };
  return { deps, epochs, get selections() { return selections; }, get selected() { return selected; },
    disable() { enabled = false; }, advance() { now += 86_400_000; }, loseLease() { owner = 'someone-else'; },
    replace: (value: UsageTipSelection) => { selected = value; } };
}

test('replicas and overlapping ticks select once per day; reloads do not advance epochs', async () => {
  const f = fixture();
  const a = createUsageTipsSelectionRunner(f.deps);
  const b = createUsageTipsSelectionRunner(f.deps);
  await Promise.all([a.run(), a.run(), b.run()]);
  assert.equal(f.selections, 1); assert.deepEqual(f.epochs, [0]);
  assert.equal(await a.run(), false);
  f.advance(); assert.equal(await b.run(), true); assert.deepEqual(f.epochs, [0, 1]);
  f.advance(); f.disable(); assert.equal(await a.run(), false); assert.equal(f.selections, 2);
});

test('failed runs retain epoch; persistence failure does not consume it', async () => {
  const f = fixture();
  const persist = f.deps.store.persist;
  f.deps.store.persist = async () => { throw new Error('database offline'); };
  const runner = createUsageTipsSelectionRunner(f.deps);
  assert.equal(await runner.run(), false);
  assert.equal(f.selected, null);
  f.deps.store.persist = persist;
  assert.equal(await runner.run(), true);
  assert.deepEqual(f.epochs, [0, 0]);
});

test('freshness and enablement are rechecked after acquisition', async () => {
  for (const change of ['disabled', 'fresh']) {
    const f = fixture();
    const set = f.deps.redis.set;
    f.deps.redis.set = (async (...args: Parameters<typeof set>) => {
      const result = await set(...args);
      if (change === 'disabled') f.disable();
      else f.replace({ candidates: [], generatedAt: 1_000_000, source: 'heuristic', model: null, signals: {}, rotationEpoch: 5 });
      return result;
    }) as typeof set;
    assert.equal(await createUsageTipsSelectionRunner(f.deps).run(), false);
    assert.equal(f.selections, 0);
  }
});

test('lost leases and disablement during model calls cannot persist', async () => {
  for (const change of ['disabled', 'lost']) {
    const f = fixture();
    const select = f.deps.select;
    f.deps.select = async (...args) => {
      if (change === 'disabled') f.disable(); else f.loseLease();
      return select(...args);
    };
    assert.equal(await createUsageTipsSelectionRunner(f.deps).run(), false);
    assert.equal(f.selected, null);
  }
});

test('long model runs renew ownership', async () => {
  const f = fixture();
  f.deps.leaseMs = 30;
  let renewals = 0;
  const evaluate = f.deps.redis.eval;
  f.deps.redis.eval = (async (...args: Parameters<typeof evaluate>) => {
    if (String(args[0]).includes('pexpire')) renewals++;
    return evaluate(...args);
  }) as typeof evaluate;
  const select = f.deps.select;
  f.deps.select = async (...args) => { await new Promise(resolve => setTimeout(resolve, 50)); return select(...args); };
  assert.equal(await createUsageTipsSelectionRunner(f.deps).run(), true);
  assert.ok(renewals >= 3);
});
