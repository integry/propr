import { after, test } from 'node:test';
import assert from 'node:assert';
import {
    closeConnection,
    InMemoryResumeResyncStore,
    ResyncRepositoryInaccessibleError,
    RoutingResumeResyncCoordinator,
    type ResumeResyncReconciler,
    type ResyncFamily,
} from '@propr/core';

after(async () => {
    await closeConnection();
});

const INSTALLATION = 42;
const GAP_START = '2026-10-10T00:00:00.000Z';
const GAP_END = '2026-10-12T00:00:00.000Z';
const REPO_FAMILIES = ['repository_access', 'task_intents', 'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'] as const;

type StepFailure = (repository: string, family: ResyncFamily, call: number) => unknown;

function makeReconciler(repositories: string[], fail: StepFailure = () => undefined) {
    const calls: string[] = [];
    const counts = new Map<string, number>();
    const record = (key: string, repository: string, family: ResyncFamily) => {
        const call = (counts.get(key) ?? 0) + 1;
        counts.set(key, call);
        calls.push(key);
        const error = fail(repository, family, call);
        if (error) throw error;
    };
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => repositories,
        repositorySteps: REPO_FAMILIES.map(family => ({
            family,
            run: async (ctx) => record(`${ctx.repository}:${family}`, ctx.repository, family),
        })),
        installationSteps: [{
            family: 'ultrafix_continuations',
            run: async () => record('installation:ultrafix_continuations', '*', 'ultrafix_continuations'),
        }],
    };
    return { reconciler, calls };
}

function frame(type: string, overrides: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
        type, version: 1, installationId: INSTALLATION, routingGeneration: 1, resumeGeneration: 1, gapStartedAt: GAP_START,
    };
    if (type === 'resync_required') base.gapEndedAt = GAP_END;
    return { ...base, ...overrides };
}

async function deliver(coordinator: RoutingResumeResyncCoordinator, value: Record<string, unknown>) {
    await coordinator.handleFrame(value, Buffer.byteLength(JSON.stringify(value)));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function setup(options: { repositories?: string[]; fail?: StepFailure; store?: InMemoryResumeResyncStore; maxConsecutiveFailures?: number } = {}) {
    const store = options.store ?? new InMemoryResumeResyncStore();
    const { reconciler, calls } = makeReconciler(options.repositories ?? ['acme/api', 'acme/web'], options.fail);
    const coordinator = new RoutingResumeResyncCoordinator({
        installationId: INSTALLATION, store, reconciler, retryBaseDelayMs: 20, retryMaxDelayMs: 40,
        maxConsecutiveFailures: options.maxConsecutiveFailures ?? 8,
    });
    const sent: Record<string, unknown>[] = [];
    const completions = () => sent.filter(item => item.type === 'resync_complete');
    return { store, coordinator, calls, sent, completions, attach: () => coordinator.attach(item => { sent.push(item); return true; }) };
}

test('resume_pending records the gap, holds intake and never completes on reconnect alone', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resume_pending'));
    ctx.attach(); // reconnect
    await new Promise(resolve => setTimeout(resolve, 30));
    const status = ctx.coordinator.getStatus();
    assert.equal(status.state, 'pending');
    assert.equal(status.intakeWaiting, true);
    assert.equal(status.gapStartedAt, GAP_START);
    assert.equal(status.gapEndedAt, null);
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.completions(), []);
    assert.equal((await ctx.store.load(INSTALLATION))?.state, 'pending');
    await ctx.coordinator.stop();
});

