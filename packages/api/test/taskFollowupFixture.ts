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

// The ID of the first comment a test posts.
export const FIRST_COMMENT_ID = 6157569382;

export const state = {
  existingJobs: [] as unknown[], queueFails: false, acceptBeforeFailure: false,
  webhookFirst: false, prState: 'open', commentPostError: undefined as unknown,
  startLoopFails: false, pendingReview: false,
  issueState: 'open', issueLabels: ['AI', 'llm-claude-opus-5-5'] as string[], labelFails: false,
  // How GitHub answers the trigger add: applied but its response lost, refused, or timed out while GitHub
  // still applies it later; and whether the issue's timeline can be read.
  labelAdd: 'ok' as 'ok' | 'lost' | 'rejected' | 'delayed', timelineReadFails: false, delayedLabels: [] as string[],
  // Whether Redis scripts fail, as during a Redis connection failure, and a hook run as GitHub
  // receives the trigger add, before it answers.
  redisFails: false, onLabelAdd: undefined as undefined | (() => void | Promise<void>),
  // Whether a dispatch fails to record that it consumed a retry request, the trigger write its job confirms,
  // or the submission's dispatch receipt; and whether adding a requested retry's run fails before it reaches the queue.
  consumeFails: false, confirmFails: false, recordDispatchFails: false, runEnqueueFails: false,
  // Whether the queue's records of requested retries' runs cannot be read.
  runRecordsFail: false,
  // Hooks run while GitHub creates a posted comment, while it reads the issue, and while it reads its timeline, before it answers.
  onCommentPost: undefined as undefined | (() => void | Promise<void>),
  onIssueRead: undefined as undefined | (() => void | Promise<void>),
  onTimelineRead: undefined as undefined | (() => void | Promise<void>),
  // A hook run once GitHub removed a label, before its successful answer arrives.
  onLabelRemove: undefined as undefined | (() => void | Promise<void>),
  // A hook run once GitHub read the issue's timeline for a dispatch, before its answer arrives, and whether that read fails.
  onDispatchTimelineRead: undefined as undefined | (() => void | Promise<void>), dispatchTimelineFails: false,
  // Outcome records the route left to retry after responding; a test runs them.
  outcomeRetries: [] as Array<() => Promise<boolean>>,
  // The ID GitHub gives the next posted comment; every post gets its own.
  nextCommentId: FIRST_COMMENT_ID,
  // GitHub's clock and the issue timeline it stamps label events on, to the second.
  now: Date.parse('2026-10-15T10:00:00.700Z'), sleeps: [] as number[],
  timeline: [] as Array<{ id: number; event: string; created_at: string; label: { name: string }; actor: { id: number } }>,
  // The processing labels configured now, which the route and dispatch read.
  processingLabels: ['AI'],
};

// The GitHub identity the app's credentials act as, and a person labelling the issue themselves.
export const APP_ACTOR_ID = 99;
export const HUMAN_ACTOR_ID = 7;

