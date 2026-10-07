/**
 * Ultrafix recovery against a real Redis server and a real BullMQ queue.
 *
 * The other recovery suites interpret the Lua scripts in JavaScript test
 * doubles and simulate the queue. This suite runs the actual scripts and
 * BullMQ job retention, so it independently checks conditional writes, claim
 * expiry and renewal, retry release, job-ID deduplication and recovery by a
 * restarted process. It is skipped when Redis is not reachable (set
 * REDIS_HOST / REDIS_PORT; CI starts one with scripts/ci-redis.sh), unless
 * PROPR_REQUIRE_REDIS_INTEGRATION=1, which CI sets so an unreachable Redis
 * fails the suite instead of silently skipping it.
 */

import { after, before, beforeEach, describe, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { withUltrafixLabelTransition } from '../packages/core/src/utils/ultrafixLabelTransition.js';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
// Keys are namespaced by owner and the queue by name, so a shared server is safe.
const RUN_ID = `${process.pid}-${Date.now()}`;
const OWNER = `itest-${RUN_ID}`;
const REPO = 'web';
const QUEUE_NAME = `ultrafix-itest-${RUN_ID}`;

function connect(): Redis {
    const client = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        connectTimeout: 250,
        enableReadyCheck: false,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        retryStrategy: () => null,
    });
    client.on('error', () => {});
    return client;
}

let redis: Redis | null = null;
let queue: Queue | null = null;
const extraClients: Redis[] = [];

// --- GitHub and CI: the only collaborators that stay simulated ---

let prLabels = ['ultrafix'];
const mockOctokitRequest = mock.fn(async (route: string) => (
    route.startsWith('GET') ? { data: { labels: prLabels.map(name => ({ name })) } } : { data: {} }
));
type CheckStatus = { count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean };
const RED: CheckStatus = { count: 2, allPassing: false, anyPending: false, anyFailed: true };
const GREEN: CheckStatus = { count: 2, allPassing: true, anyPending: false, anyFailed: false };
let ciStatus: CheckStatus = RED;
let prHead = 'red-head';

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: {},
        logger: { info: () => {} },
        loadUltrafixEscalationSettings: async () => ({ enabled: false, models: [], patience: 3, maxReasoningLevels: 2 }),
        loadModelReasoningLevel: async () => '',
        DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS: 2 * 60 * 60 * 1000,
        loadUltrafixCiWaitTimeoutMs: async () => 2 * 60 * 60 * 1000,
        resolveAgentModelReasoningLevel: () => undefined,
        resolveRuntimeModelReasoningLevel: () => null,
        resolveLlmLabel: async (model: string) => ({ agentAlias: model, model }),
        resolveConfiguredModel: async (model: string) => model,
        findPlanIssueByRepoAndPR: async () => null,
        gateAutoMergeArming: async () => ({ arm: false }),
        recoverCiFailureFollowups: async () => undefined,
        generateCorrelationId: () => randomUUID(),
        getAuthenticatedOctokit: async () => ({ request: mockOctokitRequest }),
        getIssueQueue: async () => queue,
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
        retryConfigs: { githubApi: {} },
        safeRemoveLabel: async () => undefined,
        // The real Redis lease, not a pass-through.
        withUltrafixLabelTransition,
        withRetry: async (operation: () => Promise<unknown>) => operation(),
    },
});
await mock.module('../src/github/autoMergeOperations.js', {
    namedExports: { enableAutoMerge: async () => ({ success: true }) },
});
await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { fetchAllComments: async () => [] },
});
await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: {
        getPendingReviewState: async () => ({
            latestScore: 5, reviewStatus: 'valid_with_blockers', hasPendingReview: true, unprocessedComments: [], isPartial: false,
        }),
    },
});