test('resync_required reconciles every repository family, then sends one exact-generation completion', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resume_pending'));
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.completions().length === 1, 'completion');

    for (const repository of ['acme/api', 'acme/web']) {
        assert.deepEqual(ctx.calls.filter(call => call.startsWith(`${repository}:`)), REPO_FAMILIES.map(family => `${repository}:${family}`));
    }
    assert.equal(ctx.calls.at(-1), 'installation:ultrafix_continuations', 'installation families run after every repository converged');
    const [complete] = ctx.completions();
    assert.equal(complete.installationId, INSTALLATION);
    assert.equal(complete.routingGeneration, 1);
    assert.equal(complete.resumeGeneration, 1);
    assert.equal(complete.gapStartedAt, GAP_START);
    assert.equal(complete.gapEndedAt, GAP_END);
    const evidence = complete.evidence as { repositories: unknown; attempts: number; digest: string };
    assert.deepEqual(evidence.repositories, { total: 2, reconciled: 2, inaccessible: 0 });
    assert.equal(evidence.attempts, 1);
    assert.match(evidence.digest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(complete).includes('acme/'), 'repository names stay local');
    assert.equal(ctx.coordinator.getStatus().state, 'completed');
    assert.equal(ctx.coordinator.getStatus().intakeWaiting, true, 'intake waits until Routing accepts');

    await deliver(ctx.coordinator, frame('resync_accepted', { completionId: complete.completionId }));
    const status = ctx.coordinator.getStatus();
    assert.equal(status.state, 'acknowledged');
    assert.equal(status.intakeWaiting, false);
    assert.ok(status.acknowledgedAt);
    assert.equal((await ctx.store.load(INSTALLATION))?.state, 'acknowledged');
    await ctx.coordinator.stop();
});

test('duplicate frames resume the same work and a lost completion is resent with the same identity', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resync_required'));
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.completions().length === 1, 'completion');
    const callsAfterCompletion = ctx.calls.length;
    assert.equal(callsAfterCompletion, REPO_FAMILIES.length * 2 + 1, 'the duplicate did not start a second run');

    await deliver(ctx.coordinator, frame('resync_required'));
    await deliver(ctx.coordinator, frame('resume_pending'));
    ctx.attach();
    await waitFor(() => ctx.completions().length === 3, 'resent completions');
    const ids = new Set(ctx.completions().map(item => item.completionId));
    assert.equal(ids.size, 1, 'every resend carries the same completion identity');
    assert.deepEqual(ctx.completions()[2], ctx.completions()[0]);
    assert.equal(ctx.calls.length, callsAfterCompletion, 'no side effects reran');
    await ctx.coordinator.stop();
});

test('a restart resumes persisted progress without rerunning completed families', async () => {
    const store = new InMemoryResumeResyncStore();
    let crash = true;
    const first = setup({
        store,
        fail: (repository, family) => (crash && repository === 'acme/web' && family === 'pull_request_comments' ? new Error('daemon died') : undefined),
        maxConsecutiveFailures: 1,
    });
    await first.coordinator.start();
    await deliver(first.coordinator, frame('resync_required'));
    await waitFor(() => first.coordinator.getStatus().state === 'failed', 'first attempt to stop');
    await first.coordinator.stop();
    crash = false;

    const second = setup({ store });
    await second.coordinator.start();
    second.attach();
    await waitFor(() => second.completions().length === 1, 'completion after restart');
    assert.deepEqual(second.calls, [
        'acme/web:pull_request_comments', 'acme/web:pull_request_heads', 'acme/web:merge_conflicts',
        'installation:ultrafix_continuations',
    ]);

    // The completion response is lost; a third process resends it unchanged.
    const completionId = second.completions()[0].completionId;
    await second.coordinator.stop();
    const third = setup({ store });
    await third.coordinator.start();
    third.attach();
    await waitFor(() => third.completions().length === 1, 'resend after restart');
    assert.equal(third.completions()[0].completionId, completionId);
    assert.deepEqual(third.calls, []);
    await third.coordinator.stop();
});

