import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';
import { up as createPrSplitOperations } from '../packages/core/src/db/migrations/20260804000000_create_pr_split_operations.js';
import {
  normalizeSplitInstruction,
  parseSplitCommand,
} from '../packages/core/src/services/prSplit/command.js';
import {
  authorizeSplitRequester,
  isSplitPermissionAuthorized,
  type PrSplitRequestClient,
} from '../packages/core/src/services/prSplit/authorization.js';
import {
  STALE_SPLIT_OPERATION_ERROR,
  buildSplitOperationDedupeKey,
  buildSplitOperationEventKey,
  createOrGetPrSplitOperation,
  getActivePrSplitOperation,
  getPrSplitOperation,
  heartbeatPrSplitOperation,
  recoverStalePrSplitOperations,
  updatePrSplitOperationStatus,
  type CreatePrSplitOperationInput,
  type PrSplitOperation,
} from '../packages/core/src/services/prSplit/operationStore.js';
import {
  handlePrSplitComment,
  isPrSplitExecutionEnabled,
  type PrSplitIntakeDependencies,
} from '../packages/core/src/services/prSplit/intake.js';
import {
  initializeWebhookHandler,
  processWebhookEvent,
} from '../packages/core/src/webhook/webhookHandler.js';
import { processCommentEvent } from '../packages/core/src/webhook/commentEventHandler.js';
import { pollForPullRequestComments } from '../src/polling/prCommentPolling.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
  await closeConnection();
});

describe('/split command parsing', () => {
  test('accepts an empty instruction and natural-language guidance', () => {
    assert.deepEqual(parseSplitCommand('/split'), { instruction: '' });
    assert.deepEqual(parseSplitCommand('/split extract auth changes'), {
      instruction: 'extract auth changes',
    });
  });

  test('normalizes multiline and repeated instruction whitespace', () => {
    assert.equal(normalizeSplitInstruction('  extract\n\tauth   changes  '), 'extract auth changes');
    assert.deepEqual(parseSplitCommand('/split\n  extract\n\tauth   changes'), {
      instruction: 'extract auth changes',
    });
  });

  test('requires /split to be the exact first command token', () => {
    assert.equal(parseSplitCommand('please /split this PR'), null);
    assert.equal(parseSplitCommand(' /split this PR'), null);
    assert.equal(parseSplitCommand('/review\n/split this PR'), null);
    assert.equal(parseSplitCommand('/splitter this PR'), null);
    assert.equal(parseSplitCommand('/SPLIT this PR'), null);
  });
});

describe('/split repository authorization', () => {
  test('maps only write-like GitHub permissions to authorized', () => {
    for (const permission of ['write', 'maintain', 'admin']) {
      assert.equal(isSplitPermissionAuthorized(permission), true, permission);
    }
    for (const permission of ['read', 'triage', 'none', '', null, undefined]) {
      assert.equal(isSplitPermissionAuthorized(permission), false, String(permission));
    }
  });

  test('uses the collaborator permission endpoint and fails closed on 404', async () => {
    const requestedRoutes: string[] = [];
    const octokit: PrSplitRequestClient = {
      request: mock.fn(async (route: string) => {
        requestedRoutes.push(route);
        return { data: { permission: 'maintain' } };
      }),
    };

    const allowed = await authorizeSplitRequester(octokit, {
      owner: 'integry',
      repo: 'propr',
      username: 'maintainer',
    });
    assert.deepEqual(allowed, { authorized: true, permission: 'maintain' });
    assert.deepEqual(requestedRoutes, [
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
    ]);

    const notFoundClient: PrSplitRequestClient = {
      request: mock.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    };
    const refused = await authorizeSplitRequester(notFoundClient, {
      owner: 'integry',
      repo: 'propr',
      username: 'outside-contributor',
    });
    assert.deepEqual(refused, { authorized: false, permission: null });
  });

  test('distinguishes permission 403s from retryable GitHub failures', async () => {
    const request = { owner: 'integry', repo: 'propr', username: 'maintainer' };
    const permissionError = Object.assign(new Error('Resource not accessible by integration'), {
      status: 403,
      response: { data: { message: 'Resource not accessible by integration' }, headers: {} },
    });
    const permissionClient: PrSplitRequestClient = {
      request: mock.fn(async () => { throw permissionError; }),
    };
    assert.deepEqual(await authorizeSplitRequester(permissionClient, request), {
      authorized: false,
      permission: null,
    });

    const retryableErrors = [
      Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: {
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0' },
        },
      }),
      Object.assign(new Error('Too Many Requests'), { status: 429 }),
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
      Object.assign(new Error('ambiguous GitHub 403'), { status: 403 }),
    ];

    for (const error of retryableErrors) {
      const client: PrSplitRequestClient = {
        request: mock.fn(async () => { throw error; }),
      };
      await assert.rejects(authorizeSplitRequester(client, request), (caught) => caught === error);
    }
  });
});

