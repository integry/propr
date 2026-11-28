import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { Job } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, request, postFollowup, processCommentEvent, redis, database } from './taskFollowupFixture.js';
import { openRequests, routes, postedComments, relabelWebhook, retryRequestStore, dispatchQueued, promptFor, requestChildId } from './taskFollowupIssueDispatch.js';

const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { insertTaskSubmission } = await import('../../core/src/services/taskSubmissionService.js');
const { fetchIssueComments } = await import('../../../src/jobs/issueJob/github.js');
const { generateClaudePrompt } = await import('../../core/src/claude/prompts/promptGenerator.js');

const pullRequestReads = () => routes().filter(route => route.includes('/pulls/'));

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
  assert.equal(job.retryRequesterId, 'user-1');
  assert.equal(job.retryCommentId, 6157569382);
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
  assert.deepEqual(await relabelWebhook(), { status: 'ignored', reason: 'duplicate_delivery' });
  const repeated = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(repeated.status, 409);
  assert.match(String(repeated.json.error), /just requested/);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(postedComments().length, 1);

  // Outside the shared window the same delivery is admitted, so the claim is what held it back.
  claims.clear();
  assert.notEqual((await relabelWebhook()).status, 'ignored');
  assert.equal(add.mock.callCount(), 2);
});

test('a first retry within the failure second relabels after it, so the submission dispatcher starts a run for the requester with their instructions', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-in-failure-second',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  try {
    // The initial run was dispatched and failed at 10:00:00.500; no retry identity is consumed yet.
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    const result = await postFollowup({ body: 'Retry with the rotated token' }, 'failed-issue-task');
    assert.equal(result.json.state, 'queued');
    assert.deepEqual(state.sleeps, [300], 'the relabel waits for the second after the failure');
    assert.equal(state.timeline.at(-1)!.created_at, '2026-10-15T10:00:01.000Z');

    const { dispatched, children } = await dispatchQueued(0);
    assert.equal(dispatched.status, 'dispatched');
    assert.deepEqual(children.map(child => child.jobId), [await requestChildId()]);
    const [{ data: child }] = children;
    assert.equal(child.correlationId, `${row.id}-${state.timeline.at(-1)!.id}`, 'it runs on the relabel\'s trigger');
    assert.equal(child.userId, 'user-1', 'the retry runs for the requester, not the submitter');
    assert.deepEqual(await openRequests(), [], 'the dispatched request is released');

    // The run reads its prompt context from the issue's comments, where the app posted the request.
    const [posted] = postedComments();
    const issueComments = [
      { id: 1, body: 'An unrelated bot note', user: { login: 'other-app[bot]', type: 'Bot' } },
      { id: 6157569382, body: posted.arguments[1].body!, user: { login: 'propr-dev[bot]', type: 'Bot' } },
    ];
    const octokit = { request: async (route: string, options: { issue_number: number }) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments');
      assert.equal(options.issue_number, 14);
      return { data: issueComments, headers: {} };
    } };
    const comments = await fetchIssueComments(octokit as never, child, { warn: () => undefined } as never);
    assert.deepEqual(comments.map(comment => comment.id), [6157569382], 'only the requested retry is exempt from author filtering');
    const prompt = generateClaudePrompt({ issueRef: { number: 14, repoOwner: 'integry', repoName: 'propr' }, branchName: 'retry', modelName: 'claude-opus-5-5',
      issueDetails: { title: 'Issue', body: 'Body', comments } });
    assert.match(prompt, /Retry with the rotated token/);
    assert.doesNotMatch(prompt, /An unrelated bot note/);
  } finally {
    await database('task_submissions').where({ id: row.id }).delete();
  }
});