test('stale, foreign, conflicting and malformed frames fail closed without changing state', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resume_pending', { routingGeneration: 2, resumeGeneration: 5 }));
    const before = await ctx.store.load(INSTALLATION);
    const cases: Array<[Record<string, unknown>, string]> = [
        [frame('resync_required', { routingGeneration: 1, resumeGeneration: 9 }), 'stale_generation'],
        [frame('resync_required', { routingGeneration: 2, resumeGeneration: 4 }), 'stale_generation'],
        [frame('resync_required', { routingGeneration: 2, resumeGeneration: 5, installationId: 7 }), 'foreign_installation'],
        [frame('resync_required', { routingGeneration: 2, resumeGeneration: 5, gapStartedAt: '2026-10-09T00:00:00.000Z' }), 'conflicting_generation'],
        [frame('resync_required', { routingGeneration: 2, resumeGeneration: 5, version: 9 }), 'unsupported_version'],
        [frame('resync_accepted', { routingGeneration: 2, resumeGeneration: 5, completionId: 'guess' }), 'not_completed'],
        [frame('resync_accepted', { routingGeneration: 3, resumeGeneration: 1, completionId: 'guess' }), 'unknown_generation'],
    ];
    for (const [value, reason] of cases) {
        await deliver(ctx.coordinator, value);
        assert.equal(ctx.coordinator.getStatus().lastRejection?.reason, reason, JSON.stringify(value));
    }
    assert.deepEqual(await ctx.store.load(INSTALLATION), before);
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.completions(), []);

    // The real unsuspension still proceeds, and a mismatched acceptance is refused.
    await deliver(ctx.coordinator, frame('resync_required', { routingGeneration: 2, resumeGeneration: 5 }));
    await waitFor(() => ctx.completions().length === 1, 'completion');
    await deliver(ctx.coordinator, frame('resync_required', { routingGeneration: 2, resumeGeneration: 5, gapEndedAt: '2026-10-13T00:00:00.000Z' }));
    assert.equal(ctx.coordinator.getStatus().lastRejection?.reason, 'conflicting_generation');
    await deliver(ctx.coordinator, frame('resync_accepted', { routingGeneration: 2, resumeGeneration: 5, completionId: 'other' }));
    assert.equal(ctx.coordinator.getStatus().lastRejection?.reason, 'completion_mismatch');
    assert.equal(ctx.coordinator.getStatus().state, 'completed');
    await ctx.coordinator.stop();
});

test('partial repository failures never complete; retries resume only unfinished families', async () => {
    const ctx = setup({ fail: (repository, family, call) => (repository === 'acme/api' && family === 'labelled_issues' && call < 3 ? new Error('GitHub 502') : undefined) });
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.coordinator.getStatus().state === 'partial', 'partial');
    const partial = ctx.coordinator.getStatus();
    assert.deepEqual(ctx.completions(), []);
    assert.equal(partial.repositories.failed, 1);
    assert.equal(partial.repositories.reconciled, 1);
    assert.match(partial.lastError ?? '', /acme\/api labelled_issues: GitHub 502/);
    assert.deepEqual(partial.failedRepositories, [{ repository: 'acme/api', error: 'GitHub 502' }]);
    assert.ok(partial.nextRetryAt);
    assert.ok(!ctx.calls.includes('installation:ultrafix_continuations'));

    await waitFor(() => ctx.completions().length === 1, 'completion after retries');
    assert.equal(ctx.calls.filter(call => call === 'acme/api:task_intents').length, 1, 'completed families are not rerun');
    assert.equal(ctx.calls.filter(call => call === 'acme/web:merge_conflicts').length, 1);
    assert.equal(ctx.calls.filter(call => call === 'acme/api:labelled_issues').length, 3);
    assert.equal((ctx.completions()[0].evidence as { attempts: number }).attempts, 3);
    await ctx.coordinator.stop();
});