describe('PR split operation persistence', () => {
  let database: Knex;

  const baseInput: CreatePrSplitOperationInput = {
    repository: 'Integry/ProPR',
    sourcePrNumber: 1735,
    baseRef: '1735-epic-pr-split-rjb',
    baseSha: 'AAA111',
    headSha: 'BBB222',
    requester: 'maintainer',
    originalCommentId: 9001,
    instruction: 'extract auth changes',
  };

  beforeEach(async () => {
    database = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    await createPrSplitOperations(database);
  });

  afterEach(async () => {
    await database.destroy();
  });

  test('generates stable event and semantic keys from all immutable inputs', () => {
    const eventKey = buildSplitOperationEventKey(baseInput);
    assert.equal(eventKey, buildSplitOperationEventKey({
      repository: 'integry/propr',
      originalCommentId: 9001,
    }));
    assert.notEqual(eventKey, buildSplitOperationEventKey({
      repository: 'integry/propr',
      originalCommentId: 9002,
    }));

    const first = buildSplitOperationDedupeKey(baseInput);
    const equivalent = buildSplitOperationDedupeKey({
      ...baseInput,
      repository: 'integry/propr',
      headSha: 'bbb222',
      instruction: '  extract\n auth   changes ',
    });
    const changedInstruction = buildSplitOperationDedupeKey({
      ...baseInput,
      instruction: 'extract database changes',
    });
    const changedHead = buildSplitOperationDedupeKey({ ...baseInput, headSha: 'ccc333' });
    const changedBaseRef = buildSplitOperationDedupeKey({ ...baseInput, baseRef: 'main' });
    const changedBaseSha = buildSplitOperationDedupeKey({ ...baseInput, baseSha: 'ddd444' });

    assert.equal(first, equivalent);
    assert.notEqual(first, changedInstruction);
    assert.notEqual(first, changedHead);
    assert.notEqual(first, changedBaseRef);
    assert.notEqual(first, changedBaseSha);
  });

  test('semantically deduplicates equivalent active commands from different comments', async () => {
    const first = await createOrGetPrSplitOperation(baseInput, database);
    const repeated = await createOrGetPrSplitOperation(
      {
        ...baseInput,
        repository: 'integry/propr',
        originalCommentId: 9002,
        instruction: ' extract  auth\nchanges ',
      },
      database,
    );

    assert.equal(first.outcome, 'created');
    assert.equal(repeated.outcome, 'duplicate');
    if (repeated.outcome === 'duplicate') assert.equal(repeated.duplicateKind, 'semantic');
    assert.equal(repeated.operation.id, first.operation.id);
    assert.equal(repeated.operation.instruction, 'extract auth changes');
    assert.equal(repeated.operation.original_comment_id, 9001);
    assert.equal(repeated.operation.repository, 'Integry/ProPR');
    assert.equal(await database('pr_split_operations').count<{ count: number }>('* as count').first().then(row => Number(row?.count)), 1);
  });

  test('deduplicates the same webhook event after terminal state and input changes', async () => {
    const first = await createOrGetPrSplitOperation(baseInput, database);
    assert.ok(await updatePrSplitOperationStatus(first.operation.id, 'running', {}, database));
    assert.ok(await updatePrSplitOperationStatus(first.operation.id, 'completed', {}, database));

    const replay = await createOrGetPrSplitOperation({
      ...baseInput,
      baseRef: 'main',
      baseSha: 'ccc333',
      headSha: 'ddd444',
      instruction: 'different instruction after webhook retry',
    }, database);

    assert.equal(replay.outcome, 'duplicate');
    if (replay.outcome === 'duplicate') assert.equal(replay.duplicateKind, 'event');
    assert.equal(replay.operation.id, first.operation.id);
    const [{ count }] = await database('pr_split_operations')
      .count<Array<{ count: number }>>('* as count');
    assert.equal(Number(count), 1);
  });

  test('allows a distinct comment to retry an equivalent failed operation', async () => {
    const first = await createOrGetPrSplitOperation(baseInput, database);
    assert.ok(await updatePrSplitOperationStatus(
      first.operation.id,
      'failed',
      { errorMessage: 'worker failed' },
      database,
    ));

    const retry = await createOrGetPrSplitOperation({
      ...baseInput,
      originalCommentId: 9002,
      repository: 'integry/propr',
      instruction: ' extract  auth\nchanges ',
    }, database);

    assert.equal(retry.outcome, 'created');
    assert.notEqual(retry.operation.id, first.operation.id);
  });

  test('enforces one active operation and releases the lock on terminal states', async () => {
    const first = await createOrGetPrSplitOperation(baseInput, database);
    const blocked = await createOrGetPrSplitOperation(
      {
        ...baseInput,
        repository: 'integry/propr',
        originalCommentId: 9002,
        instruction: 'extract API changes',
      },
      database,
    );

    assert.equal(blocked.outcome, 'active');
    assert.equal(blocked.operation.id, first.operation.id);
    assert.equal((await getActivePrSplitOperation('integry/propr', 1735, database))?.id, first.operation.id);

    assert.ok(await updatePrSplitOperationStatus(first.operation.id, 'running', {}, database));
    assert.ok(await updatePrSplitOperationStatus(first.operation.id, 'completed', {}, database));
    assert.equal(await getActivePrSplitOperation(baseInput.repository, 1735, database), null);

    const second = await createOrGetPrSplitOperation(
      { ...baseInput, originalCommentId: 9003, instruction: 'extract API changes' },
      database,
    );
    assert.equal(second.outcome, 'created');
    assert.notEqual(second.operation.id, first.operation.id);

    assert.ok(await updatePrSplitOperationStatus(
      second.operation.id,
      'failed',
      { errorMessage: 'test failure' },
      database,
    ));
    const third = await createOrGetPrSplitOperation(
      { ...baseInput, originalCommentId: 9004, instruction: 'extract UI changes' },
      database,
    );
    assert.equal(third.outcome, 'created');
  });

  test('claims work once and preserves lifecycle timestamp/error invariants', async () => {
    const created = await createOrGetPrSplitOperation(baseInput, database);
    const startedAt = new Date('2030-01-01T00:00:00.000Z');
    const claimed = await updatePrSplitOperationStatus(
      created.operation.id,
      'running',
      { now: startedAt, leaseDurationMs: 60_000 },
      database,
    );
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.started_at, startedAt.toISOString());
    assert.equal(claimed?.finished_at, null);
    assert.equal(claimed?.error_message, null);

    const secondClaim = await updatePrSplitOperationStatus(
      created.operation.id,
      'running',
      { now: new Date('2030-01-01T00:00:05.000Z') },
      database,
    );
    assert.equal(secondClaim, null);

    await database('pr_split_operations')
      .where({ id: created.operation.id })
      .update({ error_message: 'old error' });
    const finishedAt = new Date('2030-01-01T00:01:00.000Z');
    const completed = await updatePrSplitOperationStatus(
      created.operation.id,
      'completed',
      { now: finishedAt },
      database,
    );
    assert.equal(completed?.started_at, startedAt.toISOString());
    assert.equal(completed?.finished_at, finishedAt.toISOString());
    assert.equal(completed?.error_message, null);
    assert.equal(completed?.lease_expires_at, null);

    assert.equal(await updatePrSplitOperationStatus(
      created.operation.id,
      'failed',
      { errorMessage: 'late worker' },
      database,
    ), null);
    assert.equal(await updatePrSplitOperationStatus(
      created.operation.id,
      'running',
      {},
      database,
    ), null);
    assert.equal((await getPrSplitOperation(created.operation.id, database))?.status, 'completed');
  });

  test('heartbeats leases and recovers stale operations before accepting new work', async () => {
    const created = await createOrGetPrSplitOperation(baseInput, database);
    const claimed = await updatePrSplitOperationStatus(
      created.operation.id,
      'running',
      { now: new Date('2030-01-01T00:00:00.000Z'), leaseDurationMs: 1_000 },
      database,
    );
    assert.ok(claimed);

    const heartbeat = await heartbeatPrSplitOperation(
      created.operation.id,
      { now: new Date('2030-01-01T00:00:00.500Z'), leaseDurationMs: 1_000 },
      database,
    );
    assert.equal(heartbeat?.lease_expires_at, '2030-01-01T00:00:01.500Z');
    assert.equal(await recoverStalePrSplitOperations(
      baseInput.repository,
      baseInput.sourcePrNumber,
      database,
      new Date('2030-01-01T00:00:01.000Z'),
    ), 0);
    assert.equal(await recoverStalePrSplitOperations(
      baseInput.repository,
      baseInput.sourcePrNumber,
      database,
      new Date('2030-01-01T00:00:02.000Z'),
    ), 1);

    const stale = await getPrSplitOperation(created.operation.id, database);
    assert.equal(stale?.status, 'failed');
    assert.equal(stale?.error_message, STALE_SPLIT_OPERATION_ERROR);
    assert.equal(stale?.lease_expires_at, null);
    assert.ok(stale?.finished_at);

    const replacement = await createOrGetPrSplitOperation({
      ...baseInput,
      originalCommentId: 9002,
      instruction: 'extract API changes',
    }, database);
    assert.equal(replacement.outcome, 'created');
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
      createOrGetPrSplitOperation(baseInput, database),
      /split trigger failure/,
    );
  });

  test('uses independent SQLite connections to arbitrate a multi-process race', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'propr-split-race-'));
    const filename = path.join(temporaryDirectory, 'operations.sqlite');
    const createDatabase = (): Knex => knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    const firstClient = createDatabase();
    const secondClient = createDatabase();

    try {
      await firstClient.raw('PRAGMA journal_mode = WAL');
      await Promise.all([
        firstClient.raw('PRAGMA busy_timeout = 5000'),
        secondClient.raw('PRAGMA busy_timeout = 5000'),
      ]);
      await createPrSplitOperations(firstClient);

      const results = await Promise.all([
        createOrGetPrSplitOperation(baseInput, firstClient),
        createOrGetPrSplitOperation(
          { ...baseInput, originalCommentId: 9002, instruction: 'extract API changes' },
          secondClient,
        ),
      ]);

      assert.deepEqual(results.map(result => result.outcome).sort(), ['active', 'created']);
      const [{ count }] = await firstClient('pr_split_operations')
        .count<Array<{ count: number }>>('* as count');
      assert.equal(Number(count), 1);
    } finally {
      await Promise.all([firstClient.destroy(), secondClient.destroy()]);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

function issueCommentPayload(body: string, isPullRequest = true): IssueCommentEvent {
  return {
    action: 'created',
    issue: {
      number: 1735,
      ...(isPullRequest ? { pull_request: { url: 'https://api.github.test/pulls/1735' } } : {}),
    },
    comment: {
      id: 9001,
      body,
      user: { login: 'maintainer' },
    },
    repository: {
      name: 'propr',
      full_name: 'integry/propr',
      owner: { login: 'integry' },
    },
  } as unknown as IssueCommentEvent;
}

function operationFixture(): PrSplitOperation {
  return {
    id: '12345678-1234-1234-1234-123456789abc',
    repository: 'integry/propr',
    source_pr_number: 1735,
    base_ref: '1735-epic-pr-split-rjb',
    base_sha: 'aaa111',
    head_sha: 'bbb222',
    requester: 'maintainer',
    original_comment_id: 9001,
    instruction: 'extract auth changes',
    event_key: 'event',
    dedupe_key: 'dedupe',
    status: 'queued',
    error_message: null,
    started_at: null,
    heartbeat_at: '2026-08-04T00:00:00.000Z',
    lease_expires_at: '2026-08-04T00:15:00.000Z',
    finished_at: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
  };
}

describe('/split issue-comment intake', () => {
  test('keeps staged intake disabled unless explicitly enabled', () => {
    assert.equal(isPrSplitExecutionEnabled(undefined), false);
    assert.equal(isPrSplitExecutionEnabled('false'), false);
    assert.equal(isPrSplitExecutionEnabled('1'), true);
    assert.equal(isPrSplitExecutionEnabled('TRUE'), true);
  });

  test('ignores /split on a normal issue before loading GitHub dependencies', async () => {
    const client: PrSplitRequestClient = {
      request: mock.fn(async () => ({ data: [] })),
    };
    const getOctokit = mock.fn(async () => client);
    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes', false),
      'correlation-id',
      { getOctokit },
    );

    assert.deepEqual(result, { handled: false });
    assert.equal(getOctokit.mock.callCount(), 0);
  });

  test('intercepts the command but creates no operation while execution is staged off', async () => {
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: [] };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const authorizeRequester = mock.fn(async () => ({
      authorized: true as const,
      permission: 'write' as const,
    }));
    const createOperation = mock.fn(async () => ({
      outcome: 'created' as const,
      operation: operationFixture(),
    }));

    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes'),
      'correlation-id',
      {
        getOctokit: mock.fn(async () => client),
        authorizeRequester,
        createOperation,
        isExecutionEnabled: () => false,
      },
    );

    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.outcome, 'disabled');
      assert.equal(result.disposition.reason, 'split_execution_not_enabled');
    }
    assert.equal(authorizeRequester.mock.callCount(), 0);
    assert.equal(createOperation.mock.callCount(), 0);
    const postCall = request.mock.calls.find(
      (call) => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    );
    assert.match(String(postCall?.arguments[1].body), /not available yet/i);
  });

  test('posts a refusal and creates no operation for an unauthorized requester', async () => {
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: [] };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const createOperation = mock.fn(async () => ({
      outcome: 'created' as const,
      operation: operationFixture(),
    }));
    const dependencies: PrSplitIntakeDependencies = {
      getOctokit: mock.fn(async () => client),
      authorizeRequester: mock.fn(async () => ({ authorized: false as const, permission: 'read' })),
      createOperation,
      isExecutionEnabled: () => true,
    };

    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes'),
      'correlation-id',
      dependencies,
    );

    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.outcome, 'unauthorized');
      assert.equal(result.disposition.status, 'blocked');
    }
    assert.equal(createOperation.mock.callCount(), 0);
    const postCall = request.mock.calls.find(
      (call) => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    );
    assert.match(String(postCall?.arguments[1].body), /requires.*write.*maintain.*admin/i);
  });

  test('snapshots PR metadata and queues normalized guidance for an authorized requester', async () => {
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            base: { ref: '1735-epic-pr-split-rjb', sha: 'aaa111' },
            head: { sha: 'bbb222' },
          },
        };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: [] };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    let capturedInput: CreatePrSplitOperationInput | undefined;
    const dependencies: PrSplitIntakeDependencies = {
      getOctokit: mock.fn(async () => client),
      authorizeRequester: mock.fn(async () => ({ authorized: true as const, permission: 'write' as const })),
      createOperation: mock.fn(async (input: CreatePrSplitOperationInput) => {
        capturedInput = input;
        return { outcome: 'created' as const, operation: operationFixture() };
      }),
      isExecutionEnabled: () => true,
    };

    const result = await handlePrSplitComment(
      issueCommentPayload('/split   extract\n auth   changes'),
      'correlation-id',
      dependencies,
    );

    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.outcome, 'queued');
      assert.equal(result.disposition.billing?.seatConsumed, false);
      assert.deepEqual(result.disposition.evidence?.triggerCommentIds, [9001]);
    }
    assert.deepEqual(capturedInput, {
      repository: 'integry/propr',
      sourcePrNumber: 1735,
      baseRef: '1735-epic-pr-split-rjb',
      baseSha: 'aaa111',
      headSha: 'bbb222',
      requester: 'maintainer',
      originalCommentId: 9001,
      instruction: 'extract auth changes',
    });
    const postCall = request.mock.calls.find(
      (call) => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    );
    assert.match(String(postCall?.arguments[1].body), /queued/i);
    assert.match(String(postCall?.arguments[1].body), /propr:pr-split-response/);
  });

  test('posts an already-running response when a different operation owns the PR lock', async () => {
    const activeOperation = { ...operationFixture(), status: 'running' as const };
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            base: { ref: '1735-epic-pr-split-rjb', sha: 'aaa111' },
            head: { sha: 'bbb222' },
          },
        };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: [] };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const dependencies: PrSplitIntakeDependencies = {
      getOctokit: mock.fn(async () => client),
      authorizeRequester: mock.fn(async () => ({ authorized: true as const, permission: 'admin' as const })),
      createOperation: mock.fn(async () => ({ outcome: 'active' as const, operation: activeOperation })),
      isExecutionEnabled: () => true,
    };

    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract API changes'),
      'correlation-id',
      dependencies,
    );

    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.outcome, 'active');
      assert.equal(result.disposition.status, 'blocked');
      assert.equal(result.disposition.reason, 'split_operation_already_active');
    }
    const postCall = request.mock.calls.find(
      (call) => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    );
    assert.match(String(postCall?.arguments[1].body), /already running/i);
  });

  test('does not post a second response when its deterministic marker already exists', async () => {
    const eventKey = buildSplitOperationEventKey({
      repository: 'integry/propr',
      originalCommentId: 9001,
    });
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return {
          data: [{
            body: `Already handled <!-- propr:pr-split-response:${eventKey} -->`,
            user: { type: 'Bot' },
          }],
        };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };

    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes'),
      'correlation-id',
      {
        getOctokit: mock.fn(async () => client),
        authorizeRequester: mock.fn(async () => ({
          authorized: false as const,
          permission: 'read',
        })),
        isExecutionEnabled: () => true,
      },
    );

    assert.equal(result.handled && result.outcome, 'unauthorized');
    assert.equal(request.mock.calls.some(
      (call) => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ), false);
  });
});

