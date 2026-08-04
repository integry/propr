import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import knex, { type Knex } from 'knex';
import { up as createPrSplitTables } from '../../packages/core/src/db/migrations/20260804000000_create_pr_split_operations.js';
import {
  createOrGetPrSplitOperation,
  getPrSplitCommandRecord,
  recordPrSplitCommandOutcome,
} from '../../packages/core/src/services/prSplit/commandStore.js';
import {
  buildSplitOperationDedupeKey,
  buildSplitOperationEventKey,
} from '../../packages/core/src/services/prSplit/keys.js';
import {
  DEFAULT_SPLIT_OPERATION_LEASE_MS,
  STALE_SPLIT_OPERATION_ERROR,
  assertPrSplitOperationLease,
  getActivePrSplitOperation,
  getPrSplitOperation,
  heartbeatPrSplitOperation,
  recoverStalePrSplitOperations,
  updatePrSplitOperationStatus,
} from '../../packages/core/src/services/prSplit/operationStore.js';
import {
  BASE_SPLIT_INPUT,
  createSplitTestDatabase,
  requiredOperation,
} from './helpers.js';

const execFileAsync = promisify(execFile);

describe('PR split command and operation persistence', () => {
  let database: Knex;

  beforeEach(async () => {
    database = await createSplitTestDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  test('keys use immutable repository identity and all snapshot inputs', () => {
    const eventKey = buildSplitOperationEventKey(BASE_SPLIT_INPUT);
    assert.equal(eventKey, buildSplitOperationEventKey({
      repositoryId: BASE_SPLIT_INPUT.repositoryId,
      originalCommentId: BASE_SPLIT_INPUT.originalCommentId,
    }));
    assert.notEqual(eventKey, buildSplitOperationEventKey({
      repositoryId: BASE_SPLIT_INPUT.repositoryId,
      originalCommentId: 9002,
    }));

    const first = buildSplitOperationDedupeKey(BASE_SPLIT_INPUT);
    assert.equal(first, buildSplitOperationDedupeKey({
      ...BASE_SPLIT_INPUT,
      repository: 'integry/renamed',
      headSha: 'bbb222',
      instruction: '  extract\n auth   changes ',
    }));
    for (const changed of [
      { ...BASE_SPLIT_INPUT, repositoryId: 999999 },
      { ...BASE_SPLIT_INPUT, instruction: 'extract database changes' },
      { ...BASE_SPLIT_INPUT, headSha: 'ccc333' },
      { ...BASE_SPLIT_INPUT, baseRef: 'main' },
      { ...BASE_SPLIT_INPUT, baseSha: 'ddd444' },
    ]) {
      assert.notEqual(first, buildSplitOperationDedupeKey(changed));
    }
  });

  test('rejects invalid PR numbers and empty refs or SHAs at persistence boundaries', async () => {
    for (const invalidInput of [
      { ...BASE_SPLIT_INPUT, sourcePrNumber: 0 },
      { ...BASE_SPLIT_INPUT, baseRef: '   ' },
      { ...BASE_SPLIT_INPUT, baseSha: '' },
      { ...BASE_SPLIT_INPUT, headSha: '\n' },
    ]) {
      assert.throws(() => buildSplitOperationDedupeKey(invalidInput), RangeError);
      await assert.rejects(
        createOrGetPrSplitOperation(invalidInput, database),
        RangeError,
      );
    }
  });

  test('preserves the first terminal disposition for non-executable commands', async () => {
    const first = await recordPrSplitCommandOutcome({
      ...BASE_SPLIT_INPUT,
      outcome: 'disabled',
    }, database);
    const replay = await recordPrSplitCommandOutcome({
      ...BASE_SPLIT_INPUT,
      outcome: 'unauthorized',
    }, database);

    assert.equal(first.receipt.outcome, 'disabled');
    assert.equal(first.replayed, false);
    assert.equal(replay.receipt.outcome, 'disabled');
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.requester_id, BASE_SPLIT_INPUT.requesterId);
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 0);
  });

  test('semantically deduplicates distinct comments and stores a receipt for each', async () => {
    const first = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const repeated = await createOrGetPrSplitOperation({
      ...BASE_SPLIT_INPUT,
      repository: 'integry/propr-renamed',
      originalCommentId: 9002,
      instruction: ' extract  auth\nchanges ',
    }, database);

    const firstOperation = requiredOperation(first);
    const repeatedOperation = requiredOperation(repeated);
    assert.equal(first.receipt.outcome, 'queued');
    assert.equal(repeated.receipt.outcome, 'duplicate');
    assert.equal(repeated.receipt.duplicate_kind, 'semantic');
    assert.equal(repeatedOperation.id, firstOperation.id);
    assert.equal(firstOperation.repository_id, BASE_SPLIT_INPUT.repositoryId);
    assert.equal(firstOperation.requester_id, BASE_SPLIT_INPUT.requesterId);
    assert.equal(firstOperation.instruction, 'extract auth changes');
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 1);
    assert.equal(await database('pr_split_command_receipts').count('* as count').first()
      .then(row => Number(row?.count)), 2);
  });

  test('redelivery resolves to its original queued disposition after terminal changes', async () => {
    const first = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const operation = requiredOperation(first);
    const claimed = await updatePrSplitOperationStatus(operation.id, 'running', {}, database);
    assert.ok(claimed?.lease_token);
    assert.ok(await updatePrSplitOperationStatus(
      operation.id,
      'completed',
      { leaseToken: claimed.lease_token },
      database,
    ));

    const replay = await createOrGetPrSplitOperation({
      ...BASE_SPLIT_INPUT,
      baseRef: 'main',
      baseSha: 'ccc333',
      headSha: 'ddd444',
      instruction: 'different instruction after webhook retry',
    }, database);
    assert.equal(replay.receipt.outcome, 'queued');
    assert.equal(replay.replayed, true);
    assert.equal(requiredOperation(replay).id, operation.id);
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 1);
  });

  test('allows a distinct comment to retry an equivalent failed operation', async () => {
    const first = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const firstOperation = requiredOperation(first);
    assert.ok(await updatePrSplitOperationStatus(
      firstOperation.id,
      'failed',
      { errorMessage: 'worker failed' },
      database,
    ));

    const retry = await createOrGetPrSplitOperation({
      ...BASE_SPLIT_INPUT,
      originalCommentId: 9002,
      instruction: ' extract  auth\nchanges ',
    }, database);
    assert.equal(retry.receipt.outcome, 'queued');
    assert.notEqual(requiredOperation(retry).id, firstOperation.id);
  });

  test('keys the active mutex by repository ID and keeps active refusals terminal', async () => {
    const first = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const firstOperation = requiredOperation(first);
    const blockedInput = {
      ...BASE_SPLIT_INPUT,
      repository: 'integry/propr-renamed',
      originalCommentId: 9002,
      instruction: 'extract API changes',
    };
    const blocked = await createOrGetPrSplitOperation(blockedInput, database);
    assert.equal(blocked.receipt.outcome, 'active');
    assert.equal(blocked.receipt.repository, 'integry/propr-renamed');
    assert.equal(requiredOperation(blocked).id, firstOperation.id);
    assert.equal(
      (await getActivePrSplitOperation(BASE_SPLIT_INPUT.repositoryId, 1735, database))?.id,
      firstOperation.id,
    );

    const claimed = await updatePrSplitOperationStatus(firstOperation.id, 'running', {}, database);
    assert.ok(claimed?.lease_token);
    assert.ok(await updatePrSplitOperationStatus(
      firstOperation.id,
      'completed',
      { leaseToken: claimed.lease_token },
      database,
    ));
    const replay = await createOrGetPrSplitOperation(blockedInput, database);
    assert.equal(replay.receipt.outcome, 'active');
    assert.equal(replay.replayed, true);
    assert.equal(requiredOperation(replay).id, firstOperation.id);

    const next = await createOrGetPrSplitOperation({
      ...blockedInput,
      originalCommentId: 9003,
    }, database);
    assert.equal(next.receipt.outcome, 'queued');
    assert.notEqual(requiredOperation(next).id, firstOperation.id);
  });

  test('fences claims, heartbeats, side effects, and terminal transitions', async () => {
    const created = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const operation = requiredOperation(created);
    const startedAt = new Date(new Date(operation.created_at).getTime() + 1_000);
    const claimed = await updatePrSplitOperationStatus(
      operation.id,
      'running',
      { now: startedAt, leaseDurationMs: 60_000 },
      database,
    );
    assert.ok(claimed?.lease_token);
    assert.equal(claimed.started_at, startedAt.toISOString());
    assert.equal(await updatePrSplitOperationStatus(
      operation.id,
      'running',
      { now: new Date(startedAt.getTime() + 1_000) },
      database,
    ), null);
    assert.equal(await heartbeatPrSplitOperation(
      operation.id,
      { leaseToken: 'stale-token', now: new Date(startedAt.getTime() + 2_000) },
      database,
    ), null);

    const heartbeatAt = new Date(startedAt.getTime() + 5_000);
    const heartbeat = await heartbeatPrSplitOperation(
      operation.id,
      { leaseToken: claimed.lease_token, now: heartbeatAt, leaseDurationMs: 60_000 },
      database,
    );
    assert.ok(heartbeat);
    assert.ok(await assertPrSplitOperationLease(
      operation.id,
      claimed.lease_token,
      database,
      new Date(heartbeatAt.getTime() + 1_000),
    ));
    assert.equal(await updatePrSplitOperationStatus(
      operation.id,
      'completed',
      { leaseToken: 'stale-token', now: new Date(heartbeatAt.getTime() + 2_000) },
      database,
    ), null);

    const finishedAt = new Date(heartbeatAt.getTime() + 3_000);
    const completed = await updatePrSplitOperationStatus(
      operation.id,
      'completed',
      { leaseToken: claimed.lease_token, now: finishedAt },
      database,
    );
    assert.equal(completed?.finished_at, finishedAt.toISOString());
    assert.equal(completed?.lease_expires_at, null);
    assert.equal(completed?.lease_token, null);
  });

  test('keeps queued backlogs claimable and recovers only expired running leases', async () => {
    const queued = await createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database);
    const queuedOperation = requiredOperation(queued);
    assert.equal(queuedOperation.heartbeat_at, null);
    assert.equal(queuedOperation.lease_expires_at, null);

    const afterLongBacklog = new Date(
      new Date(queuedOperation.created_at).getTime() + DEFAULT_SPLIT_OPERATION_LEASE_MS + 1,
    );
    assert.equal(await recoverStalePrSplitOperations(
      BASE_SPLIT_INPUT.repositoryId,
      BASE_SPLIT_INPUT.sourcePrNumber,
      database,
      afterLongBacklog,
    ), 0);
    const claimed = await updatePrSplitOperationStatus(
      queuedOperation.id,
      'running',
      { now: afterLongBacklog, leaseDurationMs: 1_000 },
      database,
    );
    assert.ok(claimed?.lease_token);
    const expiredAt = new Date(afterLongBacklog.getTime() + 1_000);
    assert.equal(await assertPrSplitOperationLease(
      queuedOperation.id,
      claimed.lease_token,
      database,
      expiredAt,
    ), null);
    assert.equal(await updatePrSplitOperationStatus(
      queuedOperation.id,
      'completed',
      { now: expiredAt, leaseToken: claimed.lease_token },
      database,
    ), null);
    assert.equal(await recoverStalePrSplitOperations(
      BASE_SPLIT_INPUT.repositoryId,
      BASE_SPLIT_INPUT.sourcePrNumber,
      database,
      expiredAt,
    ), 1);
    assert.equal((await getPrSplitOperation(queuedOperation.id, database))?.error_message,
      STALE_SPLIT_OPERATION_ERROR);
  });

  test('does not hide non-unique SQLite constraint failures', async () => {
    await database.raw(`
      CREATE TRIGGER reject_split_insert
      BEFORE INSERT ON pr_split_operations
      BEGIN
        SELECT RAISE(ABORT, 'split trigger failure');
      END
    `);
    await assert.rejects(
      createOrGetPrSplitOperation(BASE_SPLIT_INPUT, database),
      /split trigger failure/,
    );
    assert.equal(await getPrSplitCommandRecord(BASE_SPLIT_INPUT, database), null);
  });

  test('uses separate processes to arbitrate a genuinely concurrent SQLite race', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'propr-split-race-'));
    const filename = path.join(temporaryDirectory, 'operations.sqlite');
    const verificationDatabase = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });

    try {
      await verificationDatabase.raw('PRAGMA journal_mode = WAL');
      await createPrSplitTables(verificationDatabase);
      const childScript = path.resolve('test/prSplit/operationRaceChild.ts');
      const startAt = Date.now() + 500;
      const runChild = async (input: typeof BASE_SPLIT_INPUT) => {
        const { stdout } = await execFileAsync(process.execPath, [
          '--import',
          'tsx',
          childScript,
          filename,
          JSON.stringify(input),
          String(startAt),
        ]);
        return JSON.parse(stdout) as { outcome: string; processId: number };
      };
      const results = await Promise.all([
        runChild(BASE_SPLIT_INPUT),
        runChild({
          ...BASE_SPLIT_INPUT,
          originalCommentId: 9002,
          instruction: 'extract API changes',
        }),
      ]);
      assert.notEqual(results[0]?.processId, results[1]?.processId);
      assert.deepEqual(
        results.map(result => result.outcome).sort(),
        ['active', 'queued'],
      );
      assert.equal(await verificationDatabase('pr_split_operations').count('* as count').first()
        .then(row => Number(row?.count)), 1);
      assert.equal(await verificationDatabase('pr_split_command_receipts').count('* as count').first()
        .then(row => Number(row?.count)), 2);
    } finally {
      await verificationDatabase.destroy();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
