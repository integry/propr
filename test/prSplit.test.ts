import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import knex, { type Knex } from 'knex';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { up as createPrSplitOperations } from '../packages/core/src/db/migrations/20260804000000_create_pr_split_operations.js';
import {
  normalizeSplitInstruction,
  parseSplitCommand,
} from '../packages/core/src/services/prSplit/command.js';
import {
  authorizeSplitRequester,
  isSplitPermissionAuthorized,
} from '../packages/core/src/services/prSplit/authorization.js';
import {
  buildSplitOperationDedupeKey,
  createOrGetPrSplitOperation,
  getActivePrSplitOperation,
  updatePrSplitOperationStatus,
  type CreatePrSplitOperationInput,
  type PrSplitOperation,
} from '../packages/core/src/services/prSplit/operationStore.js';
import {
  handlePrSplitComment,
  type PrSplitIntakeDependencies,
} from '../packages/core/src/services/prSplit/intake.js';

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
    const octokit = {
      request: mock.fn(async (route: string) => {
        requestedRoutes.push(route);
        return { data: { permission: 'maintain' } };
      }),
    };

    const allowed = await authorizeSplitRequester(octokit as never, {
      owner: 'integry',
      repo: 'propr',
      username: 'maintainer',
    });
    assert.deepEqual(allowed, { authorized: true, permission: 'maintain' });
    assert.deepEqual(requestedRoutes, [
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
    ]);

    const notFoundClient = {
      request: mock.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    };
    const refused = await authorizeSplitRequester(notFoundClient as never, {
      owner: 'integry',
      repo: 'propr',
      username: 'outside-contributor',
    });
    assert.deepEqual(refused, { authorized: false, permission: null });
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

  test('generates a stable key from normalized repository, head, and instruction', () => {
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

    assert.equal(first, equivalent);
    assert.notEqual(first, changedInstruction);
    assert.notEqual(first, changedHead);
  });

  test('returns the same operation for an identical normalized command', async () => {
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
    assert.equal(repeated.operation.id, first.operation.id);
    assert.equal(repeated.operation.instruction, 'extract auth changes');
    assert.equal(repeated.operation.original_comment_id, 9001);
    assert.equal(repeated.operation.repository, 'Integry/ProPR');
    assert.equal(await database('pr_split_operations').count<{ count: number }>('* as count').first().then(row => Number(row?.count)), 1);
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

    await updatePrSplitOperationStatus(first.operation.id, 'completed', {}, database);
    assert.equal(await getActivePrSplitOperation(baseInput.repository, 1735, database), null);

    const second = await createOrGetPrSplitOperation(
      { ...baseInput, originalCommentId: 9003, instruction: 'extract API changes' },
      database,
    );
    assert.equal(second.outcome, 'created');
    assert.notEqual(second.operation.id, first.operation.id);

    await updatePrSplitOperationStatus(second.operation.id, 'failed', { errorMessage: 'test failure' }, database);
    const third = await createOrGetPrSplitOperation(
      { ...baseInput, originalCommentId: 9004, instruction: 'extract UI changes' },
      database,
    );
    assert.equal(third.outcome, 'created');
  });

  test('uses the database lock to arbitrate concurrent different commands', async () => {
    const results = await Promise.all([
      createOrGetPrSplitOperation(baseInput, database),
      createOrGetPrSplitOperation(
        { ...baseInput, originalCommentId: 9002, instruction: 'extract API changes' },
        database,
      ),
    ]);

    assert.deepEqual(results.map(result => result.outcome).sort(), ['active', 'created']);
    const [{ count }] = await database('pr_split_operations').count<{ count: number }>('* as count');
    assert.equal(Number(count), 1);
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
    dedupe_key: 'dedupe',
    status: 'queued',
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
  };
}

describe('/split issue-comment intake', () => {
  test('ignores /split on a normal issue before loading GitHub dependencies', async () => {
    const getOctokit = mock.fn(async () => ({ request: mock.fn() }));
    const result = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes', false),
      'correlation-id',
      { getOctokit } as unknown as PrSplitIntakeDependencies,
    );

    assert.deepEqual(result, { handled: false });
    assert.equal(getOctokit.mock.callCount(), 0);
  });

  test('posts a refusal and creates no operation for an unauthorized requester', async () => {
    const request = mock.fn(async () => ({ data: {} }));
    const createOperation = mock.fn(async () => ({
      outcome: 'created' as const,
      operation: operationFixture(),
    }));
    const dependencies = {
      getOctokit: mock.fn(async () => ({ request })),
      authorizeRequester: mock.fn(async () => ({ authorized: false as const, permission: 'read' })),
      createOperation,
    } as unknown as PrSplitIntakeDependencies;

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
    assert.equal(request.mock.callCount(), 1);
    assert.match(String(request.mock.calls[0].arguments[1]?.body), /requires.*write.*maintain.*admin/i);
  });

  test('snapshots PR metadata and queues normalized guidance for an authorized requester', async () => {
    const request = mock.fn(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            base: { ref: '1735-epic-pr-split-rjb', sha: 'aaa111' },
            head: { sha: 'bbb222' },
          },
        };
      }
      return { data: { id: 42 } };
    });
    let capturedInput: CreatePrSplitOperationInput | undefined;
    const dependencies = {
      getOctokit: mock.fn(async () => ({ request })),
      authorizeRequester: mock.fn(async () => ({ authorized: true as const, permission: 'write' as const })),
      createOperation: mock.fn(async (input: CreatePrSplitOperationInput) => {
        capturedInput = input;
        return { outcome: 'created' as const, operation: operationFixture() };
      }),
    } as unknown as PrSplitIntakeDependencies;

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
    assert.equal(request.mock.callCount(), 2);
    assert.match(String(request.mock.calls[1].arguments[1]?.body), /queued/i);
  });

  test('posts an already-running response when a different operation owns the PR lock', async () => {
    const activeOperation = { ...operationFixture(), status: 'running' as const };
    const request = mock.fn(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            base: { ref: '1735-epic-pr-split-rjb', sha: 'aaa111' },
            head: { sha: 'bbb222' },
          },
        };
      }
      return { data: { id: 42 } };
    });
    const dependencies = {
      getOctokit: mock.fn(async () => ({ request })),
      authorizeRequester: mock.fn(async () => ({ authorized: true as const, permission: 'admin' as const })),
      createOperation: mock.fn(async () => ({ outcome: 'active' as const, operation: activeOperation })),
    } as unknown as PrSplitIntakeDependencies;

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
    assert.match(String(request.mock.calls[1].arguments[1]?.body), /already running/i);
  });
});
