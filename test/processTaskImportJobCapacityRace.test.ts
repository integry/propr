/**
 * A task import that passed its capacity pre-check and then lost the race at
 * the authoritative acquire (another launch took the selected member's slot
 * while it cloned) continues the same wait: on redelivery it keeps its
 * synthetic member, so the round-robin cursor does not advance again, and it
 * keeps its deferral count and place on the waiting list. Once it actually
 * runs, the wait is cleared.
 *
 * Real BullMQ worker and real Redis (the admission script and waiting lists);
 * the import's own git and GitHub steps are stubbed. Redis: a spawned
 * `redis-server` when available (PROPR_TEST_REDIS_SERVER), otherwise
 * REDIS_HOST / REDIS_PORT. With PROPR_REQUIRE_REDIS_INTEGRATION=1 an
 * unavailable Redis fails the suite instead of skipping it.
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import * as capacity from '../packages/core/src/agents/agentCapacity.js';
import { agentAdmissionKeys, prepareAdmittedAgent, resolveAgentRunAdmission, type AdmissionDocker } from '../packages/core/src/agents/agentRunAdmission.js';
import { chooseMemberWithCapacity, type CapacityCandidate } from '../packages/core/src/services/syntheticCapacitySelection.js';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const run = randomUUID().slice(0, 8);
const instanceId = `import-race-${run}`;
const queueName = `task-import-race-${run}`;
const previousEnv = { ...process.env };
let redis: Redis | undefined, server: ChildProcess | undefined;

async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
}
async function connect(host: string, port: number, attempts: number): Promise<Redis | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const client = new Redis({ host, port, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: null });
        client.on('error', () => {});
        try { await client.connect(); await client.ping(); return client; }
        catch { client.disconnect(); await delay(100); }
    }
    return undefined;
}
async function startRedis(): Promise<{ host: string; port: number } | undefined> {
    if (spawnSync(binary, ['--version']).status === 0) {
        const port = await freePort();
        server = spawn(binary, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
        redis = await connect('127.0.0.1', port, 50);
        if (redis) return { host: '127.0.0.1', port };
    }
    if (process.env.REDIS_HOST || process.env.REDIS_PORT) {
        const host = process.env.REDIS_HOST || '127.0.0.1', port = Number(process.env.REDIS_PORT || 6379);
        redis = await connect(host, port, 3);
        if (redis) return { host, port };
    }
    return undefined;
}
const endpoint = await startRedis();
const unavailable = endpoint ? undefined : `no ${binary} binary and no reachable REDIS_HOST/REDIS_PORT`;

function docker(): AdmissionDocker {
    let count = 0;
    return { daemon: async () => 'test', assertEmpty: async () => {}, create: async () => `container-${++count}`, remove: async () => {} };
}
/** A launch through the real admission script, as any other job or the API process makes. */
function launch(alias: string, options: { capacityRaceWaitMs?: number } = {}) {
    return prepareAdmittedAgent(['run', 'agent'], { agentAlias: alias, client: redis!, docker: docker(), config: resolveAgentRunAdmission()!, pollMs: 10, ...options });
}

// A synthetic `pool` agent, round robin over one member per direct agent, selecting
// with the real capacity-aware member choice. Counts every round-robin cursor advance.
const members = [
    { member: { id: 'm-local', directAgentAlias: 'local-llama', priority: 1 }, headroom: 1 },
    { member: { id: 'm-remote', directAgentAlias: 'remote-llama', priority: 1 }, headroom: 1 },
] as unknown as Array<CapacityCandidate & { member: { id: string; directAgentAlias: string } }>;
let cursorAdvances = 0;
function select(options: { pinnedMemberId?: string; deferOnCapacity?: boolean }) {
    return chooseMemberWithCapacity({
        pinnedMemberId: options.pinnedMemberId, defersOnCapacity: options.deferOnCapacity ?? false, strategy: 'round_robin',
        eligible: members, tier: members, highestPriority: 1,
        aliasCapacity: alias => capacity.agentAliasHasCapacity(alias), nextCursor: async () => cursorAdvances++,
    });
}
const RACE_BOUND_MS = 150;
const ran: string[] = [];
let raceWaitSeen: number | undefined;
const competitors = new Map<string, NonNullable<Awaited<ReturnType<typeof launch>>>>();
let competeWhileCloning = false;
const agent = {
    // As SyntheticAgent.executeTask: the pre-check's member when pinned, otherwise a fresh selection.
    executeTask: async (options: { model: string }) => {
        raceWaitSeen = capacity.agentCapacityRaceWaitMs();
        const pinned = capacity.takeAgentCapacityPin('pool', options.model);
        const { chosen } = await select({ pinnedMemberId: pinned });
        // The job's bound is 30s (asserted below); a shorter one keeps the test fast.
        const admitted = await launch(chosen.member.directAgentAlias, { capacityRaceWaitMs: RACE_BOUND_MS });
        ran.push(chosen.member.id);
        await admitted!.finish();
        return { success: true, summary: 'imported' };
    },
};
const registry = {
    ensureInitialized: async () => {},
    getAgentByAlias: (alias: string) => (alias === 'pool' ? agent : undefined),
    beginRoutingSession: (options: { pinnedMemberId?: string; deferOnCapacity?: boolean }) => ({
        select: async () => {
            const { chosen } = await select(options);
            return { physicalAgentAlias: chosen.member.directAgentAlias, physicalModel: 'model', memberId: chosen.member.id, synthetic: true };
        },
    }),
};

