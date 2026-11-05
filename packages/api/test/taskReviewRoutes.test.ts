import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import {
  state, claims, redis, acceptedJobs, add, request, database, createTaskRoutes,
} from './taskFollowupFixture.js';

async function postReview(overrides: Record<string, unknown> = {}, user: unknown = { id: 'user-1', login: 'human' }) {
  const result = { status: 200, json: {} as Record<string, unknown> };
  const response = { status(code: number) { result.status = code; return this; },
    json(payload: Record<string, unknown>) { result.json = payload; return this; } } as unknown as Response;
  await createTaskRoutes({ db: database,
    resolveMetadataToken: async () => 'fixture-token', verifyRepositoryAccess: async () => {},
    reviewAssignmentGate: async () => ({ allowed: true, reason: 'author_assigned' }), ...overrides,
  }).postReview({ params: { taskId: 'completed-task' }, user } as unknown as Request, response);
  return result;
}

test('dedicated desktop review accepts a bot-posted command for the authenticated user only once', async () => {
  state.webhookFirst = true;
  const result = await postReview();
  assert.equal(result.status, 202);
  assert.equal(result.json.success, true);
  assert.equal(result.json.commandMode, 'review');
  assert.equal(result.json.state, 'queued');
  const job = add.mock.calls[0].arguments[1];
  assert.equal(job.commandMode, 'review');
  assert.equal(job.userId, 'user-1');
  assert.equal(job.comments![0].author, 'propr-dev[bot]');
  assert.equal(job.comments![0].body, '');
  assert.deepEqual(await postReview(), result);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(request.mock.calls.filter(call => call.arguments[0].startsWith('POST')).length, 1);
});

test('review checks the real user grant, repository and PR assignment before posting', async () => {
  const checked: string[] = [];
  const result = await postReview({
    resolveMetadataToken: async (req: Request) => { checked.push(req.user!.id); return 'user-token'; },
    verifyRepositoryAccess: async (repo: string, token: string) => { checked.push(repo, token); },
    reviewAssignmentGate: async (input: { authorId: string; authorLogin: string; pullRequestNumber: number }) => {
      assert.equal(input.authorId, 'user-1'); assert.equal(input.authorLogin, 'human');
      assert.equal(input.pullRequestNumber, 7);
      return { allowed: false, reason: 'author_not_assigned' };
    },
  });
  assert.deepEqual(checked, ['user-1', 'integry/propr', 'user-token']);
  assert.equal(result.status, 403);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(add.mock.callCount(), 0);
});

test('inaccessible repositories and anonymous review requests do not post or queue', async () => {
  assert.equal((await postReview({}, null)).status, 401);
  assert.equal((await postReview({ verifyRepositoryAccess: async () => { throw { status: 404 }; } })).status, 404);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(add.mock.callCount(), 0);
});

test('uncertain review receipt is retained on retry without a second implementation or review run', async () => {
  state.queueFails = true; state.acceptBeforeFailure = true;
  const result = await postReview();
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'unknown');
  assert.deepEqual(await postReview(), result);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(acceptedJobs.size, 1);
});

for (const status of [400, 401, 403, 404, 422, 429]) {
  test(`GitHub comment rejection (${status}) releases the review claim and permits recovery`, async () => {
    state.commentPostError = Object.assign(new Error('GitHub rejected comment creation'), { status });
    const result = await postReview();
    assert.equal(result.status, 503);
    assert.equal(result.json.state, 'failed');
    assert.equal(result.json.success, false);
    assert.equal(result.json.posted, false);
    assert.match(String(result.json.error), /No review was submitted/);
    assert.equal(claims.has('task-review:completed-task'), false);
    assert.equal(add.mock.callCount(), 0);
    assert.equal(redis.rpush.mock.callCount(), 0);
    state.commentPostError = undefined;
    const retry = await postReview();
    assert.equal(retry.json.state, 'queued');
    assert.equal(retry.json.success, true);
    assert.equal(add.mock.callCount(), 1);
    assert.deepEqual(await postReview(), retry);
    assert.equal(request.mock.calls.filter(call => call.arguments[0].startsWith('POST')).length, 2);
  });
}

for (const status of [undefined, 408, 500, 502]) {
  test(`ambiguous comment failure (${status ?? 'connection lost'}) retains the review claim`, async () => {
    state.commentPostError = Object.assign(new Error('Comment response lost'), status === undefined ? {} : { status });
    const result = await postReview();
    assert.equal(result.status, 202);
    assert.equal(result.json.state, 'unknown');
    assert.equal(result.json.success, false);
    assert.equal(claims.has('task-review:completed-task'), true);
    state.commentPostError = undefined;
    assert.deepEqual(await postReview(), result);
    assert.equal(request.mock.calls.filter(call => call.arguments[0].startsWith('POST')).length, 1);
    assert.equal(add.mock.callCount(), 0);
  });
}

test('closed PR and unavailable assignment never post review commands', async () => {
  state.prState = 'closed';
  assert.equal((await postReview()).status, 409);
  assert.equal((await postReview({ reviewAssignmentGate: async () => ({ allowed: false, reason: 'assignment_unavailable' }) })).status, 503);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(request.mock.calls.filter(call => call.arguments[0].startsWith('POST')).length, 0);
});

test('dedicated review batched behind manual work retains review metadata and its idempotent receipt', async () => {
  state.existingJobs = [{ name: 'processPullRequestComment', data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 7, commandMode: 'fix' } }];
  const result = await postReview();
  assert.equal(result.json.success, true);
  assert.equal(result.json.state, 'batched');
  assert.equal(JSON.parse(redis.rpush.mock.calls[0].arguments[1]).commandMode, 'review');
  assert.deepEqual(await postReview(), result);
  assert.equal(redis.rpush.mock.callCount(), 1);
  assert.equal(add.mock.callCount(), 0);
});

test('concurrent desktop requests share one review submission', async () => {
  const results = await Promise.all([postReview(), postReview()]);
  assert.equal(results.filter(result => result.json.state === 'queued').length, 1);
  assert.equal(results.filter(result => result.json.state === 'unknown').length, 1);
  assert.equal(add.mock.callCount(), 1);
});
