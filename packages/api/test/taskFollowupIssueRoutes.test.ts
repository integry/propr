import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { state, claims, add, request, postFollowup, processCommentEvent, redis } from './taskFollowupFixture.js';

const routes = () => request.mock.calls.map(call => call.arguments[0]);
const pullRequestReads = () => routes().filter(route => route.includes('/pulls/'));
const postedComments = () => request.mock.calls.filter(call => call.arguments[0].endsWith('/comments'));

test('a failed issue-only implementation is retried through the issue job for the requesting user', async () => {
  const result = await postFollowup({ body: '  Retry with the fixed credentials  ' }, 'failed-issue-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, true);
  assert.equal(result.json.state, 'queued');
  assert.equal(result.json.intent, 'issue');
  assert.equal(result.json.issueNumber, 14);
  assert.equal(result.json.sourceTaskId, 'failed-issue-task');
  assert.equal(result.json.jobId, 'issue-integry-propr-14');

  assert.equal(add.mock.callCount(), 1);
  const [name, job, options] = add.mock.calls[0].arguments as unknown as [string, Record<string, unknown>, { jobId: string }];
  assert.equal(name, 'processGitHubIssue');
  assert.equal(options.jobId, 'issue-integry-propr-14');
  assert.deepEqual({ repoOwner: job.repoOwner, repoName: job.repoName, number: job.number, userId: job.userId, triggeringLabel: job.triggeringLabel },
    { repoOwner: 'integry', repoName: 'propr', number: 14, userId: 'user-1', triggeringLabel: 'AI' });
  // The dispatcher resolves the model from the issue's labels; nothing here overrides it.
  assert.equal(job.agentAlias, undefined);
  assert.equal(job.modelName, undefined);

  assert.deepEqual(pullRequestReads(), [], 'issue intent never reads a pull request');
  const [comment] = postedComments();
  assert.equal(comment.arguments[1].issue_number, 14);
  assert.equal(comment.arguments[1].body, 'Retry with the fixed credentials', 'prompt context carries no control marker');
  const labelWrites = routes().filter(route => route.includes('/labels'));
  assert.deepEqual(labelWrites, [
    'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
    'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
  ], 'the trigger is re-applied so a submission-backed issue records a fresh trigger');
  assert.ok(routes().indexOf('POST /repos/{owner}/{repo}/issues/{issue_number}/comments') < routes().indexOf(labelWrites[1]),
    'the request is on the issue before the run can read its comments');
  assert.ok(claims.has('issue:dedup:integry:propr:14'), 'the relabel webhook shares the issue dedup window');
});

test('the relabel webhook and a repeated request do not queue a second run', async () => {
  await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  const repeated = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(repeated.status, 409);
  assert.match(String(repeated.json.error), /just requested/);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(postedComments().length, 1);
});

test('an issue run already queued or running refuses the retry before posting', async () => {
  state.existingJobs = [{ name: 'processGitHubIssue', data: { repoOwner: 'integry', repoName: 'propr', number: 14, isChildJob: true } }];
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.status, 409);
  assert.match(String(result.json.error), /already queued or running/);
  assert.equal(postedComments().length, 0);
  assert.equal(add.mock.callCount(), 0);
});

for (const command of ['/review', '/fix', '/ultrafix', '/merge', '/use claude-sonnet-4-6\nRetry', '/switch claude-sonnet-4-6']) {
  test(`${command.split('\n')[0]} on an issue-only task is refused without posting`, async () => {
    const result = await postFollowup({ body: command }, 'failed-issue-task');
    assert.equal(result.status, 400);
    assert.match(String(result.json.error), /need a pull request/);
    assert.equal(request.mock.callCount(), 0);
    assert.equal(add.mock.callCount(), 0);
  });
}

test('an issue task that has not failed is not retried', async () => {
  const result = await postFollowup({ body: 'Retry' }, 'running-issue-task');
  assert.equal(result.status, 409);
  assert.match(String(result.json.error), /This run is processing/);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(add.mock.callCount(), 0);
});

for (const [setup, pattern] of [
  [() => { state.issueState = 'closed'; }, /closed/],
  [() => { state.issueLabels = ['AI', 'AI-done']; }, /marked done/],
] as const) {
  test(`a retry is refused when the issue is ${String(pattern).slice(1, -1)}`, async () => {
    setup();
    const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
    assert.equal(result.status, 409);
    assert.match(String(result.json.error), pattern);
    assert.equal(postedComments().length, 0);
    assert.equal(add.mock.callCount(), 0);
  });
}

test('a trigger that cannot be re-applied reports a failed dispatch and releases the window', async () => {
  state.labelFails = true;
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'failed');
  assert.equal(result.json.posted, true);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(claims.has('issue:dedup:integry:propr:14'), false);
});

test('a queue failure after relabelling reports an unconfirmed submission with its job ID', async () => {
  state.queueFails = true;
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'unknown');
  assert.equal(result.json.jobId, 'issue-integry-propr-14');
  assert.equal(result.json.posted, true);
});

test('the posted issue comment is not picked up as PR follow-up work by the webhook', async () => {
  await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  const body = postedComments()[0].arguments[1].body!;
  const result = await processCommentEvent({
    repository: { owner: { login: 'integry' }, name: 'propr' },
    issue: { number: 14 }, sender: { id: 99 },
    comment: { id: 6157569382, body, user: { login: 'propr-dev[bot]', type: 'Bot' },
      created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
  } as unknown as IssueCommentEvent, 'issue_comment', 'webhook', { redisClient: redis as unknown as Redis, PR_FOLLOWUP_TRIGGER_KEYWORDS: [] });
  assert.deepEqual(result, { status: 'ignored', reason: 'not_pull_request_comment' });
  assert.equal(add.mock.callCount(), 1);
});

for (const [taskId, label] of [['issue-task-with-pr', 'an implementation task with a created PR'], ['pr-comment-task', 'a PR-comment task']]) {
  test(`untargeted follow-up on ${label} keeps PR routing`, async () => {
    const result = await postFollowup({ body: 'Please tighten the validation' }, taskId);
    assert.equal(result.status, 202);
    assert.equal(result.json.state, 'queued');
    const [name, job] = add.mock.calls[0].arguments;
    assert.equal(name, 'processPullRequestComment');
    assert.equal(job.pullRequestNumber, 7);
    assert.equal(job.branchName, 'acceptance');
    assert.equal(job.userId, 'user-1');
    assert.equal(postedComments()[0].arguments[1].issue_number, 7);
    assert.deepEqual(routes().filter(route => route.includes('/labels')), []);
  });
}

test('PR commands on an implementation task with a created PR go to that PR', async () => {
  const result = await postFollowup({ body: '/review' }, 'issue-task-with-pr');
  assert.equal(result.json.state, 'queued');
  const job = add.mock.calls[0].arguments[1];
  assert.equal(job.commandMode, 'review');
  assert.equal(job.pullRequestNumber, 7);
});