test('rate limits stop the attempt and defer the retry until GitHub resets', async () => {
    const rateLimit = Object.assign(new Error('API rate limit exceeded'), { status: 403, response: { headers: { 'retry-after': '3600' } } });
    const ctx = setup({ repositories: ['acme/a', 'acme/b', 'acme/c', 'acme/d'], fail: (repository, family) => (repository === 'acme/a' && family === 'task_intents' ? rateLimit : undefined) });
    await ctx.coordinator.start();
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.coordinator.getStatus().state === 'partial', 'partial');
    const status = ctx.coordinator.getStatus();
    assert.ok(Date.parse(status.nextRetryAt as string) >= Date.now() + 3_500_000, 'retry honours retry-after');
    assert.ok(!ctx.calls.some(call => call.startsWith('acme/d:')), 'no new repositories start after the limit');
    // A duplicate frame keeps the rate-limit schedule rather than hammering GitHub.
    const calls = ctx.calls.length;
    await deliver(ctx.coordinator, frame('resync_required'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(ctx.calls.length, calls);
    await ctx.coordinator.stop();
});

test('an exhausted retry budget turns failed; a duplicate resync_required resumes it', async () => {
    let broken = true;
    const ctx = setup({ maxConsecutiveFailures: 2, fail: (_repository, family) => (broken && family === 'ultrafix_continuations' ? new Error('redis down') : undefined) });
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.coordinator.getStatus().state === 'failed', 'failed');
    assert.deepEqual(ctx.completions(), [], 'an installation family failure blocks completion');
    assert.equal(ctx.coordinator.getStatus().nextRetryAt, null);
    broken = false;
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.completions().length === 1, 'completion after resume');
    assert.equal(ctx.calls.filter(call => call === 'acme/api:repository_access').length, 1);
    await ctx.coordinator.stop();
});

test('inaccessible repositories are reported in evidence instead of blocking forever', async () => {
    const ctx = setup({ fail: (repository, family) => (repository === 'acme/web' && family === 'repository_access' ? new ResyncRepositoryInaccessibleError(repository, 404) : undefined) });
    await ctx.coordinator.start();
    ctx.attach();
    await deliver(ctx.coordinator, frame('resync_required'));
    await waitFor(() => ctx.completions().length === 1, 'completion');
    assert.deepEqual((ctx.completions()[0].evidence as { repositories: unknown }).repositories, { total: 2, reconciled: 1, inaccessible: 1 });
    assert.ok(!ctx.calls.includes('acme/web:task_intents'));
    await ctx.coordinator.stop();
});

test('a newer generation supersedes unfinished work and restarts reconciliation', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new InMemoryResumeResyncStore();
    const { reconciler, calls } = makeReconciler(['acme/api']);
    const slowStep = reconciler.repositorySteps[1];
    const blocking = { ...reconciler, repositorySteps: reconciler.repositorySteps.map(step => step === slowStep
        ? { family: step.family, run: async (stepCtx: Parameters<typeof step.run>[0]) => { await gate; await step.run(stepCtx); } }
        : step) };
    const coordinator = new RoutingResumeResyncCoordinator({ installationId: INSTALLATION, store, reconciler: blocking, stopTimeoutMs: 1000 });
    const sent: Record<string, unknown>[] = [];
    await coordinator.start();
    coordinator.attach(item => { sent.push(item); return true; });
    await deliver(coordinator, frame('resync_required'));
    await waitFor(() => calls.includes('acme/api:repository_access'), 'first generation running');
    const superseding = deliver(coordinator, frame('resync_required', { resumeGeneration: 2, gapStartedAt: '2026-10-11T00:00:00.000Z' }));
    release();
    await superseding;
    await waitFor(() => sent.filter(item => item.type === 'resync_complete').length === 1, 'completion');
    const [complete] = sent.filter(item => item.type === 'resync_complete');
    assert.equal(complete.resumeGeneration, 2);
    assert.equal(complete.gapStartedAt, '2026-10-11T00:00:00.000Z');
    assert.equal(calls.filter(call => call === 'acme/api:repository_access').length, 2, 'the new gap reconciles from scratch');
    await coordinator.stop();
});