/** An in-memory task timeline with the state manager calls the import and the deferral use. */
const history: Array<{ state: string; reason?: string; metadata?: Record<string, unknown> }> = [];
const task = { state: 'pending', createdAt: 'c', updatedAt: 'u', correlationId: 'c', version: 1, history };
const record = async (state: string, update: { reason?: string; historyMetadata?: Record<string, unknown> } = {}) => {
    task.state = state;
    history.push({ state, reason: update.reason, metadata: update.historyMetadata });
};
const stateManager = {
    createTaskState: async () => record('pending'),
    createTaskStateIfAbsent: async () => {},
    getTaskState: async () => task,
    updateTaskState: async (_id: string, state: string, update: { reason?: string }) => record(state, update),
    updateTaskStateIfCurrent: async (_id: string, _expected: unknown, state: string, update: { reason: string; historyMetadata: Record<string, unknown> }) => record(state, update),
    updateHistoryMetadata: async (_id: string, _state: string, metadata: Record<string, unknown>) => {
        history.at(-1)!.metadata = { ...history.at(-1)!.metadata, ...metadata };
    },
    markTaskCompleted: async () => record('completed'),
    markTaskFailed: async (_id: string, error: Error) => record('failed', { reason: error.message }),
};
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

class UsageLimitError extends Error {}
await mock.module('@propr/core', {
    namedExports: {
        // The capacity helpers load these lazily from @propr/core: the real implementations.
        ...capacity,
        logger: { withCorrelation: () => quiet },
        getAuthenticatedOctokit: async () => ({ auth: async () => ({ token: 'token' }) }),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
        retryConfigs: { githubApi: {} },
        getStateManager: () => stateManager,
        TaskStates: { PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution', POST_PROCESSING: 'post_processing', CANCELLED: 'cancelled' },
        createWorktreeForIssue: async () => ({ worktreePath: '/nonexistent/import', branchName: 'import' }),
        cleanupWorktree: async () => {},
        getRepoUrl: () => 'https://github.com/owner/repo.git',
        // Other launches take the last slot of every member while the import clones, so at the
        // acquire its pinned member has no same-tier alternative and it waits there.
        ensureRepoCloned: async () => {
            if (competeWhileCloning) {
                competeWhileCloning = false;
                for (const alias of ['local-llama', 'remote-llama']) competitors.set(alias, (await launch(alias))!);
            }
            return '/nonexistent/repo';
        },
        ensureGitRepository: async () => {},
        AgentRegistry: { getInstance: () => registry },
        UsageLimitError,
        generateTaskImportPrompt: () => 'import prompt',
        handleError: () => {},
    },
});
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { handleSimpleUsageLimitError: async () => ({ status: 'usage_limit' }) } });
await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: { resolveDefaultAgentAndModel: async () => ({ resolvedAlias: 'pool', resolvedModel: 'model' }) },
});
await mock.module('../src/jobs/notificationRecap.js', { namedExports: { compactNotificationRecap: () => 'imported' } });
const { processTaskImportJob } = await import('../src/jobs/processTaskImportJob.js');
const { JOB_AGENT_CAPACITY_RACE_WAIT_MS } = await import('../src/jobs/agentCapacityDeferral.js');

before(() => {
    if (!endpoint && required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
    if (!endpoint) return;
    Object.assign(process.env, {
        REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port),
        PROPR_AGENT_RUN_LIMIT: '4', PROPR_INSTANCE_ID: instanceId, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1,remote-llama=1',
    });
    capacity.configureAgentCapacityRedis(redis);
});
after(async () => {
    capacity.configureAgentCapacityRedis(undefined);
    if (redis) {
        await redis.del(...agentAdmissionKeys(instanceId), capacity.agentCapacityWaitersKey(instanceId, 'local-llama'), capacity.agentCapacityWaitersKey(instanceId, 'remote-llama'));
        const queue = new Queue(queueName, { connection: redis });
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close();
        redis.disconnect();
    }
    server?.kill('SIGTERM');
    // The admission import graph opens the database pool; close it or this file outlives its timeout.
    await (await import('../packages/core/src/db/connection.js')).closeConnection();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
});

