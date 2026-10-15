import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, beforeEach, mock } from 'node:test';
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

export const state = {
  existingJobs: [] as unknown[], queueFails: false, acceptBeforeFailure: false,
  webhookFirst: false, prState: 'open', commentPostError: undefined as unknown,
  startLoopFails: false, pendingReview: false,
  issueState: 'open', issueLabels: ['AI', 'llm-claude-opus-5-5'] as string[], labelFails: false,
  // GitHub's clock and the issue timeline it stamps label events on, to the second.
  now: Date.parse('2026-10-15T10:00:00.700Z'), sleeps: [] as number[],
  timeline: [] as Array<{ id: number; event: string; created_at: string; label: { name: string } }>,
};

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
  eval: async (script: string, _count: number, key: string, token: string) => {
    if (claims.get(key) !== token) return 0;
    if (script.includes("redis.call('DEL'")) claims.delete(key);
    return 1;
  },
  rpush: mock.fn(async (...args: [string, string]) => { assert.equal(args.length, 2); return 1; }),
  expire: async () => 1,
  smembers: async () => [],
};
const acceptedJobs = new Map<string, CommentJobData>();
const add = mock.fn(async (...args: [string, CommentJobData, JobsOptions]) => {
  assert.ok(['processPullRequestComment', 'processGitHubIssue'].includes(args[0]));
  if (!state.queueFails || state.acceptBeforeFailure) acceptedJobs.set(args[2].jobId!, args[1]);
  if (state.queueFails) throw new Error('connection lost');
});
const queue = { add, client: Promise.resolve(redis), getActive: async () => state.existingJobs, getWaiting: async () => [], getDelayed: async () => [] };
const queueModule = await import('../../core/src/queue/taskQueue.js');
await mock.module('../../core/src/queue/taskQueue.js', {
  namedExports: { ...queueModule, issueQueue: queue, getIssueQueue: async () => queue },
});
export async function deliverWebhook(body: string, login = 'propr-dev[bot]', repo = 'propr') {
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
  if (route.startsWith('POST') && route.endsWith('/comments') && state.commentPostError) throw state.commentPostError;
  if (state.webhookFirst && options.body?.includes('<!-- propr-api-followup:')) await deliverWebhook(options.body);
  if (route.startsWith('POST') && route.endsWith('/comments')) return { data: {
    id: 6157569382, body: options.body, user: { login: 'propr-dev[bot]', type: 'Bot' },
    created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z',
  } };
  if (route.startsWith('GET') && route.includes('/pulls/')) return { data: { state: state.prState, head: { ref: 'acceptance' }, labels: [] } };
  if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
    return { data: { state: state.issueState, labels: state.issueLabels.map(name => ({ name })) } };
  }
  if (route.includes('/labels') && state.labelFails) throw Object.assign(new Error('label write failed'), { status: 500 });
  if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
    const created_at = new Date(Math.floor(state.now / 1000) * 1000).toISOString();
    for (const name of (options as { labels?: string[] }).labels ?? []) {
      state.timeline.push({ id: state.timeline.length + 1, event: 'labeled', created_at, label: { name } });
    }
  }
  if (route.endsWith('/timeline')) return { data: state.timeline };
  return { data: {} };
});
const authModule = await import('../../core/src/auth/githubAuth.js');
await mock.module('../../core/src/auth/githubAuth.js', {
  namedExports: { ...authModule, getAuthenticatedOctokit: async () => ({ request, paginate: async () => [] }) },
});
const labels = await import('../../core/src/utils/github/labelOperations.js');
const updateLabels = mock.fn(async (_context: unknown, removed: string[], added: string[]) => ({ success: true, removed, added, errors: [] }));
await mock.module('../../core/src/utils/github/labelOperations.js', { namedExports: { ...labels, safeUpdateLabels: updateLabels } });
const registryModule = await import('../../core/src/agents/AgentRegistry.js');
await mock.module('../../core/src/agents/AgentRegistry.js', {
  namedExports: { ...registryModule, AgentRegistry: class {
    static getInstance() { return { ensureInitialized: async () => {}, getAllAgents: () => [] }; }
  } },
});
const { setUltrafixDeps, processCommentEvent } = await import('../../core/src/webhook/commentEventHandler.js');
const invalidate = mock.fn(async () => ({ workEpoch: 8, hadAutomaticWork: true }));
const clearState = mock.fn(async () => true);
const startLoop = mock.fn(async (_redis: unknown, _options: Parameters<UltrafixDeps['startLoop']>[1], pending: boolean) => {
  if (state.startLoopFails) throw new Error('startLoop failed');
  return { state: {}, initialAction: pending ? 'fix' as const : 'review' as const };
});
setUltrafixDeps({
  loadUltrafixRatingGoal: async () => 9, loadUltrafixMaxCycles: async () => 5,
  loadUltrafixPauseSeconds: async () => 60, loadPrReviewModel: async () => 'gpt-5',
  startLoop, clearStateIfCurrent: clearState, hasAutomaticWork: async () => false,
  reserveAutomaticWork: async () => 8, invalidateAutomaticWork: invalidate,
  getPendingReviewState: async () => ({ hasPendingReview: state.pendingReview }),
});
beforeEach(() => {
  state.startLoopFails = false; state.prState = 'open'; state.commentPostError = undefined;
  state.issueState = 'open'; state.issueLabels = ['AI', 'llm-claude-opus-5-5']; state.labelFails = false;
  state.now = Date.parse('2026-10-15T10:00:00.700Z'); state.sleeps = [];
  state.timeline = [{ id: 1, event: 'labeled', created_at: '2026-10-15T09:59:00Z', label: { name: 'AI' } }];
  claims.clear(); state.existingJobs = []; state.queueFails = false; state.pendingReview = false; state.webhookFirst = false; state.acceptBeforeFailure = false; acceptedJobs.clear();
  for (const fn of [add, request, invalidate, startLoop, clearState, updateLabels, redis.rpush]) fn.mock.resetCalls();
});

