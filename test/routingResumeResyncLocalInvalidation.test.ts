import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';

// A repository that lost installation access (404) or left the configuration
// can never be checked against GitHub again, so its durable task intents are
// invalidated locally. These tests run the real invalidation against in-memory
// worker state, queue and Redis, with every GitHub call failing.

after(async () => {
    await closeConnection();
});

/**
 * The modules under test must load after the mocks, and so does the harness
 * (its coordinator reaches them through the webhook handler), so every mocked
 * module keeps its real exports and overrides only what these tests fake.
 */
async function mockModule(specifier: string, overrides: Record<string, unknown>): Promise<void> {
    const real = await import(specifier) as Record<string, unknown>;
    await mock.module(specifier, { namedExports: { ...real, ...overrides } });
}

type FakeState = { taskId: string; state: string; issueRef: Record<string, unknown>; history: Array<{ state: string; metadata?: unknown }>; terminalReason?: string };
type FakeJob = { id: string; name: string; status: string; data: Record<string, unknown>; remove: () => Promise<void> };

const states = new Map<string, FakeState>();
const jobs: FakeJob[] = [];
const redisValues = new Map<string, string>();
const redisSets = new Map<string, Set<string>>();
const githubCalls: string[] = [];
let failMarkCancelled = false;
let failQueueScan = false;
/** A task-state record that exists but cannot be read: the real scan skips it unless strict. */
let unreadableTask = false;
let unreadableAfterCancel = false;
const strictScans: boolean[] = [];

const redis = {
    get: async (key: string) => (key.startsWith('worker:state:') ? (states.has(key.slice(13)) ? JSON.stringify(states.get(key.slice(13))) : null) : redisValues.get(key) ?? null),
    set: async (key: string, value: string) => { redisValues.set(key, value); return 'OK'; },
    rpush: async () => 1,
    del: async () => 1,
    sadd: async (key: string, member: string) => { const set = redisSets.get(key) ?? new Set<string>(); redisSets.set(key, set.add(member)); return 1; },
    srem: async (key: string, member: string) => Number(redisSets.get(key)?.delete(member) ?? 0),
    smembers: async (key: string) => [...redisSets.get(key) ?? []],
};
const terminal = (state: FakeState) => ['completed', 'failed', 'cancelled'].includes(state.state);
const manager = {
    getTaskState: async (id: string) => states.get(id) ?? null,
    scanNonTerminalTasks: async (_cursor?: string, _count?: number, options: { strict?: boolean } = {}) => {
        strictScans.push(!!options.strict);
        if (unreadableTask && options.strict) throw new Error('Unreadable task state worker:state:hidden: READONLY');
        return { tasks: [...states.values()].filter(state => !terminal(state)), nextCursor: '0' };
    },
    createTaskStateIfAbsent: async (id: string, issueRef: Record<string, unknown>) => {
        if (!states.has(id)) states.set(id, { taskId: id, state: 'pending', issueRef, history: [{ state: 'pending' }] });
        return states.get(id);
    },
    markTaskCancelled: async (id: string, _by: string, metadata: { historyMetadata?: { cancellationReason?: string } }) => {
        if (failMarkCancelled) throw new Error('state store unavailable');
        if (unreadableAfterCancel) unreadableTask = true;
        const state = states.get(id);
        if (!state) throw new Error('missing state');
        state.state = 'cancelled';
        state.terminalReason = metadata.historyMetadata?.cancellationReason;
        state.history.push({ state: 'cancelled', metadata });
        return state;
    },
};
const queue = {
    getJobs: async (statuses: string[]) => {
        if (failQueueScan) throw new Error('queue unavailable');
        return jobs.filter(job => statuses.includes(job.status));
    },
};