describe('/split interception boundaries', () => {
  test('processWebhookEvent intercepts /split before the generic comment processor', async () => {
    const commentProcessor = mock.fn(async () => ({ status: 'accepted' as const }));
    const splitCommentHandler = mock.fn(async () => ({
      handled: true as const,
      disposition: {
        status: 'blocked' as const,
        reason: 'split_execution_not_enabled',
        billing: { seatConsumed: false },
      },
      outcome: 'disabled' as const,
    }));
    await initializeWebhookHandler({
      issueProcessor: mock.fn(async () => undefined),
      commentProcessor,
      commentDeletedHandler: mock.fn(async () => undefined),
      commentEditedHandler: mock.fn(async () => undefined),
      splitCommentHandler,
    });

    const disposition = await processWebhookEvent(
      issueCommentPayload('/split extract auth changes'),
      'issue_comment',
      'correlation-id',
    );

    assert.equal(disposition.reason, 'split_execution_not_enabled');
    assert.equal(splitCommentHandler.mock.callCount(), 1);
    assert.equal(commentProcessor.mock.callCount(), 0);
  });

  test('the generic synthetic-comment path skips /split without touching Redis', async () => {
    const redisGet = mock.fn(async () => null);
    const result = await processCommentEvent(
      issueCommentPayload('/split extract auth changes'),
      'issue_comment',
      'synthetic-correlation-id',
      {
        redisClient: { get: redisGet } as unknown as Redis,
        PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
      },
    );

    assert.deepEqual(result, { status: 'ignored', reason: 'not_pull_request_comment' });
    assert.equal(redisGet.mock.callCount(), 0);
  });

  test('generic PR polling skips /split without claiming or enqueueing it', async () => {
    const redisGet = mock.fn(async () => null);
    const paginate = mock.fn(async (endpoint: string): Promise<unknown[]> => {
      if (endpoint === 'GET /repos/{owner}/{repo}/pulls') {
        return [{
          number: 1735,
          title: 'Split this PR',
          labels: [{ name: 'AI' }],
          head: { ref: 'feature' },
        }];
      }
      if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return [{
          id: 9001,
          body: '/split extract auth changes',
          user: { login: 'maintainer' },
          created_at: '2026-08-04T00:00:00.000Z',
        }];
      }
      return [];
    });
    const octokit = {
      paginate: async <T>(endpoint: string, _options: Record<string, unknown>): Promise<T[]> => (
        await paginate(endpoint)
      ) as T[],
    };

    await pollForPullRequestComments(octokit, 'integry/propr', 'poll-correlation-id', {
      redisClient: { get: redisGet } as unknown as Redis,
      PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
      MODEL_LABEL_PATTERN: '^llm-(.+)$',
    });

    assert.equal(paginate.mock.callCount(), 3);
    assert.equal(redisGet.mock.callCount(), 0);
  });
});
