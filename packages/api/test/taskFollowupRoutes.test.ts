import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, beforeEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import type { Redis } from 'ioredis';
import type { JobsOptions } from 'bullmq';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { CommentJobData } from '../../core/src/queue/taskQueue.js';
import type { UltrafixDeps } from '../../core/src/webhook/commentEventHandler.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-followup-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

const claims = new Map<string, string>();
const redis = {
  set: mock.fn(async (key: string, value: string) => {
    if (claims.has(key)) return null;
    claims.set(key, value);
    return 'OK';
  }),
  get: async (key: string) => claims.get(key) ?? null,
  setex: async (key: string, _ttl: number, value: string) => { claims.set(key, value); },
  del: async (key: string) => { claims.delete(key); },
  eval: async () => 1,
  rpush: mock.fn(async (...args: [string, string]) => { assert.equal(args.length, 2); return 1; }),
  expire: async () => 1,
};
let existingJobs: unknown[] = [];
let queueFails = false;
let acceptBeforeFailure = false;
const acceptedJobs = new Map<string, CommentJobData>();
const add = mock.fn(async (...args: [string, CommentJobData, JobsOptions]) => {
  assert.equal(args[0], 'processPullRequestComment');
  if (!queueFails || acceptBeforeFailure) acceptedJobs.set(args[2].jobId!, args[1]);
  if (queueFails) throw new Error('connection lost');
});
const queue = { add, client: Promise.resolve(redis), getActive: async () => existingJobs, getWaiting: async () => [], getDelayed: async () => [] };
const queueModule = await import('../../core/src/queue/taskQueue.js');
await mock.module('../../core/src/queue/taskQueue.js', {
  namedExports: { ...queueModule, issueQueue: queue, getIssueQueue: async () => queue },
});
let webhookFirst = false;
async function deliverWebhook(body: string, login = 'propr-dev[bot]', repo = 'propr') {
  return processCommentEvent({
    repository: { owner: { login: 'integry' }, name: repo },
    issue: { number: 7, pull_request: {} }, sender: { id: 99 },
    comment: { id: 6157569382, body, user: { login, type: 'Bot' },
      created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
  } as unknown as IssueCommentEvent, 'issue_comment', 'webhook', {
    redisClient: redis as unknown as Redis, PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
  });
}
const request = mock.fn(async (route: string, options: { body?: string }) => {
  if (webhookFirst && options.body?.includes('<!-- propr-api-followup:')) await deliverWebhook(options.body);
  if (route.startsWith('POST') && route.endsWith('/comments')) return { data: {
    id: 6157569382, body: options.body, user: { login: 'propr-dev[bot]', type: 'Bot' },
    created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z',
  } };
  if (route.startsWith('GET') && route.includes('/pulls/')) return { data: { head: { ref: 'acceptance' }, labels: [] } };
  return { data: {} };
});
const authModule = await import('../../core/src/auth/githubAuth.js');
await mock.module('../../core/src/auth/githubAuth.js', {
  namedExports: { ...authModule, getAuthenticatedOctokit: async () => ({ request, paginate: async () => [] }) },
});
const labels = await import('../../core/src/utils/github/labelOperations.js');
const updateLabels = mock.fn(async (_context: unknown, removed: string[], added: string[]) => ({ success: true, removed, added, errors: [] }));
await mock.module('../../core/src/utils/github/labelOperations.js', { namedExports: { ...labels, safeUpdateLabels: updateLabels } });
const { setUltrafixDeps, processCommentEvent } = await import('../../core/src/webhook/commentEventHandler.js');
const invalidate = mock.fn(async () => ({ workEpoch: 8, hadAutomaticWork: true }));
const startLoop = mock.fn(async (_redis: unknown, _options: Parameters<UltrafixDeps['startLoop']>[1], pending: boolean) => ({ state: {}, initialAction: pending ? 'fix' as const : 'review' as const }));
let pendingReview = false;
setUltrafixDeps({
  loadUltrafixRatingGoal: async () => 9, loadUltrafixMaxCycles: async () => 5,
  loadUltrafixPauseSeconds: async () => 60, loadPrReviewModel: async () => 'gpt-5',
  startLoop, clearStateIfCurrent: async () => true, hasAutomaticWork: async () => false,
  reserveAutomaticWork: async () => 8, invalidateAutomaticWork: invalidate,
  getPendingReviewState: async () => ({ hasPendingReview: pendingReview }),
});
beforeEach(() => {
  claims.clear(); existingJobs = []; queueFails = false; pendingReview = false; webhookFirst = false; acceptBeforeFailure = false; acceptedJobs.clear();
  for (const fn of [add, request, invalidate, startLoop, updateLabels, redis.rpush]) fn.mock.resetCalls();
});

const { closeConnection } = await import('@propr/core');
const { createTaskRoutes, resolveFollowupThread } = await import('../routes/taskRoutes.js');

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => {
  table.text('task_id').primary();
  table.text('repository').notNullable();
  table.integer('issue_number').nullable();
  table.integer('pr_number').nullable();
  table.text('task_type').notNullable();
});
await database('tasks').insert([
  { task_id: 'completed-task', repository: 'integry/propr', issue_number: 12, pr_number: 7, task_type: 'issue' },
  { task_id: 'task-without-pr', repository: 'integry/propr', issue_number: null, pr_number: null, task_type: 'issue' },
  { task_id: 'issue-task-without-pr', repository: 'integry/propr', issue_number: 12, pr_number: null, task_type: 'issue' },
]);