const claims = new Map<string, string>();
// Hashes, such as the queue's records of requested retries' runs.
const hashes = new Map<string, Record<string, string>>();
const redisDown = () => { if (state.redisFails) throw new Error('Connection is closed.'); };
const redis = {
  set: mock.fn(async (key: string, value: string) => {
    redisDown();
    if (claims.has(key)) return null;
    claims.set(key, value);
    return 'OK';
  }),
  get: async (key: string) => { redisDown(); return claims.get(key) ?? null; },
  setex: async (key: string, _ttl: number, value: string) => { claims.set(key, value); },
  del: async (key: string) => { redisDown(); claims.delete(key); hashes.delete(key); },
  hset: async (key: string, fields: Record<string, string>) => { redisDown(); hashes.set(key, { ...hashes.get(key), ...fields }); },
  hgetall: async (key: string) => {
    redisDown();
    if (state.runRecordsFail) throw new Error('Connection is closed.');
    return { ...hashes.get(key) };
  },
  eval: async (script: string, _count: number, key: string, ...[token, next]: string[]) => {
    if (state.redisFails) throw new Error('Connection is closed.');
    if (script.includes("ARGV[2] == ''")) {
      // Replaces the value only if it is still the one read; an empty value means none.
      if ((claims.get(key) ?? '') !== token) return 0;
      if (next) claims.set(key, next); else claims.delete(key);
      return 1;
    }
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
const queue = {
  add, client: Promise.resolve(redis), toKey: (type: string) => `bull:github-issue-processor:${type}`,
  getActive: async () => state.existingJobs, getWaiting: async () => [], getDelayed: async () => [],
};
// A real BullMQ queue, on a real Redis server, that replaces the simulated queue and Redis while set.
let liveQueue: object | null = null;
/** Routes the issue queue, and the Redis client the route takes from it, to a real queue until reset with null. */
export function useLiveQueue(live: object | null) { liveQueue = live; }
const currentQueue = () => (liveQueue ?? queue) as Record<string | symbol, unknown>;
const queueModule = await import('../../core/src/queue/taskQueue.js');
await mock.module('../../core/src/queue/taskQueue.js', {
  namedExports: {
    ...queueModule,
    issueQueue: new Proxy({}, { get: (_target, prop) => {
      const target = currentQueue();
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    } }),
    getIssueQueue: async () => currentQueue(),
  },
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
const request = mock.fn(async (route: string, options: { body?: string; issue_number?: number }) => {
  if (route.startsWith('POST') && route.endsWith('/comments') && state.commentPostError) throw state.commentPostError;
  if (route.startsWith('POST') && route.endsWith('/comments')) await state.onCommentPost?.();
  if (state.webhookFirst && options.body?.includes('<!-- propr-api-followup:')) await deliverWebhook(options.body);
  if (route.startsWith('POST') && route.endsWith('/comments')) return { data: {
    id: state.nextCommentId++, body: options.body, user: { id: APP_ACTOR_ID, login: 'propr-dev[bot]', type: 'Bot' },
    created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z',
  } };
  if (route.startsWith('GET') && route.includes('/pulls/')) return { data: { state: state.prState, head: { ref: 'acceptance' }, labels: [] } };
  if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
    await state.onIssueRead?.();
    return { data: { state: state.issueState, labels: state.issueLabels.map(name => ({ name })) } };
  }
  if (route.includes('/labels')) return { data: await labelRequest(route, options as { name?: string; labels?: string[] }) };
  if (route.endsWith('/timeline')) {
    await state.onTimelineRead?.();
    if (state.timelineReadFails) throw new Error('read ECONNRESET');
    return { data: state.timeline };
  }
  return { data: {} };
});
/**
 * Labels the issue afresh as `actorId` at GitHub's current second, recording the timeline events: a
 * label someone applies, or removes and applies again when it is already on the issue.
 */
export function applyLabels(names: string[], actorId: number) {
  const created_at = new Date(Math.floor(state.now / 1000) * 1000).toISOString();
  for (const name of names) {
    state.timeline.push({ id: state.timeline.length + 1, event: 'labeled', created_at, label: { name }, actor: { id: actorId } });
    if (!state.issueLabels.includes(name)) state.issueLabels = [...state.issueLabels, name];
  }
}
/** GitHub's label add: a label already on the issue stays as it is and publishes no event. */
function addLabels(names: string[], actorId: number) {
  applyLabels(names.filter(name => !state.issueLabels.includes(name)), actorId);
}
/** GitHub finishes a timed-out trigger add after the route has already read the labels back. */
export function landDelayedLabels() {
  addLabels(state.delayedLabels, APP_ACTOR_ID);
  state.delayedLabels = [];
}
/** The issue's label endpoints; an add is applied before its response can be lost. */
async function labelRequest(route: string, options: { name?: string; labels?: string[] }) {
  if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/labels') return state.issueLabels.map(name => ({ name }));
  if (state.labelFails) throw Object.assign(new Error('label write failed'), { status: 500 });
  if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
    state.issueLabels = state.issueLabels.filter(name => name !== options.name);
    await state.onLabelRemove?.();
  }
  if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
    await state.onLabelAdd?.();
    if (state.labelAdd === 'rejected') throw Object.assign(new Error('Validation Failed'), { status: 422 });
    if (state.labelAdd === 'delayed') {
      state.delayedLabels.push(...options.labels ?? []);
      throw new Error('Request timed out');
    }
    addLabels(options.labels ?? [], APP_ACTOR_ID);
    if (state.labelAdd === 'lost') throw new Error('socket hang up');
  }
  return {};
}
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
beforeEach(async () => {
  await database('issue_retry_request_states').delete();
  state.nextCommentId = FIRST_COMMENT_ID;
  state.startLoopFails = false; state.prState = 'open'; state.commentPostError = undefined;
  state.issueState = 'open'; state.issueLabels = ['AI', 'llm-claude-opus-5-5']; state.labelFails = false;
  state.labelAdd = 'ok'; state.timelineReadFails = false; state.delayedLabels = []; state.redisFails = false; state.onLabelAdd = undefined;
  state.consumeFails = false; state.confirmFails = false; state.recordDispatchFails = false; state.runEnqueueFails = false; state.runRecordsFail = false;
  state.onCommentPost = undefined; state.onIssueRead = undefined; state.onTimelineRead = undefined; state.onLabelRemove = undefined; state.outcomeRetries = [];
  state.onDispatchTimelineRead = undefined; state.dispatchTimelineFails = false;
  state.now = Date.parse('2026-10-15T10:00:00.700Z'); state.sleeps = []; state.processingLabels = ['AI'];
  state.timeline = [{ id: 1, event: 'labeled', created_at: '2026-10-15T09:59:00Z', label: { name: 'AI' }, actor: { id: HUMAN_ACTOR_ID } }];
  claims.clear(); hashes.clear(); state.existingJobs = []; state.queueFails = false; state.pendingReview = false; state.webhookFirst = false; state.acceptBeforeFailure = false; acceptedJobs.clear();
  for (const fn of [add, request, invalidate, startLoop, clearState, updateLabels, redis.rpush]) fn.mock.resetCalls();
});

const { closeConnection } = await import('@propr/core');
const { up: submissionsTable } = await import('../../core/src/db/migrations/20260922000000_add_task_submissions.js');
const { up: submissionIdentity } = await import('../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js');
const { up: retryRequestStates } = await import('../../core/src/db/migrations/20261015080000_create_issue_retry_request_states.js');
const { up: retryRequestRestarts } = await import('../../core/src/db/migrations/20261015090000_add_issue_retry_request_resumed_at.js');
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
await retryRequestStates(database);
await retryRequestRestarts(database);
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

export async function postFollowup(body: Record<string, unknown>, taskId = 'task-without-pr', userId = 'user-1'): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = { status: 200, json: {} as Record<string, unknown> };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: unknown) { result.json = payload as Record<string, unknown>; return this; },
  } as unknown as Response;
  await createTaskRoutes({
    db: database, processingLabels: async () => state.processingLabels,
    now: () => state.now, sleep: async ms => { state.sleeps.push(ms); state.now += ms; },
    retryLater: attempt => { state.outcomeRetries.push(attempt); },
  }).postFollowup({
    params: { taskId },
    body,
    user: { id: userId },
  } as unknown as Request, response);
  return result;
}


export { claims, redis, acceptedJobs, add, request, updateLabels, invalidate, clearState, startLoop, processCommentEvent, database, createTaskRoutes, resolveFollowupThread };
