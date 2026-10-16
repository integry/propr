import { after, test } from 'node:test';
import assert from 'node:assert';
import { RoutingResumeResyncCoordinator } from '../packages/core/src/intake/routingResumeResyncCoordinator.js';
import { InMemoryResumeResyncStore, type ResumeResyncRecord } from '../packages/core/src/intake/routingResumeResyncStore.js';
import { runResyncAttempt, type ResumeResyncReconciler, type ResyncRepositoryStepContext } from '../packages/core/src/intake/routingResumeResyncRun.js';
import { scanNonTerminalTaskStates } from '../packages/core/src/utils/workerStateScan.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

/**
 * Completeness of a resume resync: an attempt never settles (or lets a retry
 * start) while a repository worker still runs, a strict task-state scan never
 * reads unreadable work as absent, and a superseding generation still covers
 * the unfinished gaps of the generations it replaced.
 */

after(async () => {
    await closeConnection();
});

const INSTALLATION = 42;
const FAMILIES = ['repository_access', 'task_intents', 'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'] as const;

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

class HookedStore extends InMemoryResumeResyncStore {
    hook: ((record: ResumeResyncRecord) => void) | null = null;

    override async save(record: ResumeResyncRecord): Promise<void> {
        this.hook?.(record);
        await super.save(record);
    }
}

function frame(type: 'resume_pending' | 'resync_required', resumeGeneration: number, gapStartedAt: string) {
    const value: Record<string, unknown> = { type, version: 1, installationId: INSTALLATION, routingGeneration: 1, resumeGeneration, gapStartedAt };
    if (type === 'resync_required') value.gapEndedAt = '2026-10-13T00:00:00.000Z';
    return value;
}

function harness(reconciler: ResumeResyncReconciler, store = new HookedStore(), stopTimeoutMs = 10_000) {
    const coordinator = new RoutingResumeResyncCoordinator({
        installationId: INSTALLATION, store, reconciler, concurrency: 2, retryBaseDelayMs: 5, retryMaxDelayMs: 10, stopTimeoutMs,
    });
    const completions: Record<string, unknown>[] = [];
    coordinator.attach(item => { if (item.type === 'resync_complete') completions.push(item); return true; });
    const deliver = (value: Record<string, unknown>) => coordinator.handleFrame(value, Buffer.byteLength(JSON.stringify(value)));
    return { coordinator, store, completions, deliver };
}

// --- F3: repository workers drain before an attempt settles -----------------

test('a failed persist on one repository waits for the other worker before the attempt settles', async () => {
    const heldStep = deferred();
    let stepSettled = false;
    const record: ResumeResyncRecord = {
        installationId: INSTALLATION, routingGeneration: 1, resumeGeneration: 1, state: 'reconciling',
        gapStartedAt: '2026-10-10T00:00:00.000Z', recoveryStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
        attempts: 1, startedAt: null, lastAttemptAt: null, nextRetryAt: null, lastError: null,
        repositories: {}, installationFamilies: [], consecutiveFailures: 0, completion: null, acknowledgedAt: null, updatedAt: '2026-10-12T00:00:00.000Z',
    };
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => ['acme/a', 'acme/b'],
        listReferencedRepositories: () => [],
        repositorySteps: [{
            family: 'repository_access',
            run: async ctx => {
                if (ctx.repository === 'acme/a') await heldStep.promise.finally(() => { stepSettled = true; });
                return { access: 'accessible' as const };
            },
        }],
        installationSteps: [],
    };
    const persist = async () => {
        if (record.repositories['acme/b']?.completedFamilies.includes('repository_access')) throw new Error('disk full');
    };
    let settled = false;
    const attempt = runResyncAttempt({
        record, reconciler, persist, now: Date.now, concurrency: 2, correlationId: 'test', signal: new AbortController().signal,
    }).finally(() => { settled = true; });
    await tick();
    assert.equal(settled, false, 'the attempt stays open while acme/a is still reconciling');
    heldStep.reject(new Error('GitHub 502'));
    await assert.rejects(attempt, /disk full/, 'the first failure is preserved after the drain');
    assert.equal(stepSettled, true);
    assert.equal(record.repositories['acme/a'].status, 'failed', "acme/a's late failure landed before the attempt settled");
});