after(async () => {
  await database.destroy();
  await closeConnection();
  await rm(isolatedDbDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
  else process.env.DB_FILENAME = originalDbFilename;
});

async function postFollowup(body: Record<string, unknown>, taskId = 'task-without-pr'): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = { status: 200, json: {} as Record<string, unknown> };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: unknown) { result.json = payload as Record<string, unknown>; return this; },
  } as unknown as Response;
  await createTaskRoutes({ db: database }).postFollowup({
    params: { taskId },
    body,
    user: { id: 'user-1' },
  } as unknown as Request, response);
  return result;
}

test('rejects unknown follow-up targets before posting anything', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'issue' }), {
    status: 400,
    json: { error: 'Follow-up target must be "pull_request" when provided' },
  });
});

test('requires a pull request when a follow-up command targets one', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'pull_request' }), {
    status: 400,
    json: { error: 'Task does not have a valid GitHub pull request' },
  });
});

test('does not post a pull request command onto the issue of an issue task without a PR', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'pull_request' }, 'issue-task-without-pr'), {
    status: 400,
    json: { error: 'Task does not have a valid GitHub pull request' },
  });
});

test('resolves historical PR-comment task IDs whose stored task type is issue', () => {
  const task = {
    task_id: 'pr-comments-batch-integry-propr-2506-5831013617-2026-09-25T10-37-33Z-87ecb969a008',
    repository: 'integry/propr',
    issue_number: 2506,
    pr_number: null,
    task_type: 'issue',
  };

  assert.deepEqual(resolveFollowupThread(task, true), {
    number: 2506,
    error: 'Task does not have a valid GitHub pull request',
  });
});

for (const mode of ['review', 'fix']) {
  test(`API /${mode} queues command metadata and takes over automatic work`, async () => {
    existingJobs = [{ name: 'processPullRequestComment', data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 7, ultrafixMeta: { workEpoch: 7 } } }];
    const command = mode === 'review' ? '/review gpt-5\nCheck error handling' : '/fix\nFix the blockers';
    const result = await postFollowup({ body: command, target: 'pull_request' }, 'completed-task');
    assert.equal(result.status, 202);
    assert.equal(result.json.state, 'queued');
    assert.equal(add.mock.callCount(), 1);
    const [name, job, options] = add.mock.calls[0].arguments;
    assert.equal(name, 'processPullRequestComment');
    assert.equal(job.commandMode, mode);
    assert.equal(job.commandMeta?.mode, mode);
    assert.equal(job.userId, 'user-1');
    assert.equal(job.branchName, 'acceptance');
    assert.equal(job.pullRequestNumber, 7);
    assert.equal(job.commandCommentId, 6157569382);
    assert.equal(job.commandCommentType, 'issue');
    assert.equal(job.comments![0].body, mode === 'review' ? 'Check error handling' : 'Fix the blockers');
    if (mode === 'review') assert.deepEqual(job.requestedModels, ['gpt-5']);
    assert.equal(job.commandInstructions, job.comments![0].body);
    assert.equal(options.jobId, result.json.jobId);
    assert.equal(invalidate.mock.callCount(), 1);
    assert.equal(redis.rpush.mock.callCount(), 0);
  });
}

