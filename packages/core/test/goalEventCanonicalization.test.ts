import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { GoalError, GoalRepository } from '../src/services/goals/goalRepository.js';
import {
  CANONICAL_JSON_MAX_BYTES,
  CANONICAL_JSON_MAX_DEPTH,
  CANONICAL_JSON_MAX_NODES,
  canonicalizeRuntimeJson,
  canonicalizeStoredJson,
} from '../src/services/goals/strictCanonicalJson.js';

let database: Knex;
let repository: GoalRepository;
let goalId: string;
let fence: { leaseOwner: string; leaseEpoch: number };

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
}

async function append(payload: unknown, idempotencyKey: string) {
  return repository.appendInternalEvent(goalId, {
    kind: 'domain',
    eventType: 'canonical-test',
    payload,
    idempotencyKey,
    ...fence,
  });
}

async function expectValidation(payload: unknown, idempotencyKey: string): Promise<void> {
  await assert.rejects(
    append(payload, idempotencyKey),
    (error: GoalError) => error.code === 'goal_validation_error' && error.status === 400
  );
}

async function installLegacyRow(idempotencyKey: string, payloadJson: string, sequence: number): Promise<void> {
  await database('goal_events').insert({
    goal_id: goalId,
    sequence,
    kind: 'domain',
    event_type: 'canonical-test',
    payload_json: payloadJson,
    idempotency_key: idempotencyKey,
    lease_epoch: fence.leaseEpoch,
    created_at: '2026-08-31T00:00:00.000Z',
  });
}

function nestedValue(kind: 'array' | 'object', depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    value = kind === 'array' ? [value] : { value };
  }
  return value;
}

function wideObject(memberCount: number): Record<string, null> {
  return Object.fromEntries(Array.from(
    { length: memberCount },
    (_, index) => [`k${String(index).padStart(4, '0')}`, null]
  ));
}

beforeEach(async () => {
  if (database) await database.destroy();
  database = createDatabase();
  await up(database);
  repository = new GoalRepository(database);
  const goal = await repository.createGoal({
    ownerUserId: 'canonical-owner',
    repository: 'integry/propr',
    objective: 'Keep event retries lossless',
    agent: 'codex',
    requestedModel: 'gpt-5.6-sol',
  });
  goalId = goal.goalId;
  const lease = await repository.claimLease(goalId, 'canonical-controller', 60_000);
  fence = { leaseOwner: 'canonical-controller', leaseEpoch: lease.epoch };
});

after(async () => {
  if (database) await database.destroy();
});