const { closeConnection } = await import('@propr/core');
const { up: submissionsTable } = await import('../../core/src/db/migrations/20260922000000_add_task_submissions.js');
const { up: submissionIdentity } = await import('../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js');
const { createTaskRoutes, resolveFollowupThread } = await import('../routes/taskRoutes.js');

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => {
  table.text('task_id').primary();
  table.text('repository').notNullable();
  table.integer('issue_number').nullable();
  table.integer('pr_number').nullable();
  table.text('task_type').notNullable();
  table.text('replay_job_data').nullable();
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id');
  table.text('task_id').notNullable();
  table.text('state').notNullable();
  table.text('timestamp').nullable();
});
await submissionsTable(database);
await submissionIdentity(database);
await database('tasks').insert([
  { task_id: 'completed-task', repository: 'integry/propr', issue_number: 12, pr_number: 7, task_type: 'issue' },
  { task_id: 'task-without-pr', repository: 'integry/propr', issue_number: null, pr_number: null, task_type: 'issue' },
  { task_id: 'issue-task-without-pr', repository: 'integry/propr', issue_number: 12, pr_number: null, task_type: 'issue' },
  { task_id: 'failed-issue-task', repository: 'integry/propr', issue_number: 14, pr_number: null, task_type: 'issue',
    replay_job_data: JSON.stringify({ triggeringLabel: 'AI', agentAlias: 'claude', modelName: 'claude-opus-5-5' }) },
  { task_id: 'running-issue-task', repository: 'integry/propr', issue_number: 15, pr_number: null, task_type: 'issue' },
  { task_id: 'issue-task-with-pr', repository: 'integry/propr', issue_number: 16, pr_number: 7, task_type: 'issue' },
  { task_id: 'pr-comment-task', repository: 'integry/propr', issue_number: 7, pr_number: null, task_type: 'pr-comment' },
]);
await database('task_history').insert([
  { task_id: 'failed-issue-task', state: 'processing' },
  { task_id: 'failed-issue-task', state: 'failed', timestamp: '2026-10-15T10:00:00.500Z' },
  { task_id: 'running-issue-task', state: 'processing' },
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

export async function postFollowup(body: Record<string, unknown>, taskId = 'task-without-pr'): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = { status: 200, json: {} as Record<string, unknown> };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: unknown) { result.json = payload as Record<string, unknown>; return this; },
  } as unknown as Response;
  await createTaskRoutes({
    db: database, processingLabels: async () => ['AI'],
    now: () => state.now, sleep: async ms => { state.sleeps.push(ms); state.now += ms; },
  }).postFollowup({
    params: { taskId },
    body,
    user: { id: 'user-1' },
  } as unknown as Request, response);
  return result;
}


export { claims, redis, acceptedJobs, add, request, updateLabels, invalidate, clearState, startLoop, processCommentEvent, database, createTaskRoutes, resolveFollowupThread };
