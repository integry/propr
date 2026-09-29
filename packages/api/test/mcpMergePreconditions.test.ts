import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as addAccessLog } from '../../core/src/db/migrations/20260923010000_add_mcp_access_log.js';
import { McpError } from '../mcp/config.js';
import {
  type PullRequestStateSource,
  assertMergePreconditions,
  assertPullRequestOpen,
  mergeRejectedError,
  pullRequestSnapshot,
} from '../mcp/pullRequestPreconditions.js';
import type { McpPrincipal } from '../mcp/policy.js';
import { createToolCatalog, executeTool, type Args, type McpTool, type ToolDeps } from '../mcp/tools.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

after(closeConnection);

function rest(overrides: PullRequestStateSource = {}): PullRequestStateSource {
  return {
    number: 42, state: 'open', draft: false, merged: false,
    merged_at: null, merge_commit_sha: null, closed_at: null,
    head: { sha: HEAD }, base: { ref: 'main' }, html_url: 'https://github.com/acme/repo/pull/42',
    ...overrides,
  };
}

function graph(overrides: PullRequestStateSource = {}): PullRequestStateSource {
  return {
    state: 'OPEN', isDraft: false, merged: false, mergedAt: null, closedAt: null,
    mergeCommit: null, headRefOid: HEAD, baseRefName: 'main', mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED', url: 'https://github.com/acme/repo/pull/42',
    commits: { nodes: [{ commit: { statusCheckRollup: {
      state: 'SUCCESS', contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }] },
    ...overrides,
  };
}

function errorFrom(run: () => unknown): McpError {
  try { run(); } catch (error) {
    assert.ok(error instanceof McpError);
    return error;
  }
  assert.fail('Expected a pull request precondition error.');
}

function rollup(
  state: string,
  nodes: Array<Record<string, string | null>>,
  page?: { commitId: string; hasNextPage: boolean; endCursor: string | null },
): PullRequestStateSource['commits'] {
  return { nodes: [{ commit: {
    ...(page ? { id: page.commitId } : {}),
    statusCheckRollup: { state, contexts: { nodes, pageInfo: {
      hasNextPage: page?.hasNextPage ?? false, endCursor: page?.endCursor ?? null,
    } } },
  } }] };
}

test('pullRequestSnapshot reports actual lifecycle and named check state', () => {
  const snapshot = pullRequestSnapshot(rest(), graph({
    mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    commits: rollup('PENDING', [
      { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
      { context: 'lint', state: 'PENDING' },
    ]),
  }));
  assert.deepEqual(snapshot, {
    state: 'open', draft: false, merged: false, mergedAt: null, mergeCommitSha: null, closedAt: null,
    head: HEAD, base: 'main', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    checks: { state: 'PENDING', failing: ['build'], pending: ['e2e', 'lint'] },
    url: 'https://github.com/acme/repo/pull/42',
  });
});

test('open-state assertion distinguishes merged, closed and merge-only draft failures', () => {
  const merged = rest({ state: 'closed', merged: true, merged_at: '2026-09-28T12:00:00Z', merge_commit_sha: NEXT_HEAD });
  const mergedError = errorFrom(() => assertPullRequestOpen(merged, 'merge'));
  assert.equal(mergedError.code, 'PULL_REQUEST_ALREADY_MERGED');
  assert.equal(mergedError.status, 409);
  assert.equal(mergedError.retryable, false);
  assert.equal(mergedError.stage, 'precondition');
  assert.equal(mergedError.details?.mergedAt, '2026-09-28T12:00:00Z');
  assert.equal(mergedError.details?.mergeCommitSha, NEXT_HEAD);
  assert.equal((mergedError.details?.currentState as { state: string }).state, 'merged');

  const closedError = errorFrom(() => assertPullRequestOpen(rest({ state: 'closed', closed_at: '2026-09-27T12:00:00Z' }), 'comment on'));
  assert.equal(closedError.code, 'PULL_REQUEST_CLOSED');
  assert.equal(closedError.details?.closedAt, '2026-09-27T12:00:00Z');
  assert.doesNotThrow(() => assertPullRequestOpen(rest({ draft: true }), 'comment on'));
  assert.equal(errorFrom(() => assertPullRequestOpen(rest({ draft: true }), 'merge')).code, 'PULL_REQUEST_DRAFT');
});

test('merge preconditions expose the first specific failure with the complete current state', async t => {
  const cases: Array<{
    name: string;
    expectedHead?: string;
    state: PullRequestStateSource;
    code: string;
    retryable: boolean;
    detail?: { key: string; value: string[] };
  }> = [
    { name: 'stale head', expectedHead: NEXT_HEAD, state: graph({ isDraft: true }), code: 'STALE_HEAD', retryable: false },
    { name: 'draft', state: graph({ isDraft: true }), code: 'PULL_REQUEST_DRAFT', retryable: false },
    { name: 'changes requested', state: graph({ reviewDecision: 'CHANGES_REQUESTED' }), code: 'CHANGES_REQUESTED', retryable: false },
    { name: 'review required', state: graph({ reviewDecision: 'REVIEW_REQUIRED' }), code: 'REVIEW_REQUIRED', retryable: false },
    { name: 'checks failing', state: graph({ commits: rollup('FAILURE', [
      { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'deploy', state: 'ERROR' },
    ]) }), code: 'CHECKS_FAILING', retryable: false, detail: { key: 'failing', value: ['build', 'deploy'] } },
    { name: 'checks pending', state: graph({ commits: rollup('PENDING', [
      { name: 'e2e', status: 'IN_PROGRESS', conclusion: null }, { context: 'lint', state: 'EXPECTED' },
    ]) }), code: 'CHECKS_PENDING', retryable: true, detail: { key: 'pending', value: ['e2e', 'lint'] } },
    { name: 'branch behind base', state: graph({ mergeStateStatus: 'BEHIND' }), code: 'BRANCH_BEHIND_BASE', retryable: false },
    { name: 'merge conflict', state: graph({ mergeStateStatus: 'DIRTY' }), code: 'MERGE_CONFLICT', retryable: false },
    { name: 'branch protection', state: graph({ mergeStateStatus: 'BLOCKED' }), code: 'BRANCH_PROTECTION_BLOCKED', retryable: false },
    { name: 'merge state pending', state: graph({ mergeStateStatus: 'UNKNOWN' }), code: 'MERGE_STATE_UNKNOWN', retryable: true },
    { name: 'unstable without successful rollup', state: graph({ mergeStateStatus: 'UNSTABLE', commits: rollup('SUCCESS_WITH_WARNINGS', []) }), code: 'CHECKS_FAILING', retryable: false, detail: { key: 'failing', value: [] } },
    { name: 'hooks without successful rollup', state: graph({ mergeStateStatus: 'HAS_HOOKS', commits: rollup('SUCCESS_WITH_WARNINGS', []) }), code: 'CHECKS_FAILING', retryable: false, detail: { key: 'failing', value: [] } },
  ];

  for (const item of cases) await t.test(item.name, () => {
    const error = errorFrom(() => assertMergePreconditions(rest(), item.state, item.expectedHead ?? HEAD));
    assert.equal(error.code, item.code);
    assert.equal(error.retryable, item.retryable);
    assert.equal(error.stage, 'precondition');
    assert.ok(error.details?.failedPrecondition);
    const currentState = error.details?.currentState as { head?: string; checks?: { state?: string } } | undefined;
    assert.ok(currentState);
    assert.equal(currentState.head, HEAD);
    if (item.detail) {
      assert.deepEqual(error.details?.[item.detail.key], item.detail.value);
      const envelope = error.toEnvelope();
      const envelopeState = envelope.details?.currentState as { checks?: Record<string, unknown> } | undefined;
      assert.deepEqual(envelopeState?.checks?.[item.detail.key], item.detail.value);
      assert.deepEqual(envelope.details?.[item.detail.key], item.detail.value);
    }
  });
});

test('clean, unstable and hook-protected pull requests pass when their check rollup succeeds', () => {
  for (const mergeStateStatus of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS']) {
    const snapshot = assertMergePreconditions(rest(), graph({ mergeStateStatus }), HEAD);
    assert.equal(snapshot.mergeStateStatus, mergeStateStatus);
    assert.equal(snapshot.checks.state, 'SUCCESS');
  }
});

test('a definitive GitHub merge refusal carries GitHub detail and the same state snapshot', () => {
  const error = mergeRejectedError(rest(), graph(), 'Required status check "build" is expected.');
  assert.equal(error.code, 'MERGE_REJECTED');
  assert.equal(error.retryable, false);
  assert.equal(error.details?.githubMessage, 'Required status check "build" is expected.');
  assert.ok(error.details?.currentState);
  assert.equal(error.details?.failedPrecondition, 'githubMergeAccepted');
});

test('executeTool persists specific PR state failures and get_operation returns the same envelope', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  await addAccessLog(db);

  const mergedAt = '2026-09-28T12:00:00Z';
  const mergeCommitSha = NEXT_HEAD;
  let requestedPull = 42;
  let mergeQuery = '';
  const paginationCalls: Args[] = [];
  const successfulChecks = Array.from({ length: 50 }, (_, index) => ({
    name: `successful-${index + 1}`, status: 'COMPLETED', conclusion: 'SUCCESS',
  }));
  const github = {
    request: async (route: string, args: Args) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        requestedPull = Number(args.pull_number);
        if (requestedPull === 43) return { data: rest({ number: 43, state: 'closed', closed_at: '2026-09-27T12:00:00Z' }) };
        if ([44, 45, 46, 47].includes(requestedPull)) return { data: rest({ number: requestedPull }) };
        return { data: rest({ state: 'closed', merged: true, merged_at: mergedAt, merge_commit_sha: mergeCommitSha }) };
      }
      if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge' && Number(args.pull_number) === 44) {
        throw Object.assign(new Error('Pull Request is not mergeable'), {
          status: 405, response: { status: 405, data: { message: 'Required status check "build" is expected.' } },
        });
      }
      if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge' && Number(args.pull_number) === 45) {
        return { data: { merged: false, message: 'Base branch policy rejected this merge.' } };
      }
      throw new Error(`Unexpected GitHub request: ${route}`);
    },
    graphql: async (query: string, args: Args) => {
      mergeQuery = query;
      if (query.includes('node(id:$commitId)')) {
        paginationCalls.push({ query, ...args });
        if (args.commitId === 'commit-46') return { node: { statusCheckRollup: { contexts: {
          nodes: [{ name: 'deploy', status: 'COMPLETED', conclusion: 'FAILURE' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
        if (args.commitId === 'commit-47') return { node: { statusCheckRollup: { contexts: {
          nodes: [{ name: 'e2e', status: 'IN_PROGRESS', conclusion: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
        throw new Error(`Unexpected check-context commit: ${args.commitId}`);
      }
      if (requestedPull === 46) return { repository: { pullRequest: graph({ commits: rollup('FAILURE', [
        { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }, ...successfulChecks.slice(1),
      ], { commitId: 'commit-46', hasNextPage: true, endCursor: 'cursor-46' }) }) } };
      if (requestedPull === 47) return { repository: { pullRequest: graph({ commits: rollup(
        'PENDING', successfulChecks, { commitId: 'commit-47', hasNextPage: true, endCursor: 'cursor-47' },
      ) }) } };
      if (requestedPull === 44 || requestedPull === 45) return { repository: { pullRequest: graph() } };
      return { repository: { pullRequest: graph({ state: 'MERGED', merged: true, mergedAt, mergeCommit: { oid: mergeCommitSha } }) } };
    },
  };
  const policy = {
    config: { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance' },
    requireScope: () => undefined,
    requirePermission: () => undefined,
    repository: async () => undefined,
  };
  const deps = { db, policy, taskQueue: {}, runtimeBuildQueue: {}, redisClient: {} } as unknown as ToolDeps;
  const principal = {
    user: { id: 'user-1', login: 'fixture-user' }, authorization: { permissions: [] },
    scopes: ['read', 'execute', 'merge'], github,
    grant: { id: 'grant-1', repositories: ['acme/repo'] },
  } as unknown as McpPrincipal;
  const tools = createToolCatalog(deps);
  const tool = (name: string): McpTool => {
    const found = tools.find(candidate => candidate.name === name);
    assert.ok(found);
    return found;
  };

  const comment = (await executeTool(tool('comment_on_pull_request'), {
    repository: 'acme/repo', pullRequest: 43, message: 'Please revisit this.', idempotencyKey: 'closed-comment-1',
  }, principal, deps)).data as Args;
  assert.equal(requestedPull, 43);
  assert.equal(comment.state, 'failed');
  assert.equal(comment.result.error.code, 'PULL_REQUEST_CLOSED');
  assert.equal(comment.result.error.retryable, false);

  const merge = (await executeTool(tool('merge_pull_request'), {
    repository: 'acme/repo', pullRequest: 42, expectedHead: HEAD, method: 'squash', idempotencyKey: 'merged-pull-1',
  }, principal, deps)).data as Args;
  assert.equal(merge.state, 'failed');
  assert.equal(merge.result.error.code, 'PULL_REQUEST_ALREADY_MERGED');
  assert.equal(merge.result.error.details.currentState.mergedAt, mergedAt);
  assert.equal(merge.result.error.details.currentState.mergeCommitSha, mergeCommitSha);
  assert.match(mergeQuery, /contexts\(first:50\)/);
  assert.match(mergeQuery, /pageInfo\{hasNextPage endCursor\}/);
  assert.match(mergeQuery, /commit\{id statusCheckRollup/);
  assert.match(mergeQuery, /CheckRun\{name conclusion status\}/);
  assert.match(mergeQuery, /StatusContext\{context state\}/);

  const receipt = (await executeTool(tool('get_operation'), { operationId: merge.operationId }, principal, deps)).data as Args;
  assert.equal(receipt.state, 'failed');
  assert.deepEqual(receipt.result.error, merge.result.error);
  assert.deepEqual(receipt.lifecycle.failure, merge.result.error);

  for (const checkFailure of [
    { pullRequest: 46, code: 'CHECKS_FAILING', key: 'failing', names: ['build', 'deploy'] },
    { pullRequest: 47, code: 'CHECKS_PENDING', key: 'pending', names: ['e2e'] },
  ]) {
    const failedMerge = (await executeTool(tool('merge_pull_request'), {
      repository: 'acme/repo', pullRequest: checkFailure.pullRequest, expectedHead: HEAD, method: 'squash',
      idempotencyKey: `named-check-${checkFailure.pullRequest}`,
    }, principal, deps)).data as Args;
    assert.equal(failedMerge.state, 'failed');
    assert.equal(failedMerge.result.error.code, checkFailure.code);
    assert.match(failedMerge.result.error.message, new RegExp(checkFailure.names.join('.*')));
    assert.deepEqual(failedMerge.result.error.details.currentState.checks[checkFailure.key], checkFailure.names);
    assert.deepEqual(failedMerge.result.error.details[checkFailure.key], checkFailure.names);

    const failedReceipt = (await executeTool(tool('get_operation'), {
      operationId: failedMerge.operationId,
    }, principal, deps)).data as Args;
    assert.deepEqual(failedReceipt.result.error.details.currentState.checks[checkFailure.key], checkFailure.names);
    assert.deepEqual(failedReceipt.result.error.details[checkFailure.key], checkFailure.names);
    assert.deepEqual(failedReceipt.lifecycle.failure.details[checkFailure.key], checkFailure.names);
  }
  assert.deepEqual(paginationCalls.map(call => ({ commitId: call.commitId, after: call.after })), [
    { commitId: 'commit-46', after: 'cursor-46' },
    { commitId: 'commit-47', after: 'cursor-47' },
  ]);

  const rejected405 = (await executeTool(tool('merge_pull_request'), {
    repository: 'acme/repo', pullRequest: 44, expectedHead: HEAD, method: 'squash', idempotencyKey: 'merge-rejected-405',
  }, principal, deps)).data as Args;
  assert.equal(rejected405.result.error.code, 'MERGE_REJECTED');
  assert.match(rejected405.result.error.message, /Required status check "build" is expected/);
  assert.ok(rejected405.result.error.details.currentState);

  const rejectedFalse = (await executeTool(tool('merge_pull_request'), {
    repository: 'acme/repo', pullRequest: 45, expectedHead: HEAD, method: 'squash', idempotencyKey: 'merge-false-result',
  }, principal, deps)).data as Args;
  assert.equal(rejectedFalse.result.error.code, 'MERGE_REJECTED');
  assert.match(rejectedFalse.result.error.message, /Base branch policy rejected this merge/);
  assert.ok(rejectedFalse.result.error.details.currentState);
});