describe('strict event payload canonicalization', () => {
  test('constrains persisted event sources to the internal and provider trust domains', async () => {
    await assert.rejects(database('goal_events').insert({
      goal_id: goalId,
      sequence: 1,
      source: 'scheduler',
      kind: 'domain',
      event_type: 'canonical-test',
      payload_json: null,
      idempotency_key: 'invalid-source',
      lease_epoch: fence.leaseEpoch,
      created_at: '2026-08-31T00:00:00.000Z',
    }));
    assert.equal(Number((await database('goal_events').count({ count: '*' }).first())?.count), 0);
  });

  test('rejects an internal retry that collides with a provider event', async () => {
    await database('goal_events').insert({
      goal_id: goalId,
      sequence: 1,
      source: 'provider',
      kind: 'domain',
      event_type: 'canonical-test',
      payload_json: '{"value":1}',
      idempotency_key: 'cross-source-retry',
      lease_epoch: fence.leaseEpoch,
      created_at: '2026-08-31T00:00:00.000Z',
    });

    await assert.rejects(
      append({ value: 1 }, 'cross-source-retry'),
      (error: GoalError) => error.code === 'goal_idempotency_conflict' && error.status === 409
    );
    const rows = await database('goal_events').where({ goal_id: goalId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'provider');
  });

  test('replays exact and recursively reordered safe payloads without changing array order or scalar types', async () => {
    const firstPayload = {
      z: [{ order: 1, nested: { beta: true, alpha: null } }, '1', 1, 0.1],
      a: { exponent: 1e-7, integer: 42, negative: -3 },
    };
    const first = await append(firstPayload, 'safe-retry');
    const exact = await append(firstPayload, 'safe-retry');
    const reordered = await append({
      a: { negative: -3, integer: 42, exponent: 0.0000001 },
      z: [{ nested: { alpha: null, beta: true }, order: 1 }, '1', 1, 0.1],
    }, 'safe-retry');

    assert.equal(exact.id, first.id);
    assert.equal(reordered.id, first.id);
    assert.equal(await repository.getLatestSequence(goalId), 1);
    const row = await database('goal_events').where({ goal_id: goalId }).first<{ payload_json: string }>();
    assert.equal(
      row?.payload_json,
      '{"a":{"exponent":1e-7,"integer":42,"negative":-3},"z":[{"nested":{"alpha":null,"beta":true},"order":1},"1",1,0.1]}'
    );
  });

  test('distinguishes arrays, null, numbers, strings, and absent payloads without consuming a sequence', async () => {
    await append({ value: [1, 2], typed: null }, 'different-retry');
    for (const payload of [
      { value: [2, 1], typed: null },
      { value: [1, 2], typed: 0 },
      { value: [1, 2], typed: 'null' },
    ]) {
      await assert.rejects(
        append(payload, 'different-retry'),
        (error: GoalError) => error.code === 'goal_idempotency_conflict'
      );
    }
    await assert.rejects(
      repository.appendInternalEvent(goalId, {
        kind: 'domain', eventType: 'canonical-test', idempotencyKey: 'different-retry', ...fence,
      }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );

    const next = await append({ accepted: true }, 'next-event');
    assert.equal(next.sequence, 2);
    assert.equal((await repository.readEvents(goalId)).events.length, 2);
  });

  test('rejects non-finite, undefined, sparse, cyclic, non-plain, and unsupported runtime values before mutation', async () => {
    const sparse = new Array(2);
    sparse[1] = 'present';
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const withSymbolKey = { safe: true } as Record<PropertyKey, unknown>;
    withSymbolKey[Symbol('hidden')] = 'value';
    const withExtraArrayProperty = [1] as unknown[] & { extra?: string };
    withExtraArrayProperty.extra = 'value';
    let getterCalls = 0;
    const withGetter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'value';
      },
    });
    class CustomValue {
      value = 'custom';
    }
    const cases: Array<[string, unknown]> = [
      ['nan', { value: Number.NaN }],
      ['positive-infinity', { value: Number.POSITIVE_INFINITY }],
      ['negative-infinity', [Number.NEGATIVE_INFINITY]],
      ['negative-zero', { value: -0 }],
      ['unsafe-runtime-integer', { value: 9_007_199_254_740_992 }],
      ['top-level-undefined', undefined],
      ['object-undefined', { value: undefined }],
      ['array-undefined', [undefined]],
      ['sparse-array', sparse],
      ['cyclic-object', cyclic],
      ['date', new Date('2026-08-31T00:00:00.000Z')],
      ['map', new Map([['key', 'value']])],
      ['custom-instance', new CustomValue()],
      ['bigint', { value: 1n }],
      ['symbol', { value: Symbol('value') }],
      ['function', { value: () => 'value' }],
      ['symbol-key', withSymbolKey],
      ['extra-array-property', withExtraArrayProperty],
      ['accessor', withGetter],
      ['proxy', new Proxy({ value: true }, {})],
    ];

    for (const [name, value] of cases) await expectValidation(value, `invalid-${name}`);

    assert.equal(getterCalls, 0);
    assert.equal(Number((await database('goal_events').count({ count: '*' }).first())?.count), 0);
    assert.equal(Number((await database('goal_idempotency_keys').count({ count: '*' }).first())?.count), 0);
  });

  test('rejects explicit undefined but preserves the supported absent-payload event form', async () => {
    await assert.rejects(
      repository.appendInternalEvent(goalId, {
        kind: 'domain', eventType: 'canonical-test', payload: undefined,
        idempotencyKey: 'explicit-undefined', ...fence,
      }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    const event = await repository.appendInternalEvent(goalId, {
      kind: 'domain', eventType: 'canonical-test', idempotencyKey: 'absent-payload', ...fence,
    });
    assert.equal(event.payload, null);
    assert.equal(event.sequence, 1);
  });

  test('matches safe reordered legacy JSON and equivalent safe numeric spellings', async () => {
    await installLegacyRow(
      'legacy-safe',
      '{ "nested": { "second": 2.00, "first": 1e0 }, "fraction": 0.0000001 }',
      1
    );
    const replay = await append({ fraction: 1e-7, nested: { first: 1, second: 2 } }, 'legacy-safe');
    assert.equal(replay.sequence, 1);
    assert.deepEqual(replay.payload, { nested: { second: 2, first: 1 }, fraction: 1e-7 });
    assert.equal(await repository.getLatestSequence(goalId), 1);
  });

  test('fails closed on lossy or corrupt legacy rows and never consumes a new sequence', async () => {
    const legacyRows = [
      ['legacy-overflow', '{"value":1e400}'],
      ['legacy-unsafe-integer', '{"value":9007199254740993}'],
      ['legacy-rounded-decimal', '{"value":0.10000000000000001}'],
      ['legacy-underflow', '{"value":1e-400}'],
      ['legacy-duplicate-key', '{"value":1,"value":2}'],
      ['legacy-malformed', '{"value":'],
    ] as const;
    for (const [index, [key, raw]] of legacyRows.entries()) {
      await installLegacyRow(key, raw, index + 1);
      await assert.rejects(
        append({ value: index }, key),
        (error: GoalError) => error.code === 'goal_idempotency_conflict' && error.status === 409
      );
    }

    assert.equal(await repository.getLatestSequence(goalId), legacyRows.length);
    assert.equal(Number((await database('goal_events').count({ count: '*' }).first())?.count), legacyRows.length);
    assert.equal(Number((await database('goal_idempotency_keys').count({ count: '*' }).first())?.count), 0);
    const next = await append({ safe: true }, 'post-corruption');
    assert.equal(next.sequence, legacyRows.length + 1);
  });

  test('applies the same exact depth boundary to runtime and stored arrays and objects', () => {
    for (const kind of ['array', 'object'] as const) {
      const exact = nestedValue(kind, CANONICAL_JSON_MAX_DEPTH);
      const over = nestedValue(kind, CANONICAL_JSON_MAX_DEPTH + 1);
      const exactStored = JSON.stringify(exact);
      const overStored = JSON.stringify(over);

      assert.equal(canonicalizeRuntimeJson(exact), exactStored, `${kind} runtime exact boundary`);
      assert.equal(canonicalizeStoredJson(exactStored), exactStored, `${kind} stored exact boundary`);
      assert.throws(() => canonicalizeRuntimeJson(over), /depth limit/, `${kind} runtime over boundary`);
      assert.throws(() => canonicalizeStoredJson(overStored), /depth limit/, `${kind} stored over boundary`);
    }
  });

  test('counts every array element and object member occurrence at the exact node boundary', () => {
    const matrix = [
      {
        kind: 'array',
        exact: new Array(CANONICAL_JSON_MAX_NODES - 1).fill(null),
        over: new Array(CANONICAL_JSON_MAX_NODES).fill(null),
      },
      {
        kind: 'object',
        exact: wideObject(CANONICAL_JSON_MAX_NODES - 1),
        over: wideObject(CANONICAL_JSON_MAX_NODES),
      },
    ] as const;

    for (const { kind, exact, over } of matrix) {
      const exactStored = JSON.stringify(exact);
      const overStored = JSON.stringify(over);
      assert.doesNotThrow(() => canonicalizeRuntimeJson(exact), `${kind} runtime exact boundary`);
      assert.doesNotThrow(() => canonicalizeStoredJson(exactStored), `${kind} stored exact boundary`);
      assert.throws(() => canonicalizeRuntimeJson(over), /node limit/, `${kind} runtime over boundary`);
      assert.throws(() => canonicalizeStoredJson(overStored), /node limit/, `${kind} stored over boundary`);
    }
  });

  test('accounts for every canonical UTF-8 token at the exact byte boundary', () => {
    const escapedKey = '"\n😀';
    const base = { [escapedKey]: '', array: [null, true, false, 1e-7] };
    const fillerLength = CANONICAL_JSON_MAX_BYTES - Buffer.byteLength(JSON.stringify(base), 'utf8');
    const exact = { [escapedKey]: 'x'.repeat(fillerLength), array: [null, true, false, 1e-7] };
    const over = { [escapedKey]: `${'x'.repeat(fillerLength)}x`, array: [null, true, false, 1e-7] };
    const exactStored = JSON.stringify(exact);
    const overStored = JSON.stringify(over);

    assert.equal(Buffer.byteLength(exactStored, 'utf8'), CANONICAL_JSON_MAX_BYTES);
    assert.equal(canonicalizeRuntimeJson(exact), exactStored);
    assert.equal(canonicalizeStoredJson(exactStored), exactStored);
    assert.throws(() => canonicalizeRuntimeJson(over), /byte limit/);
    assert.throws(() => canonicalizeStoredJson(overStored), /byte limit/);

    const unpairedSurrogates = '\ud800'.repeat(Math.floor(CANONICAL_JSON_MAX_BYTES / 6) + 1);
    const canonicallyOversizedStored = `"${unpairedSurrogates}"`;
    assert.ok(Buffer.byteLength(canonicallyOversizedStored, 'utf8') < CANONICAL_JSON_MAX_BYTES);
    assert.throws(() => canonicalizeStoredJson(canonicallyOversizedStored), /byte limit/);
  });

  test('promptly rejects exponential shared-DAG expansion without persistence side effects', {
    timeout: 3_000,
  }, async () => {
    const sharedLeaf = { value: true };
    let expanded: Record<string, unknown> = sharedLeaf;
    let fullyExpandedBytes = Buffer.byteLength(JSON.stringify(sharedLeaf), 'utf8');
    for (let depth = 0; depth < 22; depth += 1) {
      expanded = { a: expanded, b: expanded };
      fullyExpandedBytes = 11 + (2 * fullyExpandedBytes);
    }
    assert.ok(fullyExpandedBytes > 90_000_000);

    const startedAt = performance.now();
    assert.throws(() => canonicalizeRuntimeJson(expanded), /node limit/);
    await expectValidation(expanded, 'shared-dag-expansion');
    assert.ok(performance.now() - startedAt < 2_000, 'shared DAG rejection exceeded two seconds');

    assert.equal(await repository.getLatestSequence(goalId), 0);
    assert.equal(Number((await database('goal_events').count({ count: '*' }).first())?.count), 0);
    assert.equal(Number((await database('goal_idempotency_keys').count({ count: '*' }).first())?.count), 0);

    const accepted = await append({ left: sharedLeaf, right: sharedLeaf }, 'bounded-shared-reference');
    assert.equal(accepted.sequence, 1);
    assert.deepEqual(accepted.payload, {
      left: { value: true },
      right: { value: true },
    });
  });
});