for (const pending of [false, true]) {
  test(`API /ultrafix starts the loop with ${pending ? 'fix' : 'review'}`, async () => {
    pendingReview = pending;
    const result = await postFollowup({ body: '/ultrafix\nFocus on errors', target: 'pull_request' }, 'completed-task');
    assert.equal(result.json.state, 'queued');
    const job = add.mock.calls[0].arguments[1];
    assert.equal(job.commandMode, pending ? 'fix' : 'review');
    assert.equal(job.ultrafixMeta?.mode, 'ultrafix');
    assert.equal(job.ultrafixMeta?.workEpoch, 8);
    assert.equal(job.comments![0].body, 'Focus on errors');
    assert.deepEqual(updateLabels.mock.calls[0].arguments.slice(1), [[], ['ultrafix']]);
    assert.equal(startLoop.mock.callCount(), 1);
    const loop = startLoop.mock.calls[0].arguments[1];
    assert.equal(loop.userId, 'user-1');
    assert.equal(loop.goal, 9);
    assert.equal(loop.sourceCommentId, 6157569382);
    assert.equal(loop.reviewModel, 'gpt-5');
    assert.equal(invalidate.mock.callCount(), 0);
  });
}

test('ordinary prose retains the posted text and requesting user', async () => {
  await postFollowup({ body: 'Please improve the error message', target: 'pull_request' }, 'completed-task');
  const job = add.mock.calls[0].arguments[1];
  assert.equal(job.commandMode, undefined);
  assert.equal(job.comments![0].body, 'Please improve the error message');
  assert.equal(job.userId, 'user-1');
  assert.equal(invalidate.mock.callCount(), 0);
});

test('queue failure preserves the uncertain receipt after posting', async () => {
  queueFails = true;
  const result = await postFollowup({ body: '/review', target: 'pull_request' }, 'completed-task');
  assert.equal(result.status, 202);
  assert.equal(result.json.success, false);
  assert.equal(result.json.state, 'unknown');
  assert.equal(result.json.posted, true);
  assert.equal(result.json.commentId, 6157569382);
  assert.equal(result.json.jobId, add.mock.calls[0].arguments[2].jobId);
});

for (const command of ['/review', '/fix', '/ultrafix']) {
  test(`bot webhook for posted ${command} does not duplicate API work`, async () => {
    await postFollowup({ body: command, target: 'pull_request' }, 'completed-task');
    const result = await processCommentEvent({
      repository: { owner: { login: 'integry' }, name: 'propr' },
      issue: { number: 7, pull_request: {} },
      sender: { id: 99 },
      comment: { id: 6157569382, body: command, user: { login: 'propr-dev[bot]', type: 'Bot' },
        created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
    } as unknown as IssueCommentEvent, 'issue_comment', 'webhook-redelivery', {
      redisClient: redis as unknown as Redis, PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
    });
    assert.equal(result.status, 'ignored');
    if (result.status === 'ignored') assert.equal(result.reason, command === '/ultrafix' ? 'duplicate_delivery' : 'filtered_author');
    assert.equal(add.mock.callCount(), 1);
    assert.equal(startLoop.mock.callCount(), command === '/ultrafix' ? 1 : 0);
  });
}

test('review batched behind manual work preserves command metadata', async () => {
  existingJobs = [{ name: 'processPullRequestComment', data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 7, commandMode: 'fix' } }];
  const result = await postFollowup({ body: '/review gpt-5\nCheck errors', target: 'pull_request' }, 'completed-task');
  assert.equal(result.json.state, 'queued');
  assert.equal(result.json.jobId, undefined, 'do not return a nonexistent job ID for a batched command');
  assert.equal(add.mock.callCount(), 0);
  assert.equal(redis.rpush.mock.callCount(), 1);
  const pending = JSON.parse(redis.rpush.mock.calls[0].arguments[1]);
  assert.equal(pending.commandMode, 'review');
  assert.deepEqual(pending.requestedModels, ['gpt-5']);
  assert.equal(pending.body, 'Check errors');
});