await mockModule('../packages/core/src/utils/workerStateManager.js', { getStateManager: () => manager });
await mockModule('../packages/core/src/queue/taskQueue.js', { getIssueQueue: async () => queue });
await mockModule('../packages/core/src/db/connection.js', {
    db: () => { const query: Record<string, unknown> = { select: () => query, where: () => query, first: async () => undefined }; return query; },
});
await mockModule('../packages/core/src/auth/githubAuth.js', {
    getAuthenticatedOctokit: async () => ({
        request: async (endpoint: string) => { githubCalls.push(endpoint); throw Object.assign(new Error('Not Found'), { status: 404 }); },
    }),
});
await mockModule('../packages/core/src/config/configManager.js', { loadPrimaryProcessingLabels: async () => ['AI'] });
await mockModule('../packages/core/src/claude/docker/dockerExecutor.js', { stopDockerContainer: async () => ({ success: true }) });
const clearedLoops: number[] = [];
await mockModule('../packages/core/src/webhook/checkRunHelpers.js', {
    getUltrafixStateRedis: () => redis,
    clearUltrafixLoopState: async (_owner: string, _repo: string, pr: number) => { clearedLoops.push(pr); },
});

const { invalidateRepositoryIntents, listIntentRepositories } = await import('../packages/core/src/services/repositoryIntentInvalidation.js');
const { reconcileTaskIntents } = await import('../packages/core/src/services/taskIntent.js');
const { WITHDRAWAL_CLEANUP_KEY } = await import('../packages/core/src/services/withdrawalCleanup.js');
const { runResyncGeneration } = await import('./helpers/resumeResyncHarness.js');

function addJob(id: string, data: Record<string, unknown>, name = 'processGitHubIssue', status = 'waiting') {
    const job: FakeJob = { id, name, status, data, remove: async () => { jobs.splice(jobs.indexOf(job), 1); } };
    jobs.push(job);
}

function seed() {
    // Queued issue work, a PR follow-up in flight, and a retained closure cleanup in acme/gone.
    addJob('issue-acme-gone-7', { repoOwner: 'acme', repoName: 'gone', number: 7, triggeringLabel: 'AI', correlationId: 'c-7' });
    states.set('pr-task-12', {
        taskId: 'pr-task-12', state: 'processing', history: [{ state: 'processing' }],
        issueRef: { repoOwner: 'acme', repoName: 'gone', number: 12, type: 'pr-comment', pullRequestNumber: 12 },
    });
    void redis.sadd(WITHDRAWAL_CLEANUP_KEY, JSON.stringify({ repoOwner: 'acme', repoName: 'gone', number: 3, id: 'x' }));
    // Unrelated work in a healthy repository must be left alone.
    addJob('issue-acme-api-1', { repoOwner: 'acme', repoName: 'api', number: 1, triggeringLabel: 'AI', correlationId: 'c-1' });
}

beforeEach(() => {
    states.clear(); jobs.length = 0; redisValues.clear(); redisSets.clear(); githubCalls.length = 0; clearedLoops.length = 0;
    failMarkCancelled = false; failQueueScan = false; unreadableTask = false; unreadableAfterCancel = false; strictScans.length = 0;
});

test('referenced repositories include tasks, queued jobs and retained withdrawal cleanups', async () => {
    seed();
    void redis.sadd(WITHDRAWAL_CLEANUP_KEY, JSON.stringify({ repoOwner: 'acme', repoName: 'retained-only', number: 4, id: 'y' }));
    assert.deepEqual((await listIntentRepositories(redis as never)).sort(), ['acme/api', 'acme/gone', 'acme/retained-only']);
    failQueueScan = true;
    await assert.rejects(listIntentRepositories(redis as never), /queue unavailable/, 'a partial scan is never returned');
});

test('local invalidation cancels every nonterminal intent of the repository without GitHub', async () => {
    seed();
    const result = await invalidateRepositoryIntents(redis as never, 'acme/gone');
    assert.deepEqual(result, { cancelled: 2, retainedCleanups: 1 });
    assert.deepEqual(githubCalls, [], 'no GitHub call is needed for an inaccessible repository');
    assert.equal(states.get('pr-task-12')?.state, 'cancelled');
    assert.equal(states.get('pr-task-12')?.terminalReason, 'cancelled_repository_unavailable');
    assert.equal(states.get('issue-acme-gone-7-intent-c-7')?.state, 'cancelled');
    assert.deepEqual(jobs.map(job => job.id), ['issue-acme-api-1'], 'other repositories keep their work');
    assert.deepEqual(clearedLoops, [12]);
});