test('a retry never overlaps a still-running worker, so a late failure cannot corrupt the persisted completion', async () => {
    const heldStep = deferred();
    let aCalls = 0;
    let concurrentA = 0;
    let maxConcurrentA = 0;
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => ['acme/a', 'acme/b'],
        listReferencedRepositories: () => [],
        repositorySteps: FAMILIES.map(family => ({
            family,
            run: async (ctx: ResyncRepositoryStepContext) => {
                if (ctx.repository !== 'acme/a' || family !== 'labelled_issues') return;
                aCalls += 1;
                concurrentA += 1;
                maxConcurrentA = Math.max(maxConcurrentA, concurrentA);
                try {
                    if (aCalls === 1) await heldStep.promise;
                } finally {
                    concurrentA -= 1;
                }
            },
        })),
        installationSteps: [{ family: 'ultrafix_continuations', run: async () => undefined }],
    };
    const ctx = harness(reconciler);
    let failedOnce = false;
    ctx.store.hook = record => {
        // B's first persist after labelled_issues rejects while A's step is still held.
        if (!failedOnce && record.repositories['acme/b']?.completedFamilies.includes('labelled_issues')) {
            failedOnce = true;
            throw new Error('disk full');
        }
    };
    await ctx.coordinator.start();
    await ctx.deliver(frame('resync_required', 1, '2026-10-10T00:00:00.000Z'));
    await waitFor(() => failedOnce, 'the failing persist');
    await tick();
    assert.equal(aCalls, 1, 'no retry starts while acme/a is still reconciling');
    assert.equal(ctx.coordinator.getStatus().running, true, 'the attempt keeps its run slot');
    assert.deepEqual(ctx.completions, []);

    heldStep.reject(new Error('GitHub 502'));
    await waitFor(() => ctx.completions.length === 1, 'the retried completion');
    assert.equal(maxConcurrentA, 1);
    const persisted = await ctx.store.load(INSTALLATION); // the codec re-validates the completion digest
    assert.equal(persisted?.state, 'completed');
    assert.equal(persisted?.repositories['acme/a'].status, 'reconciled');
    assert.equal(ctx.completions[0].completionId, persisted?.completion?.completionId);
    await ctx.coordinator.stop();
});

test('an attempt that ignores abort keeps the run slot across stop and restart', async () => {
    const heldStep = deferred();
    let calls = 0;
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => ['acme/a'],
        listReferencedRepositories: () => [],
        repositorySteps: FAMILIES.map(family => ({
            family,
            run: async () => {
                if (family !== 'labelled_issues') return;
                calls += 1;
                if (calls === 1) await heldStep.promise; // ignores the abort signal
            },
        })),
        installationSteps: [],
    };
    const ctx = harness(reconciler, new HookedStore(), 10);
    await ctx.coordinator.start();
    await ctx.deliver(frame('resync_required', 1, '2026-10-10T00:00:00.000Z'));
    await waitFor(() => calls === 1, 'the held step');
    await ctx.coordinator.stop(); // returns after the bounded deadline
    await ctx.coordinator.start();
    ctx.coordinator.attach(item => { if (item.type === 'resync_complete') ctx.completions.push(item); return true; });
    await tick();
    assert.equal(calls, 1, 'the restarted coordinator does not overlap the attempt still running');

    heldStep.resolve();
    await waitFor(() => ctx.completions.length === 1, 'the resumed completion');
    assert.equal(calls, 1, 'the drained attempt persisted labelled_issues, so the resumed run skips it');
    assert.equal((await ctx.store.load(INSTALLATION))?.state, 'completed');
    await ctx.coordinator.stop();
});

// --- F4: strict task-state scans --------------------------------------------

function fakeScanRedis(values: Record<string, string | null>, results?: Array<[Error | null, unknown]> | null) {
    const keys = Object.keys(values);
    return {
        scan: async () => ['0', keys] as [string, string[]],
        pipeline: () => ({
            get: () => undefined,
            exec: async () => results === undefined ? keys.map(key => [null, values[key]] as [Error | null, unknown]) : results,
        }),
    };
}

const PREFIX = 'worker:state:';
const task = (taskId: string, state = 'processing') => JSON.stringify({ taskId, state, issueRef: { repoOwner: 'acme', repoName: 'api', number: 1 } });