test('bare desktop /review queues a dedicated review with an empty instruction body', async () => {
  await postFollowup({ body: '/review', target: 'pull_request' }, 'completed-task');
  const job = add.mock.calls[0].arguments[1];
  assert.equal(job.commandMode, 'review');
  assert.deepEqual(job.requestedModels, []);
  assert.equal(job.comments![0].body, '');
});

test('/switch uses shared label side effects without queuing an implementation', async () => {
  await postFollowup({ body: '/switch claude-sonnet-4-6', target: 'pull_request' }, 'completed-task');
  assert.equal(add.mock.callCount(), 0);
  assert.deepEqual(updateLabels.mock.calls[0].arguments.slice(1), [[], ['llm-claude-sonnet-4-6']]);
});

test('/use carries the requested model and stripped instructions', async () => {
  await postFollowup({ body: '/use claude-sonnet-4-6\nImprove the error message', target: 'pull_request' }, 'completed-task');
  const job = add.mock.calls[0].arguments[1];
  assert.equal(job.commandMode, 'use');
  assert.equal(job.llm, 'claude-sonnet-4-6');
  assert.deepEqual(job.requestedModels, ['claude-sonnet-4-6']);
  assert.equal(job.comments![0].body, 'Improve the error message');
  assert.equal(updateLabels.mock.callCount(), 0);
});

for (const first of [false, true]) {
  for (const command of ['/review', '/fix', '/ultrafix']) {
    for (const acceptance of ['confirmed', 'rejected', 'accepted-then-disconnected']) {
      const uncertain = acceptance !== 'confirmed';
      test(`${command}: ${first ? 'webhook' : 'API'} first, queue ${acceptance}`, async () => {
        webhookFirst = first;
        queueFails = uncertain;
        acceptBeforeFailure = acceptance === 'accepted-then-disconnected';
        const result = await postFollowup({ body: command, target: 'pull_request' }, 'completed-task');
        const postedBody = request.mock.calls.find(call => call.arguments[1].body?.includes('<!-- propr-api-followup:'))!.arguments[1].body!;
        await deliverWebhook(postedBody);
        assert.equal(result.json.state, uncertain ? 'unknown' : 'queued');
        assert.equal(result.json.jobId, add.mock.calls[0].arguments[2].jobId);
        assert.equal(add.mock.callCount(), 1);
        assert.equal(acceptedJobs.size, acceptance === 'rejected' ? 0 : 1);
        if (acceptedJobs.size) assert.equal(acceptedJobs.get(String(result.json.jobId))?.userId, 'user-1');
        assert.equal(add.mock.calls[0].arguments[1].userId, 'user-1');
        assert.equal(add.mock.calls[0].arguments[1].comments![0].body, '');
        assert.equal(startLoop.mock.callCount(), command === '/ultrafix' ? 1 : 0);
        if (command === '/ultrafix') {
          assert.equal(startLoop.mock.calls[0].arguments[1].userId, 'user-1');
          assert.equal(updateLabels.mock.callCount(), 1, 'keep label on uncertain acceptance');
        }
      });
    }
  }
}

test('unregistered markers do not bypass bot author filtering', async () => {
  const result = await deliverWebhook('/review\n\n<!-- propr-api-followup:00000000-0000-0000-0000-000000000000 -->');
  assert.deepEqual(result, { status: 'ignored', reason: 'filtered_author' });
  assert.equal(add.mock.callCount(), 0);
});

test('external bot ultrafix retains its sender and normal side effects', async () => {
  await deliverWebhook('/ultrafix');
  assert.equal(add.mock.calls[0].arguments[1].userId, '99');
  assert.equal(startLoop.mock.calls[0].arguments[1].userId, '99');
  assert.equal(updateLabels.mock.callCount(), 1);
});

test('registered markers are bound to body, repository and configured author', async () => {
  await postFollowup({ body: '/review', target: 'pull_request' }, 'completed-task');
  const body = request.mock.calls.find(call => call.arguments[1].body?.includes('<!-- propr-api-followup:'))!.arguments[1].body!;
  for (const result of [await deliverWebhook(body + ' edited'), await deliverWebhook(body, 'external[bot]'), await deliverWebhook(body, 'propr-dev[bot]', 'another')]) {
    assert.deepEqual(result, { status: 'ignored', reason: 'filtered_author' });
  }
  assert.equal(add.mock.callCount(), 1);
});