const {
    continueUltrafixLoop,
    resumeDeferredContinuation,
    setCheckRunDeps,
    sweepUltrafixResumeCandidates,
} = await import('../src/jobs/ultrafixLoopContinuation.js');
const {
    clearRearmRetryIfClaimHeld,
    getUltrafixAutomaticWorkEpoch,
    getUltrafixRearmRetryKey,
    getUltrafixStateKey,
    invalidateUltrafixAutomaticWork,
    loadDeferredContinuation,
    loadRearmRetry,
    loadState,
    saveDeferredContinuation,
    saveRearmRetryUnlessClaimTaken,
    saveState,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');
const {
    getUltrafixDeferredKey,
    reserveEpochAndReplaceStateIfUnchanged,
    restoreDeferredContinuationIfUnchanged,
} = await import('../src/jobs/ultrafixAutomaticWorkEpoch.js');
const { enqueueNextStep, getUltrafixStepJobId } = await import('../src/jobs/ultrafixLoopContinuationHelpers.js');
const {
    listIndexedUltrafixResumeCandidates,
    pruneUltrafixResumeCandidate,
} = await import('../src/jobs/ultrafixResumeIndex.js');
const {
    acquireResumeClaim,
    getUltrafixResumeClaimKey,
    releaseResumeClaim,
    renewResumeClaim,
} = await import('../src/jobs/ultrafixResumeClaim.js');

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

before(async () => {
    const client = connect();
    try {
        await client.connect();
        await client.ping();
    } catch (error) {
        client.disconnect();
        if (process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1') {
            throw new Error(`Redis integration tests are required but Redis at ${REDIS_HOST}:${REDIS_PORT} is unreachable: ${(error as Error).message}`);
        }
        return;
    }
    redis = client;
    queue = new Queue(QUEUE_NAME, { connection: { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null } });
    await queue.waitUntilReady();
});

after(async () => {
    if (!redis) return;
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `*${OWNER}*`, 'COUNT', '200');
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
    const indexed = (await redis.smembers('ultrafix:resume-index')).filter(member => member.includes(OWNER));
    if (indexed.length > 0) await redis.srem('ultrafix:resume-index', ...indexed);
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close();
    for (const client of extraClients) client.disconnect();
    redis.disconnect();
});

function requireRedis(t: TestContext): Redis | null {
    if (!redis) t.skip('Redis is not available for integration testing');
    return redis;
}

const prId = (pr: number) => ({ owner: OWNER, repo: REPO, pr });

async function queuedSteps(pr: number, action?: 'review' | 'fix') {
    const jobs = await queue!.getJobs(['waiting', 'active', 'delayed']);
    return jobs.filter(job => job.data.repoOwner === OWNER
        && job.data.pullRequestNumber === pr
        && (!action || job.data.commandMode === action));
}

/** Active loop whose deferred review was dropped by a CI-failure follow-up, as in production. */
async function strandLoop(client: Redis, pr: number): Promise<void> {
    const { state } = await startLoop(client, { owner: OWNER, repo: REPO, pr, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
    await saveState(client, { ...state, lastAction: 'review', reviewCount: 1, cycleCount: 0 });
    ciStatus = RED;
    const paused = await continueUltrafixLoop({
        owner: OWNER, repo: REPO, pullRequestNumber: pr, completedAction: 'fix',
        ultrafixMeta: { mode: 'ultrafix', goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: '', workEpoch: state.workEpoch },
        redisClient: client, correlatedLogger: logger as never, correlationId: 'fix', currentJobId: 'completed-fix',
    });
    assert.equal(paused.deferred, true);
    await invalidateUltrafixAutomaticWork(client, OWNER, REPO, pr);
    prHead = `follow-up-${pr}`;
    assert.equal(await loadDeferredContinuation(client, OWNER, REPO, pr), null);
}

/** A client that fails every command from the moment `kill()` is called: an abruptly terminated process. */
function mortalClient(client: Redis): { client: Redis; kill: () => void } {
    let dead = false;
    const proxy = new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => (dead
                ? Promise.reject(new Error('process terminated'))
                : (value as (...a: unknown[]) => unknown).apply(target, args));
        },
    });
    return { client: proxy, kill: () => { dead = true; } };
}