test('a strict task-state scan fails on any extant record it cannot read; the tolerant scan skips it', async () => {
    const cases: Array<[string, ReturnType<typeof fakeScanRedis>]> = [
        ['a per-command read error', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: task('t2') }, [[null, task('t1')], [new Error('READONLY'), null]])],
        ['a missing pipeline result', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: task('t2') }, [[null, task('t1')]])],
        ['no pipeline results at all', fakeScanRedis({ [`${PREFIX}t1`]: task('t1') }, null)],
        ['malformed JSON', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: '{' })],
        ['a non-object record', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: 'null' })],
        ['a record under a mismatched key', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: task('other') })],
        ['an unknown state', fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}t2`]: task('t2', 'paused') })],
    ];
    for (const [label, redis] of cases) {
        await assert.rejects(scanNonTerminalTaskStates(redis as never, PREFIX, '0', { strict: true }), /Unreadable task state/, label);
        const tolerant = await scanNonTerminalTaskStates(redis as never, PREFIX, '0');
        assert.deepEqual(tolerant.tasks.map(item => item.taskId).filter(id => id === 't1'), label === 'no pipeline results at all' ? [] : ['t1'], label);
    }
});

test('a strict scan still treats a key deleted since SCAN, and terminal records, as absent', async () => {
    const redis = fakeScanRedis({ [`${PREFIX}t1`]: task('t1'), [`${PREFIX}gone`]: null, [`${PREFIX}done`]: task('done', 'completed') });
    const page = await scanNonTerminalTaskStates(redis as never, PREFIX, '0', { strict: true });
    assert.deepEqual(page.tasks.map(item => item.taskId), ['t1']);
});

// --- F5: superseded unfinished gaps stay covered ----------------------------

function recordingReconciler(failComments: () => boolean) {
    const contexts: ResyncRepositoryStepContext[] = [];
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => ['acme/api'],
        listReferencedRepositories: () => [],
        repositorySteps: FAMILIES.map(family => ({
            family,
            run: async (ctx: ResyncRepositoryStepContext) => {
                if (family !== 'pull_request_comments') return;
                contexts.push(ctx);
                if (failComments()) throw new Error('GitHub 502');
            },
        })),
        installationSteps: [],
    };
    return { reconciler, contexts };
}

test('a generation superseding an unfinished one discovers comments from the earliest unreconciled gap start', async () => {
    let fail = true;
    const { reconciler, contexts } = recordingReconciler(() => fail);
    const store = new HookedStore();
    const first = harness(reconciler, store);
    await first.coordinator.start();
    await first.deliver(frame('resync_required', 1, '2026-10-10T00:00:00.000Z'));
    await waitFor(() => contexts.length >= 1, 'generation 1 comment reconciliation');
    assert.equal(contexts[0].recoveryStartedAt, '2026-10-10T00:00:00.000Z');

    // Routing supersedes generation 1 before it converged.
    await first.deliver(frame('resync_required', 2, '2026-10-11T00:00:00.000Z'));
    await waitFor(() => contexts.some(ctx => ctx.gapStartedAt === '2026-10-11T00:00:00.000Z'), 'generation 2 comment reconciliation');
    const second = contexts.find(ctx => ctx.gapStartedAt === '2026-10-11T00:00:00.000Z');
    assert.equal(second?.recoveryStartedAt, '2026-10-10T00:00:00.000Z', 'the October 10 comment stays in the discovery window');
    await first.coordinator.stop();

    // A restart and a further supersession keep the inherited boundary.
    const restarted = harness(reconciler, store);
    assert.equal((await store.load(INSTALLATION))?.recoveryStartedAt, '2026-10-10T00:00:00.000Z', 'the boundary is durable');
    await restarted.coordinator.start();
    await restarted.deliver(frame('resume_pending', 3, '2026-10-12T00:00:00.000Z'));
    assert.equal((await store.load(INSTALLATION))?.recoveryStartedAt, '2026-10-10T00:00:00.000Z');
    fail = false;
    contexts.length = 0;
    await restarted.deliver(frame('resync_required', 3, '2026-10-12T00:00:00.000Z'));
    await waitFor(() => restarted.completions.length === 1, 'generation 3 completion');
    assert.equal(contexts.at(-1)?.recoveryStartedAt, '2026-10-10T00:00:00.000Z');
    assert.equal(restarted.completions[0].resumeGeneration, 3);
    assert.equal(restarted.completions[0].gapStartedAt, '2026-10-12T00:00:00.000Z', 'the completion reports the exact wire gap');
    await restarted.coordinator.stop();
});

test('a generation following a completed one starts discovery at its own gap', async () => {
    const { reconciler, contexts } = recordingReconciler(() => false);
    const ctx = harness(reconciler);
    await ctx.coordinator.start();
    await ctx.deliver(frame('resync_required', 1, '2026-10-10T00:00:00.000Z'));
    await waitFor(() => ctx.completions.length === 1, 'generation 1 completion');
    await ctx.deliver(frame('resync_required', 2, '2026-10-11T00:00:00.000Z'));
    await waitFor(() => ctx.completions.length === 2, 'generation 2 completion');
    assert.equal(contexts.at(-1)?.recoveryStartedAt, '2026-10-11T00:00:00.000Z');
    await ctx.coordinator.stop();
});