/** The direct enqueue fails before the queue accepts it, and the relabel arrives after the shared window. */
async function recoverFailedEnqueue(body: string) {
  state.queueFails = true;
  const result = await postFollowup({ body }, 'failed-issue-task');
  assert.equal(result.json.state, 'unknown');
  assert.equal((await openRequests()).length, 1, 'the request is recorded before the trigger is published');
  state.queueFails = false;
  claims.delete('issue:dedup:integry:propr:14');
  assert.notEqual((await relabelWebhook()).status, 'ignored');
  const [, recovered] = add.mock.calls[1].arguments as unknown as [string, IssueJobData];
  assert.equal(recovered.retryCommentId, undefined, 'the relabel delivery carries no retry metadata');
  return dispatchQueued(1);
}

test('a submission retry whose enqueue failed runs for the requester with their instructions when its relabel recovers it', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-recovered-by-relabel',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  try {
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    const { dispatched, children } = await recoverFailedEnqueue('Retry with the rotated token');
    assert.equal(dispatched.status, 'dispatched');
    const [{ data: child }] = children;
    assert.equal(child.userId, 'user-1', 'the recovered retry runs for the requester, not the submitter');
    assert.equal(child.retryCommentId, 6157569382);
    const prompt = await promptFor(child);
    assert.match(prompt, /Retry with the rotated token/);
    assert.doesNotMatch(prompt, /An unrelated bot note/);
    assert.deepEqual(await openRequests(), [], 'the request is released once a dispatch carries it');
  } finally {
    await database('task_submissions').where({ id: row.id }).delete();
  }
});

test('an issue-only retry whose enqueue failed runs for the requester with their instructions when its relabel recovers it', async () => {
  const { children } = await recoverFailedEnqueue('Retry without the cache');
  const [{ data: child }] = children;
  assert.equal(child.userId, 'user-1', 'not the app account that re-applied the label');
  assert.match(await promptFor(child), /Retry without the cache/);
  assert.deepEqual(await openRequests(), []);
});

test('a dispatch that fails keeps the request for the next recovery', async () => {
  state.queueFails = true;
  await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  state.queueFails = false;
  claims.delete('issue:dedup:integry:propr:14');
  await relabelWebhook();
  const [name, data] = add.mock.calls[1].arguments as unknown as [string, IssueJobData];
  const deps = {
    findSubmission: async () => undefined, recordDispatch: async () => undefined, recordDispatchFailure: async () => undefined,
    getAuthenticatedOctokit: async () => { throw new Error('GitHub unavailable'); },
    withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
    retryRequests: retryRequestStore,
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
  await assert.rejects(handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data } as Job<IssueJobData>, deps), /GitHub unavailable/);
  assert.equal((await openRequests()).length, 1);
});

test('a trigger that cannot be re-applied does not hold the request for a later trigger', async () => {
  state.labelFails = true;
  await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.deepEqual(await openRequests(), []);
});

test('a failure recorded beyond the bounded wait is refused before posting or relabelling', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-clock-behind',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  // The database clock runs five seconds ahead of the API clock.
  await database('task_history').where({ task_id: 'failed-issue-task', state: 'failed' }).update({ timestamp: '2026-10-15T10:00:05.700Z' });
  try {
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
    assert.equal(result.status, 409);
    assert.match(String(result.json.error), /would not start a run yet/);
    assert.deepEqual(state.sleeps, [2000], 'the wait stays bounded');
    assert.equal(postedComments().length, 0);
    assert.deepEqual(routes().filter(route => route.includes('/labels')), []);
    assert.equal(add.mock.callCount(), 0);
    assert.equal(claims.has('issue:dedup:integry:propr:14'), false, 'a refusal holds no dedup window');
  } finally {
    await database('task_history').where({ task_id: 'failed-issue-task', state: 'failed' }).update({ timestamp: '2026-10-15T10:00:00.500Z' });
    await database('task_submissions').where({ id: row.id }).delete();
  }
});