/**
 * What a fresh process finds once the dead holder's leases have expired: its
 * resume claim and, if it died inside a label transition, that lease too.
 */
async function expireDeadProcessLeases(client: Redis, pr: number): Promise<void> {
    await client.pexpire(getUltrafixResumeClaimKey(OWNER, REPO, pr), 1);
    await client.pexpire(`ultrafix:label-transition:${OWNER}:${REPO}:${pr}`, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
}

describe('Ultrafix recovery on real Redis and BullMQ', () => {
    beforeEach(() => {
        prLabels = ['ultrafix'];
        ciStatus = RED;
        prHead = 'red-head';
        setCheckRunDeps({
            areAllChecksPassing: async () => ciStatus.allPassing,
            getCurrentPRHead: async () => prHead,
            getCheckRunsStatus: async () => ciStatus,
        });
    });

    test('epoch reservation runs only against the expected epoch and exact state', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const id = prId(1);
        const { state } = await startLoop(client, { ...id, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        const raw = (await client.get(getUltrafixStateKey(OWNER, REPO, 1)))!;
        await client.set(getUltrafixDeferredKey(OWNER, REPO, 1), '{"nextAction":"review"}');

        const reserved = await reserveEpochAndReplaceStateIfUnchanged(client, id, { workEpoch: state.workEpoch, rawState: raw },
            epoch => JSON.stringify({ ...state, workEpoch: epoch }));

        assert.equal(reserved, state.workEpoch + 1);
        assert.equal(await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 1), reserved);
        assert.equal((await loadState(client, OWNER, REPO, 1))?.workEpoch, reserved);
        assert.equal(await client.exists(getUltrafixDeferredKey(OWNER, REPO, 1)), 0, 'like any invalidation it drops the deferred record');

        // The same (now stale) snapshot reserves nothing.
        assert.equal(await reserveEpochAndReplaceStateIfUnchanged(client, id, { workEpoch: state.workEpoch, rawState: raw }, () => 'x'), null);
        const current = (await client.get(getUltrafixStateKey(OWNER, REPO, 1)))!;
        assert.equal(await reserveEpochAndReplaceStateIfUnchanged(client, id, { workEpoch: reserved!, rawState: `${current} ` }, () => 'x'), null);
        assert.equal(await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 1), reserved, 'a rejected attempt reserves nothing');
    });

    test('a claimed deferred step is restored only into an unchanged loop', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const id = prId(2);
        const { state } = await startLoop(client, { ...id, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        const raw = (await client.get(getUltrafixStateKey(OWNER, REPO, 2)))!;
        const expected = { workEpoch: state.workEpoch, rawState: raw };

        assert.equal(await restoreDeferredContinuationIfUnchanged(client, id, expected, '{"step":"a"}'), true);
        assert.equal(await restoreDeferredContinuationIfUnchanged(client, id, expected, '{"step":"b"}'), false, 'never over a newer record');
        assert.equal(await client.get(getUltrafixDeferredKey(OWNER, REPO, 2)), '{"step":"a"}');

        await client.del(getUltrafixDeferredKey(OWNER, REPO, 2));
        await saveState(client, { ...state, reviewCount: 2 });
        assert.equal(await restoreDeferredContinuationIfUnchanged(client, id, expected, '{"step":"c"}'), false, 'not after the loop advanced');
        await invalidateUltrafixAutomaticWork(client, OWNER, REPO, 2);
        const advanced = (await client.get(getUltrafixStateKey(OWNER, REPO, 2)))!;
        assert.equal(await restoreDeferredContinuationIfUnchanged(client, id, { workEpoch: state.workEpoch, rawState: advanced }, '{"step":"d"}'), false, 'not into a superseded epoch');
        assert.equal(await client.exists(getUltrafixDeferredKey(OWNER, REPO, 2)), 0);
    });

    test('a deferred record is published only under the current epoch', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const deferred = { owner: OWNER, repo: REPO, pr: 3, nextAction: 'review' as const, savedAt: new Date().toISOString(), reason: 'checks_not_passing' };
        assert.equal(await saveDeferredContinuation(client, { ...deferred, workEpoch: 0 }), true);
        await invalidateUltrafixAutomaticWork(client, OWNER, REPO, 3);
        assert.equal(await loadDeferredContinuation(client, OWNER, REPO, 3), null, 'invalidation drops it');
        assert.equal(await saveDeferredContinuation(client, { ...deferred, workEpoch: 0 }), false, 'a stale epoch cannot publish');
        assert.equal(await saveDeferredContinuation(client, { ...deferred, workEpoch: 1 }), true);
    });

    test('the resume claim expires, renews only for its holder and is released only by it', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const id = prId(4);
        assert.equal(await acquireResumeClaim(client, id, 'first', 80), true);
        assert.equal(await acquireResumeClaim(client, id, 'second', 80), false, 'held');
        assert.equal(await renewResumeClaim(client, id, 'first', 80), true);
        assert.equal(await renewResumeClaim(client, id, 'second', 80), false);
        assert.equal(await releaseResumeClaim(client, id, 'second'), false);

        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await renewResumeClaim(client, id, 'first', 80), false, 'an expired claim cannot be renewed back');
        assert.equal(await acquireResumeClaim(client, id, 'second', 1_000), true, 'expiry frees the claim');
        assert.equal(await releaseResumeClaim(client, id, 'first'), false, 'the old holder cannot release its successor');
        assert.equal(await releaseResumeClaim(client, id, 'second'), true);
    });

    test('a retry obligation is released only by the claim holder while its epoch is current', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const id = prId(5);
        const claimKey = getUltrafixResumeClaimKey(OWNER, REPO, 5);
        const retry = { ...id, workEpoch: 0, reason: 'test', savedAt: new Date().toISOString() };
        await acquireResumeClaim(client, id, 'holder', 5_000);

        assert.equal(await saveRearmRetryUnlessClaimTaken(client, retry, { key: claimKey, token: 'other' }), false, 'another trigger holds the claim');
        assert.equal(await saveRearmRetryUnlessClaimTaken(client, retry, { key: claimKey, token: 'holder' }), true);
        assert.ok(await client.ttl(getUltrafixRearmRetryKey(OWNER, REPO, 5)) > 0, 'the obligation carries its TTL');

        assert.equal(await clearRearmRetryIfClaimHeld(client, id, { key: claimKey, token: 'other' }), 'claim_not_held');
        await invalidateUltrafixAutomaticWork(client, OWNER, REPO, 5);
        assert.equal(await clearRearmRetryIfClaimHeld(client, id, { key: claimKey, token: 'holder' }, { workEpoch: 0 }), 'superseded');
        assert.ok(await loadRearmRetry(client, OWNER, REPO, 5), 'kept for the sweep');
        const stale = await client.get(getUltrafixRearmRetryKey(OWNER, REPO, 5));
        await saveRearmRetryUnlessClaimTaken(client, { ...retry, reason: 'newer' }, { key: claimKey, token: 'holder' });
        assert.equal(await clearRearmRetryIfClaimHeld(client, id, { key: claimKey, token: 'holder' }, { raw: stale! }), 'retry_changed');
        assert.equal((await loadRearmRetry(client, OWNER, REPO, 5))?.reason, 'newer', 'a newer obligation survives');
        assert.equal(await clearRearmRetryIfClaimHeld(client, id, { key: claimKey, token: 'holder' }, { workEpoch: 1 }), 'cleared');
        assert.equal(await loadRearmRetry(client, OWNER, REPO, 5), null);

        await releaseResumeClaim(client, id, 'holder');
        assert.equal(await saveRearmRetryUnlessClaimTaken(client, retry, { key: claimKey, token: 'expired' }), true, 'a claim with no new holder still records it');
    });

    test('the resume index is pruned only while the PR has neither record', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const id = prId(11);
        const ours = async () => (await listIndexedUltrafixResumeCandidates(client))!.filter(ref => ref.owner === OWNER && ref.pr === 11);
        await saveDeferredContinuation(client, { ...id, nextAction: 'review', savedAt: new Date().toISOString(), reason: 'test', workEpoch: 0 });
        assert.equal((await ours()).length, 1, 'a deferral indexes its PR');

        assert.equal(await pruneUltrafixResumeCandidate(client, id), false, 'kept while the deferred record exists');
        await client.del(getUltrafixDeferredKey(OWNER, REPO, 11));
        assert.equal(await pruneUltrafixResumeCandidate(client, id), true);
        assert.equal((await ours()).length, 0);
    });

    test('BullMQ retains a step\'s job ID: a pending duplicate is skipped, a finished attempt is replaced', async t => {
        const client = requireRedis(t);
        if (!client) return;
        const params = {
            owner: OWNER, repo: REPO, pullRequestNumber: 6, completedAction: 'fix' as const,
            ultrafixMeta: { mode: 'ultrafix' as const, goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: '', workEpoch: 3 },
            redisClient: client, correlatedLogger: logger as never, correlationId: 'enqueue',
        };
        const jobId = getUltrafixStepJobId(OWNER, REPO, 6, { action: 'review', workEpoch: 3, stepNumber: 2 });

        assert.equal(await enqueueNextStep(params, 'review', 60_000, 2), true);
        assert.equal(await enqueueNextStep(params, 'review', 60_000, 2), false, 'already pending');
        assert.equal(await (await queue!.getJob(jobId))?.getState(), 'delayed');
        assert.equal((await queuedSteps(6)).length, 1);

        // The attempt runs and finishes without recording its action (e.g. it crashed in its continuation).
        const job = await queue!.getJob(jobId);
        await job!.promote();
        const worker = new Worker(QUEUE_NAME, async () => 'done', { connection: { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }, autorun: true });
        try {
            for (let i = 0; i < 100 && await (await queue!.getJob(jobId))?.getState() !== 'completed'; i++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        } finally {
            await worker.close();
        }
        assert.equal(await (await queue!.getJob(jobId))?.getState(), 'completed', 'BullMQ retains the finished job');

        assert.equal(await enqueueNextStep(params, 'review', 60_000, 2), true, 'the retained finished attempt does not block the retry');
        assert.equal(await (await queue!.getJob(jobId))?.getState(), 'delayed');
    });

    test('concurrent green triggers recover a stranded loop with exactly one queued review', async t => {
        const client = requireRedis(t);
        if (!client) return;
        await strandLoop(client, 7);
        const fenced = await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 7);
        ciStatus = GREEN;

        // Separate connections, as separate webhook deliveries and the poller would use.
        const triggers = [client, connect(), connect()];
        extraClients.push(triggers[1], triggers[2]);
        await Promise.all(triggers.slice(1).map(other => other.connect()));
        const results = await Promise.all(triggers.map(trigger => resumeDeferredContinuation(prId(7), trigger, logger as never)));

        assert.equal(results.filter(result => result.continued).length, 1);
        const reviews = await queuedSteps(7, 'review');
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].data.ultrafixMeta.workEpoch, fenced + 1);
        assert.equal(await loadRearmRetry(client, OWNER, REPO, 7), null);
        assert.equal(await client.exists(getUltrafixResumeClaimKey(OWNER, REPO, 7)), 0, 'the claim was released');
    });

    test('a process terminated after the re-arm takes ownership is recovered by a restarted sweep', async t => {
        const client = requireRedis(t);
        if (!client) return;
        await strandLoop(client, 8);
        ciStatus = GREEN;
        const mortal = mortalClient(client);
        const evaluate = client.eval.bind(client);
        // Terminate right after the epoch reservation commits, before the review is queued.
        const spy = mock.method(client, 'eval', async (...args: Parameters<Redis['eval']>) => {
            const result = await evaluate(...args);
            if (String(args[0]).includes('-- reserve epoch and replace state') && Number(result) > 0) mortal.kill();
            return result;
        });
        try {
            await assert.rejects(resumeDeferredContinuation(prId(8), mortal.client, logger as never), /process terminated/);
        } finally {
            spy.mock.restore();
        }
        assert.equal((await queuedSteps(8)).length, 0, 'nothing reached the queue');
        assert.ok(await loadRearmRetry(client, OWNER, REPO, 8), 'the obligation was persisted before ownership moved');

        await expireDeadProcessLeases(client, 8);
        const restarted = connect();
        extraClients.push(restarted);
        await restarted.connect();
        const outcomes = (await sweepUltrafixResumeCandidates(restarted, () => logger as never))
            .filter(outcome => outcome.prId.owner === OWNER && outcome.prId.pr === 8);

        assert.deepEqual(outcomes.map(outcome => outcome.result.reason), ['stranded_loop_rearmed']);
        assert.equal((await queuedSteps(8, 'review')).length, 1);
        assert.equal(await loadRearmRetry(restarted, OWNER, REPO, 8), null, 'released once the review is queued');
    });

    test('a process terminated right after claiming a deferred record is recovered by a restarted sweep', async t => {
        const client = requireRedis(t);
        if (!client) return;
        await strandLoop(client, 9);
        // Still red: the recovery becomes a deferral under its own epoch.
        const deferral = await resumeDeferredContinuation(prId(9), client, logger as never);
        assert.match(deferral.reason, /^rearm_deferred/);
        assert.ok(await loadDeferredContinuation(client, OWNER, REPO, 9));

        ciStatus = GREEN;
        const mortal = mortalClient(client);
        const evaluate = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const spy = mock.method(client, 'eval', async (...args: unknown[]) => {
            const value = await evaluate(...args);
            // The compare-and-delete that claims the deferred record.
            if (args[2] === getUltrafixDeferredKey(OWNER, REPO, 9) && Number(value) === 1) mortal.kill();
            return value;
        });
        try {
            await assert.rejects(resumeDeferredContinuation(prId(9), mortal.client, logger as never), /process terminated/);
        } finally {
            spy.mock.restore();
        }
        assert.equal(await loadDeferredContinuation(client, OWNER, REPO, 9), null, 'the claim removed the record');
        const retry = await loadRearmRetry(client, OWNER, REPO, 9);
        assert.ok(retry, 'the obligation was persisted before the claim');
        assert.equal(retry.claimedStep?.deferred.nextAction, 'review', 'it carries the claimed step');
        const epoch = await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 9);

        await expireDeadProcessLeases(client, 9);
        const outcomes = (await sweepUltrafixResumeCandidates(client, () => logger as never))
            .filter(outcome => outcome.prId.owner === OWNER && outcome.prId.pr === 9);

        // The claimed step itself resumes; no new epoch is reserved for it.
        assert.deepEqual(outcomes.map(outcome => outcome.result.reason), ['deferred_resumed']);
        assert.equal(await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 9), epoch);
        assert.equal((await queuedSteps(9, 'review')).length, 1);
        assert.equal(await loadRearmRetry(client, OWNER, REPO, 9), null);
    });

    test('a healthy loop owned by its current epoch is not resumed or scanned', async t => {
        const client = requireRedis(t);
        if (!client) return;
        await startLoop(client, { owner: OWNER, repo: REPO, pr: 10, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        ciStatus = GREEN;
        mockOctokitRequest.mock.resetCalls();
        const getJobs = mock.method(queue!, 'getJobs');
        try {
            const result = await resumeDeferredContinuation(prId(10), client, logger as never);
            assert.equal(result.reason, 'no_deferred_continuation');
            assert.equal(getJobs.mock.callCount(), 0);
        } finally {
            getJobs.mock.restore();
        }
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(await getUltrafixAutomaticWorkEpoch(client, OWNER, REPO, 10), 0);
    });
});
