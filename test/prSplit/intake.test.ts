import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { Knex } from 'knex';
import type { PrSplitRequestClient } from '../../packages/core/src/services/prSplit/authorization.js';
import {
  getPrSplitCommandRecord,
  recordPrSplitCommandOutcome,
} from '../../packages/core/src/services/prSplit/commandStore.js';
import { MAX_SPLIT_INSTRUCTION_LENGTH } from '../../packages/core/src/services/prSplit/command.js';
import {
  handlePrSplitComment,
  isPrSplitExecutionEnabled,
  type PrSplitIntakeDependencies,
} from '../../packages/core/src/services/prSplit/intake.js';
import {
  updatePrSplitOperationStatus,
  type PrSplitOperation,
} from '../../packages/core/src/services/prSplit/operationStore.js';
import {
  createSplitTestDatabase,
  issueCommentPayload,
  openPullRequestData,
} from './helpers.js';

describe('/split issue-comment intake', () => {
  let database: Knex;

  beforeEach(async () => {
    database = await createSplitTestDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  function dependencies(
    client: PrSplitRequestClient,
    overrides: Partial<PrSplitIntakeDependencies> = {},
  ): PrSplitIntakeDependencies {
    return {
      getOctokit: mock.fn(async () => client),
      authorizeRequester: mock.fn(async () => ({
        authorized: true as const,
        permission: 'write' as const,
      })),
      isExecutionEnabled: () => true,
      db: database,
      ...overrides,
    };
  }

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
      issueCommentPayload('/split extract auth changes', { isPullRequest: false }),
      'correlation-id',
      { getOctokit, db: database },
    );
    assert.deepEqual(result, { handled: false });
    assert.equal(getOctokit.mock.callCount(), 0);
  });

  test('durably preserves a disabled disposition after execution is enabled', async () => {
    const request = mock.fn(async () => ({ data: { id: 42 } }));
    const client: PrSplitRequestClient = { request };
    const authorizeRequester = mock.fn(async () => ({
      authorized: true as const,
      permission: 'write' as const,
    }));
    let enabled = false;
    const intakeDependencies = dependencies(client, {
      authorizeRequester,
      isExecutionEnabled: () => enabled,
    });
    const payload = issueCommentPayload('/split extract auth changes');

    const first = await handlePrSplitComment(payload, 'first-delivery', intakeDependencies);
    enabled = true;
    const replay = await handlePrSplitComment(payload, 'redelivery', intakeDependencies);

    for (const result of [first, replay]) {
      assert.equal(result.handled && result.outcome, 'disabled');
      assert.equal(result.handled && result.disposition.reason, 'split_execution_not_enabled');
    }
    assert.equal(authorizeRequester.mock.callCount(), 0);
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 0);
    assert.equal(request.mock.calls.filter(
      call => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ).length, 1);
    const receipt = await getPrSplitCommandRecord({
      repositoryId: 123456,
      originalCommentId: 9001,
    }, database);
    assert.equal(receipt?.receipt.outcome, 'disabled');
    assert.equal(receipt?.receipt.response_state, 'posted');
    assert.equal(receipt?.receipt.requester_id, 7654321);
  });

  test('durably preserves an authorization refusal after permission changes', async () => {
    const request = mock.fn(async () => ({ data: { id: 42 } }));
    const client: PrSplitRequestClient = { request };
    let authorized = false;
    const authorizeRequester = mock.fn(async () => authorized
      ? { authorized: true as const, permission: 'write' as const }
      : { authorized: false as const, permission: 'read' });
    const intakeDependencies = dependencies(client, { authorizeRequester });
    const payload = issueCommentPayload('/split extract auth changes');

    const first = await handlePrSplitComment(payload, 'first-delivery', intakeDependencies);
    authorized = true;
    const replay = await handlePrSplitComment(payload, 'redelivery', intakeDependencies);

    assert.equal(first.handled && first.outcome, 'unauthorized');
    assert.equal(replay.handled && replay.outcome, 'unauthorized');
    assert.equal(authorizeRequester.mock.callCount(), 1);
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 0);
    assert.match(String(request.mock.calls[0]?.arguments[1].body),
      /requires.*write.*maintain.*admin/i);
  });

  test('snapshots an open PR and queues normalized guidance with immutable identities', async () => {
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: openPullRequestData() };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const result = await handlePrSplitComment(
      issueCommentPayload('/split   extract\n auth   changes'),
      'correlation-id',
      dependencies(client),
    );

    assert.equal(result.handled && result.outcome, 'queued');
    assert.equal(result.handled && result.disposition.billing?.seatConsumed, false);
    assert.deepEqual(result.handled && result.disposition.evidence?.triggerCommentIds, [9001]);
    const operation = await database<PrSplitOperation>('pr_split_operations').first();
    assert.equal(operation?.repository_id, 123456);
    assert.equal(operation?.repository, 'integry/propr');
    assert.equal(operation?.requester_id, 7654321);
    assert.equal(operation?.requester, 'maintainer');
    assert.equal(operation?.instruction, 'extract auth changes');
    assert.equal(operation?.base_ref, '1735-epic-pr-split-rjb');
    assert.equal(operation?.base_sha, 'aaa111');
    assert.equal(operation?.head_sha, 'bbb222');
    const postCall = request.mock.calls.find(
      call => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    );
    assert.match(String(postCall?.arguments[1].body), /queued/i);
    assert.match(String(postCall?.arguments[1].body), /propr:pr-split-response/);
    assert.equal(request.mock.calls.some(
      call => call.arguments[0] === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ), false);
  });

  test('keeps an active-lock refusal terminal after the owner finishes', async () => {
    const request = mock.fn(async (
      route: string,
      _parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: openPullRequestData() };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const intakeDependencies = dependencies(client);
    const queued = await handlePrSplitComment(
      issueCommentPayload('/split extract auth changes', { commentId: 9000 }),
      'first-command',
      intakeDependencies,
    );
    const blockedPayload = issueCommentPayload('/split extract API changes', {
      commentId: 9001,
      repository: 'integry/propr-renamed',
    });
    const blocked = await handlePrSplitComment(
      blockedPayload,
      'blocked-command',
      intakeDependencies,
    );
    assert.equal(blocked.handled && blocked.outcome, 'active');
    assert.equal(blocked.handled && blocked.disposition.reason, 'split_operation_already_active');
    if (!queued.handled || !queued.operation) assert.fail('first command did not queue');

    const claimed = await updatePrSplitOperationStatus(queued.operation.id, 'running', {}, database);
    assert.ok(claimed?.lease_token);
    assert.ok(await updatePrSplitOperationStatus(
      queued.operation.id,
      'completed',
      { leaseToken: claimed.lease_token },
      database,
    ));
    const replay = await handlePrSplitComment(
      blockedPayload,
      'blocked-redelivery',
      intakeDependencies,
    );
    assert.equal(replay.handled && replay.outcome, 'active');
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 1);
    assert.equal(request.mock.calls.filter(
      call => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ).length, 2);
  });

  test('rejects closed and merged pull requests without creating operations', async () => {
    const snapshots = [
      { ...openPullRequestData(), state: 'closed' },
      { ...openPullRequestData(), merged: true },
    ];
    const request = mock.fn(async (route: string): Promise<{ data: unknown }> => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: snapshots.shift() };
      }
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const intakeDependencies = dependencies(client);

    for (const commentId of [9001, 9002]) {
      const result = await handlePrSplitComment(
        issueCommentPayload('/split historical work', { commentId }),
        `closed-${commentId}`,
        intakeDependencies,
      );
      assert.equal(result.handled && result.outcome, 'closed');
      assert.equal(result.handled && result.disposition.reason, 'split_pull_request_closed');
    }
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 0);
  });

  test('rejects oversized instructions durably before authorization', async () => {
    const request = mock.fn(async () => ({ data: { id: 42 } }));
    const client: PrSplitRequestClient = { request };
    const authorizeRequester = mock.fn(async () => ({
      authorized: true as const,
      permission: 'write' as const,
    }));
    const result = await handlePrSplitComment(
      issueCommentPayload(`/split ${'x'.repeat(MAX_SPLIT_INSTRUCTION_LENGTH + 1)}`),
      'correlation-id',
      dependencies(client, { authorizeRequester }),
    );
    assert.equal(result.handled && result.outcome, 'invalid');
    assert.equal(authorizeRequester.mock.callCount(), 0);
    assert.equal(await database('pr_split_operations').count('* as count').first()
      .then(row => Number(row?.count)), 0);
  });

  test('atomically claims one response across concurrent redeliveries', async () => {
    await recordPrSplitCommandOutcome({
      repositoryId: 123456,
      repository: 'integry/propr',
      sourcePrNumber: 1735,
      requesterId: 7654321,
      requester: 'maintainer',
      originalCommentId: 9001,
      instruction: 'extract auth changes',
      outcome: 'disabled',
    }, database);
    const request = mock.fn(async () => {
      await Promise.resolve();
      return { data: { id: 42 } };
    });
    const client: PrSplitRequestClient = { request };
    const intakeDependencies = dependencies(client, { isExecutionEnabled: () => false });
    const payload = issueCommentPayload('/split extract auth changes');
    const results = await Promise.all([
      handlePrSplitComment(payload, 'first-delivery', intakeDependencies),
      handlePrSplitComment(payload, 'second-delivery', intakeDependencies),
    ]);

    assert.deepEqual(results.map(result => result.handled && result.outcome), [
      'disabled',
      'disabled',
    ]);
    assert.equal(request.mock.calls.filter(
      call => call.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ).length, 1);
    assert.equal(request.mock.calls.some(
      call => call.arguments[0] === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    ), false);
  });

  test('never retries an ambiguous response POST after its durable claim', async () => {
    const postError = new Error('socket closed after request write');
    const request = mock.fn(async () => { throw postError; });
    const client: PrSplitRequestClient = { request };
    const intakeDependencies = dependencies(client, { isExecutionEnabled: () => false });
    const payload = issueCommentPayload('/split extract auth changes');

    await assert.rejects(
      handlePrSplitComment(payload, 'first-delivery', intakeDependencies),
      error => error === postError,
    );
    const replay = await handlePrSplitComment(payload, 'redelivery', intakeDependencies);
    assert.equal(replay.handled && replay.outcome, 'disabled');
    assert.equal(request.mock.callCount(), 1);
    const receipt = await getPrSplitCommandRecord({
      repositoryId: 123456,
      originalCommentId: 9001,
    }, database);
    assert.equal(receipt?.receipt.response_state, 'claimed');
  });
});