test('an unrecorded cancellation fails local invalidation instead of reporting convergence', async () => {
    seed();
    failMarkCancelled = true;
    await assert.rejects(invalidateRepositoryIntents(redis as never, 'acme/gone'), /Could not record 2 repository intent cancellation/);
});

test('after a 404 access loss task_intents still invalidates local work and no resync_complete is sent until it succeeds', async () => {
    seed();
    failMarkCancelled = true;
    const failing = await runResyncGeneration({
        repositories: ['acme/gone'],
        steps: {
            repository_access: async () => ({ access: 'inaccessible' }),
            task_intents: async ctx => { await invalidateRepositoryIntents(redis as never, ctx.repository); },
        },
    });
    assert.equal(failing.state, 'failed');
    assert.deepEqual(failing.completions, []);
    assert.deepEqual(failing.contexts.map(ctx => `${ctx.family}:${ctx.access}`), ['repository_access:null', 'task_intents:inaccessible']);

    failMarkCancelled = false;
    const ok = await runResyncGeneration({
        repositories: ['acme/gone'],
        steps: {
            repository_access: async () => ({ access: 'inaccessible' }),
            task_intents: async ctx => { await invalidateRepositoryIntents(redis as never, ctx.repository); },
        },
    });
    assert.equal(ok.state, 'completed');
    assert.deepEqual(ok.contexts.map(ctx => ctx.family), ['repository_access', 'task_intents'], 'GitHub-dependent families are inapplicable');
    assert.deepEqual((ok.completions[0].evidence as { repositories: unknown }).repositories, { total: 1, reconciled: 0, inaccessible: 1, unconfigured: 0 });
    assert.equal(states.get('pr-task-12')?.state, 'cancelled');
});

test('a repository removed from configuration is still reconciled from its referenced durable work', async () => {
    seed();
    const result = await runResyncGeneration({
        repositories: ['acme/api'],
        referenced: await listIntentRepositories(redis as never),
        steps: {
            task_intents: async ctx => { if (!ctx.configured) await invalidateRepositoryIntents(redis as never, ctx.repository); },
        },
    });
    assert.equal(result.state, 'completed');
    const gone = result.contexts.filter(ctx => ctx.repository === 'acme/gone');
    assert.deepEqual(gone.map(ctx => `${ctx.family}:${ctx.configured}`), ['repository_access:false', 'task_intents:false']);
    assert.deepEqual((result.completions[0].evidence as { repositories: unknown }).repositories, { total: 2, reconciled: 1, inaccessible: 0, unconfigured: 1 });
    assert.equal(states.get('pr-task-12')?.state, 'cancelled');
});

test('an unreadable task state fails repository discovery and local invalidation instead of reading as absent', async () => {
    seed();
    unreadableTask = true;
    await assert.rejects(listIntentRepositories(redis as never), /Unreadable task state/, 'discovery never omits unreadable work');
    await assert.rejects(invalidateRepositoryIntents(redis as never, 'acme/gone'), /Unreadable task state/, 'candidate collection is strict');
    assert.equal(states.get('pr-task-12')?.state, 'processing', 'nothing is cancelled from a partial candidate set');
    assert.ok(strictScans.length > 0 && strictScans.every(Boolean), 'every resync task-state scan is strict');
});

test('an unreadable task state during cancellation verification fails invalidation', async () => {
    seed();
    unreadableAfterCancel = true;
    await assert.rejects(invalidateRepositoryIntents(redis as never, 'acme/gone'), /Unreadable task state/,
        'remaining-work verification cannot report convergence without reading every state');
});

test('strict task-intent reconciliation fails on an unreadable task state; ordinary polling stays tolerant', async () => {
    unreadableTask = true;
    await assert.rejects(reconcileTaskIntents(redis as never, ['acme/api'], { strict: true }), /Unreadable task state/);
    strictScans.length = 0;
    await reconcileTaskIntents(redis as never, ['acme/api']);
    assert.deepEqual(strictScans, [false], 'ordinary recovery callers keep the tolerant scan');
});