test('a submission whose latest run has not finished is refused before posting', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-while-running',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  try {
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', latest_task_id: 'running-issue-task', dispatch_complete: true });
    const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
    assert.equal(result.status, 409);
    assert.match(String(result.json.error), /not recorded as finished/);
    assert.equal(postedComments().length, 0);
    assert.equal(add.mock.callCount(), 0);
  } finally {
    await database('task_submissions').where({ id: row.id }).delete();
  }
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

/** GitHub applies the trigger but its response is lost and the labels cannot be read back; the relabel arrives after the shared window. */
async function recoverLostTrigger(body: string) {
  state.labelAdd = 'lost';
  state.onLabelAdd = () => { state.timelineReadFails = true; };
  const result = await postFollowup({ body }, 'failed-issue-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'unknown', 'a trigger that may have landed is not reported as not started');
  assert.match(String(result.json.message), /may still start/);
  assert.equal(add.mock.callCount(), 0);
  assert.equal((await openRequests()).length, 1, 'the request survives an unconfirmed trigger');
  assert.ok(claims.has('issue:dedup:integry:propr:14'), 'the window still holds back a second run');
  assert.deepEqual(await relabelWebhook(), { status: 'ignored', reason: 'duplicate_delivery' });
  claims.delete('issue:dedup:integry:propr:14');
  assert.notEqual((await relabelWebhook()).status, 'ignored');
  assert.equal(add.mock.callCount(), 1);
  const [, recovered] = add.mock.calls[0].arguments as unknown as [string, IssueJobData];
  assert.equal(recovered.retryCommentId, undefined, 'the relabel delivery carries no retry metadata');
  return dispatchQueued(0);
}

test('a submission retry whose trigger response was lost runs for the requester with their instructions when its relabel recovers it', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-trigger-response-lost',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  try {
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    const { dispatched, children } = await recoverLostTrigger('Retry with the rotated token');
    assert.equal(dispatched.status, 'dispatched');
    const [{ data: child }] = children;
    assert.equal(child.userId, 'user-1', 'the recovered retry runs for the requester, not the submitter');
    assert.equal(child.retryCommentId, 6157569382);
    const prompt = await promptFor(child);
    assert.match(prompt, /Retry with the rotated token/);
    assert.doesNotMatch(prompt, /An unrelated bot note/);
    assert.deepEqual(await openRequests(), [], 'the request is released once a dispatch carries it');
  } finally {
    await database('task_submissions').where({ id: row.id }).delete();
  }
});

test('an issue-only retry whose trigger response was lost runs for the requester with their instructions when its relabel recovers it', async () => {
  const { children } = await recoverLostTrigger('Retry without the cache');
  const [{ data: child }] = children;
  assert.equal(child.userId, 'user-1', 'not the app account that re-applied the label');
  assert.match(await promptFor(child), /Retry without the cache/);
  assert.deepEqual(await openRequests(), []);
});

test('a lost trigger response that the issue confirms queues the retry once for the requester', async () => {
  state.labelAdd = 'lost';
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.json.success, true);
  assert.equal(result.json.state, 'queued');
  assert.equal(add.mock.callCount(), 1);
  const [, job] = add.mock.calls[0].arguments as unknown as [string, IssueJobData];
  assert.equal(job.retryRequesterId, 'user-1');
  assert.equal(job.retryCommentId, 6157569382);
  assert.deepEqual(await relabelWebhook(), { status: 'ignored', reason: 'duplicate_delivery' });
  assert.equal(add.mock.callCount(), 1);
});

test('a trigger GitHub refused reports the retry as not started and releases the request and window', async () => {
  state.labelAdd = 'rejected';
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'failed');
  assert.match(String(result.json.message), /could not be started/);
  const afterAdd = routes().slice(routes().indexOf('POST /repos/{owner}/{repo}/issues/{issue_number}/labels') + 1);
  assert.deepEqual(afterAdd, [], 'a refusal GitHub answered needs no read-back');
  assert.equal(add.mock.callCount(), 0);
  assert.deepEqual(await openRequests(), []);
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