async function until(check: () => Promise<boolean> | boolean, label: string, timeout = 10_000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${label}`); await delay(20); }
}

test('a lost race at admission keeps the import\'s member, deferral count and waiting place until it runs', {
    skip: unavailable ? `Redis required: ${unavailable}` : false, timeout: 30_000,
}, async () => {
    assert.equal(JOB_AGENT_CAPACITY_RACE_WAIT_MS, 30_000);
    const queue = new Queue(queueName, { connection: redis! });
    const local = capacity.agentCapacityWaitersKey(instanceId, 'local-llama'), remote = capacity.agentCapacityWaitersKey(instanceId, 'remote-llama');
    const waiters = async (key: string) => (await redis!.zrange(key, 0, -1)).map(waiter => JSON.parse(waiter)[1]);
    const workerConnection = redis!.duplicate();
    let worker: Worker | undefined;
    try {
        // Deferred twice already while both members were full; a later job waits behind it for local-llama.
        const since = Date.now() - 60_000;
        const self = JSON.stringify([queueName, 'import']);
        await redis!.zadd(local, since, self, since + 1_000, JSON.stringify([queueName, 'later']));
        await redis!.zadd(remote, since, self);
        await queue.add('import', {
            repository: 'owner/repo', correlationId: 'c', taskDescription: 'Import the roadmap',
            agentCapacityDeferrals: 2, agentCapacityWaitingSince: since, agentCapacityAliases: ['local-llama', 'remote-llama'],
        }, { jobId: 'import', delay: 60_000, attempts: 3, removeOnComplete: false });
        competeWhileCloning = true;
        worker = new Worker(queueName, job => processTaskImportJob(job as never), { connection: workerConnection, concurrency: 1 });
        await (await queue.getJob('import'))!.promote();

        // The pre-check chose m-local (both members had room), then the race at its acquire was lost.
        await until(async () => (await queue.getJob('import'))!.data.agentCapacityAliases?.length === 1 && await (await queue.getJob('import'))!.isDelayed(), 'the race deferral');
        assert.equal(raceWaitSeen, JOB_AGENT_CAPACITY_RACE_WAIT_MS, 'the agent runs under the import\'s race bound');
        assert.deepEqual(ran, []);
        const deferred = (await queue.getJob('import'))!;
        assert.equal(deferred.attemptsMade, 0, 'a capacity wait consumes no attempt');
        assert.equal(deferred.data.agentCapacityDeferrals, 3, 'the wait\'s count continues');
        assert.equal(deferred.data.agentCapacityWaitingSince, since, 'still the same wait');
        assert.deepEqual(deferred.data.agentCapacityAliases, ['local-llama']);
        assert.deepEqual(deferred.data.agentCapacitySelections, [{ requestedAlias: 'pool', requestedModel: 'model', directAlias: 'local-llama', memberId: 'm-local' }]);
        assert.deepEqual(await waiters(local), ['import', 'later'], 'it keeps its place ahead of later waiters');
        assert.equal(Number(await redis!.zscore(local, self)), since);
        assert.deepEqual(await waiters(remote), [], 'no longer waits for the member it did not choose');
        assert.equal(history.filter(row => row.metadata?.agentCapacityDeferrals === 3).length, 1, 'the timeline reports the continued count');
        assert.equal(cursorAdvances, 1);

        // The other member frees first: the import no longer waits for it, so it is not woken.
        await competitors.get('remote-llama')!.finish();
        await delay(300);
        assert.equal(await (await queue.getJob('import'))!.isDelayed(), true);
        // Its own member frees: the release wakes it, and with both members free it runs on its original one.
        await competitors.get('local-llama')!.finish();
        await until(async () => (await queue.getJob('import'))!.finishedOn !== undefined, 'the admitted import');
        const done = (await queue.getJob('import'))!;
        assert.equal(done.returnvalue?.status, 'complete', String(done.failedReason ?? ''));
        assert.deepEqual(ran, ['m-local'], 'the original member runs, though the other one was free too');
        assert.equal(cursorAdvances, 1, 'the redelivery did not advance the round-robin cursor');
        assert.equal(done.attemptsMade, 1, 'the only attempt is the one that ran');

        // It proceeded: the wait and the selection are cleared, and it waits on no list.
        for (const field of ['agentCapacityDeferrals', 'agentCapacityRetryAt', 'agentCapacityWaitingSince', 'agentCapacityAliases', 'agentCapacitySelections']) {
            assert.equal(done.data[field], undefined, field);
        }
        assert.ok(!(await waiters(local)).includes('import') && !(await waiters(remote)).includes('import'));
        assert.equal(await redis!.hlen(agentAdmissionKeys(instanceId)[0]), 0, 'no holder left behind');
    } finally {
        await worker?.close(true);
        workerConnection.disconnect();
        await queue.close();
        for (const held of competitors.values()) await held.finish().catch(() => {});
    }
});
