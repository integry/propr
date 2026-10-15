import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { Job } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, request, postFollowup, processCommentEvent, redis, database } from './taskFollowupFixture.js';

const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');
const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { insertTaskSubmission, findIssueSubmission } = await import('../../core/src/services/taskSubmissionService.js');
const { resolveTaskSubmissionRetry } = await import('../../core/src/services/taskSubmissionRetry.js');

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

/** The label webhook GitHub delivers for the route's relabel, as the webhook handler admits it. */
const relabelWebhook = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'webhook', triggerReapplied: true,
}, 'relabel-webhook', redis as unknown as Redis);

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

test('a first retry within the failure second relabels after it, so the submission dispatcher starts a run', async () => {
  const row = await insertTaskSubmission(database, { user_id: 'submitter', submission_key: 'retry-in-failure-second',
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' });
  try {
    // The initial run was dispatched and failed at 10:00:00.500; no retry identity is consumed yet.
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
    assert.equal(result.json.state, 'queued');
    assert.deepEqual(state.sleeps, [300], 'the relabel waits for the second after the failure');
    assert.equal(state.timeline.at(-1)!.created_at, '2026-10-15T10:00:01.000Z');

    const children: string[] = [];
    const deps = {
      findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
      resolveSubmissionRetry: (submission: Parameters<typeof resolveTaskSubmissionRetry>[0]) => resolveTaskSubmissionRetry(submission, database,
        async () => ({ request: async () => ({ data: state.timeline }) }) as never, async () => ['AI']),
      recordDispatch: async () => undefined, recordDispatchFailure: async () => undefined,
      getAuthenticatedOctokit: async () => ({ request: async () => ({ data: { labels: state.issueLabels.map(name => ({ name })) } }) }),
      withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
      validateRepositoryInfo: async () => ({ isValid: true, repoData: { defaultBranch: 'main' } }),
      resolveLlmLabel: async () => ({ agentAlias: 'claude', model: 'claude-opus-5-5' }),
      getAllCustomLabels: async () => [], getDefaultModel: () => 'claude-opus-5-5',
      issueQueue: { add: async (_name: string, _data: IssueJobData, options: { jobId: string }) => { children.push(options.jobId); } },
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
    const [name, data] = add.mock.calls[0].arguments as unknown as [string, IssueJobData];
    const dispatched = await handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data } as Job<IssueJobData>, deps);
    assert.equal(dispatched.status, 'dispatched');
    assert.deepEqual(children, [`issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${state.timeline.at(-1)!.id}`]);
  } finally {
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
