import { after, test } from 'node:test';
import assert from 'node:assert';
import { RoutingResumeResyncCoordinator } from '../packages/core/src/intake/routingResumeResyncCoordinator.js';
import { InMemoryResumeResyncStore, type ResumeResyncRecord } from '../packages/core/src/intake/routingResumeResyncStore.js';
import type { ResumeResyncReconciler } from '../packages/core/src/intake/routingResumeResyncRun.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

/**
 * Persistence boundaries of the resume-resync coordinator: a completion is only
 * ever sent once its save succeeded, and a failed save never strands a record
 * reconciling (or pending/acknowledged) with no work scheduled.
 */

after(async () => {
    await closeConnection();
});

const INSTALLATION = 42;
const GAP_START = '2026-10-10T00:00:00.000Z';
const GAP_END = '2026-10-12T00:00:00.000Z';
const FAMILIES = ['repository_access', 'task_intents', 'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'] as const;

type SaveHook = (record: ResumeResyncRecord) => Promise<void> | void;

/** In-memory store whose saves a test can fail or hold open. */
class ControlledStore extends InMemoryResumeResyncStore {
    hook: SaveHook | null = null;

    override async save(record: ResumeResyncRecord): Promise<void> {
        await this.hook?.(record);
        await super.save(record);
    }
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const reconciler: ResumeResyncReconciler = {
    listRepositories: () => ['acme/api'],
    listReferencedRepositories: () => [],
    repositorySteps: FAMILIES.map(family => ({ family, run: async () => undefined })),
    installationSteps: [{ family: 'ultrafix_continuations', run: async () => undefined }],
};

function frame(type: string) {
    const base: Record<string, unknown> = { type, version: 1, installationId: INSTALLATION, routingGeneration: 1, resumeGeneration: 1, gapStartedAt: GAP_START };
    if (type === 'resync_required') base.gapEndedAt = GAP_END;
    return base;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function setup(store = new ControlledStore(), maxConsecutiveFailures = 8) {
    const coordinator = new RoutingResumeResyncCoordinator({
        installationId: INSTALLATION, store, reconciler, retryBaseDelayMs: 20, retryMaxDelayMs: 40, maxConsecutiveFailures,
    });
    const completions: Record<string, unknown>[] = [];
    const attach = () => coordinator.attach(item => { if (item.type === 'resync_complete') completions.push(item); return true; });
    const deliver = (value: Record<string, unknown>) => coordinator.handleFrame(value, Buffer.byteLength(JSON.stringify(value)));
    return { store, coordinator, completions, attach, deliver };
}

/** Hold the first save of a `completed` snapshot open until the test settles it. */
function holdCompletionSave(store: ControlledStore) {
    const gate = deferred();
    const reached = deferred();
    let held = false;
    store.hook = async record => {
        if (record.state !== 'completed' || held) return;
        held = true;
        reached.resolve();
        await gate.promise;
    };
    return { gate, reached: reached.promise };
}

test('a duplicate resync_required or reconnect during a failing completion save never sends that completion', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    const hold = holdCompletionSave(ctx.store);
    await ctx.deliver(frame('resync_required'));
    await hold.reached;
    assert.equal(ctx.coordinator.getStatus().state, 'completed'); // live state already flipped

    await ctx.deliver(frame('resync_required')); // duplicate frame
    ctx.attach(); // reconnect
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(ctx.completions, [], 'no completion may leave before its save succeeds');

    hold.gate.reject(new Error('disk full'));
    await waitFor(() => ctx.completions.length === 1, 'the retried completion');
    const persisted = await ctx.store.load(INSTALLATION);
    assert.equal(persisted?.state, 'completed');
    assert.equal(ctx.completions[0].completionId, persisted?.completion?.completionId, 'only the durable identity is sent');
    await ctx.coordinator.stop();
});

test('a reconnect during a successful completion save sends the durable identity exactly once', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    const hold = holdCompletionSave(ctx.store);
    await ctx.deliver(frame('resync_required'));
    await hold.reached;
    ctx.attach();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(ctx.completions, []);

    hold.gate.resolve();
    await waitFor(() => ctx.completions.length === 1, 'completion after the save');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ctx.completions.length, 1);
    assert.equal(ctx.completions[0].completionId, (await ctx.store.load(INSTALLATION))?.completion?.completionId);
    await ctx.coordinator.stop();
});

test('a restart resends the persisted completion identity loaded from durable state', async () => {
    const first = setup();
    await first.coordinator.start();
    first.attach();
    await first.deliver(frame('resync_required'));
    await waitFor(() => first.completions.length === 1, 'first completion');
    await first.coordinator.stop();

    const second = setup(first.store);
    await second.coordinator.start();
    second.attach();
    await waitFor(() => second.completions.length === 1, 'resent completion');
    assert.equal(second.completions[0].completionId, first.completions[0].completionId);
    await second.coordinator.stop();
});

test('a failed attempt-start save becomes a diagnosable partial retry instead of stranding the record', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    let failed = false;
    ctx.store.hook = record => {
        if (!failed && record.state === 'reconciling' && record.attempts === 1) {
            failed = true;
            throw new Error('database is locked');
        }
    };
    await ctx.deliver(frame('resync_required'));
    await waitFor(() => failed, 'the failing attempt-start save');
    await waitFor(() => ctx.completions.length === 1, 'completion after the retry');
    const persisted = await ctx.store.load(INSTALLATION);
    assert.equal(persisted?.state, 'completed');
    assert.equal(persisted?.attempts, 2, 'the failed save consumed one bounded attempt');
    await ctx.coordinator.stop();
});

test('a failed attempt-start save surfaces as partial with the persistence error', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    let failures = 0;
    ctx.store.hook = record => {
        if (record.state === 'reconciling' && record.attempts > 0) {
            failures += 1;
            throw new Error('database is locked');
        }
    };
    await ctx.deliver(frame('resync_required'));
    await waitFor(() => failures > 0 && ctx.coordinator.getStatus().state === 'partial', 'partial status');
    const status = ctx.coordinator.getStatus();
    assert.match(status.lastError ?? '', /^persist_attempt: /);
    assert.ok(status.nextRetryAt, 'a retry is scheduled');
    await ctx.coordinator.stop();
});

test('a store that keeps failing ends failed with the error exposed and no completion', async () => {
    const ctx = setup(new ControlledStore(), 3);
    await ctx.coordinator.start();
    ctx.attach();
    ctx.store.hook = record => {
        if (record.state !== 'failed') throw new Error('database is locked');
    };
    await ctx.deliver(frame('resync_required'));
    await waitFor(() => ctx.coordinator.getStatus().state === 'failed', 'failed status');
    assert.match(ctx.coordinator.getStatus().lastError ?? '', /^persist_attempt: /);
    // The failed state is still made durable by the persistence retry.
    await waitFor(async () => (await ctx.store.load(INSTALLATION))?.state === 'failed', 'durable failed state');
    assert.deepEqual(ctx.completions, []);
    await ctx.coordinator.stop();
});

test('a failed generation save still schedules reconciliation, which re-persists the record', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    let failed = false;
    ctx.store.hook = record => {
        if (!failed && record.attempts === 0) {
            failed = true;
            throw new Error('database is locked');
        }
    };
    await ctx.deliver(frame('resync_required'));
    assert.match(ctx.coordinator.getStatus().lastError ?? '', /^persist_generation: /);
    await waitFor(() => ctx.completions.length === 1, 'completion');
    assert.equal((await ctx.store.load(INSTALLATION))?.completion?.completionId, ctx.completions[0].completionId);
    await ctx.coordinator.stop();
});

test('a failed resume_pending save is exposed and retried until durable', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    let failures = 0;
    ctx.store.hook = () => {
        if (failures < 2) {
            failures += 1;
            throw new Error('database is locked');
        }
    };
    await ctx.deliver(frame('resume_pending'));
    assert.equal(ctx.coordinator.getStatus().state, 'pending');
    assert.match(ctx.coordinator.getStatus().lastError ?? '', /^persist_/);
    await waitFor(async () => (await ctx.store.load(INSTALLATION))?.state === 'pending', 'durable pending record');
    assert.equal(ctx.coordinator.getStatus().lastError, null, 'the recovered save clears its persistence error');
    await ctx.coordinator.stop();
});

test('a failed save on the pending→reconciling and failed→reconciling transitions still schedules a run', async () => {
    for (const initial of ['pending', 'failed'] as const) {
        const ctx = setup(new ControlledStore(), 1);
        await ctx.coordinator.start();
        ctx.attach();
        if (initial === 'pending') {
            await ctx.deliver(frame('resume_pending'));
        } else {
            ctx.store.hook = record => { if (record.state === 'reconciling' && record.attempts > 0) throw new Error('database is locked'); };
            await ctx.deliver(frame('resync_required'));
            await waitFor(() => ctx.coordinator.getStatus().state === 'failed', 'failed record');
        }
        let failed = false;
        ctx.store.hook = record => {
            if (!failed && record.state === 'reconciling') {
                failed = true;
                throw new Error('database is locked');
            }
        };
        await ctx.deliver(frame('resync_required'));
        assert.equal(failed, true, `${initial}: the transition save failed`);
        assert.match(ctx.coordinator.getStatus().lastError ?? '', /^persist_/);
        await waitFor(() => ctx.completions.length === 1, `${initial}: completion after recovery`);
        assert.equal((await ctx.store.load(INSTALLATION))?.state, 'completed');
        await ctx.coordinator.stop();
    }
});

test('a failed acknowledgement save is retried until durable', async () => {
    const ctx = setup();
    await ctx.coordinator.start();
    ctx.attach();
    await ctx.deliver(frame('resync_required'));
    await waitFor(() => ctx.completions.length === 1, 'completion');
    let failed = false;
    ctx.store.hook = record => {
        if (!failed && record.state === 'acknowledged') {
            failed = true;
            throw new Error('database is locked');
        }
    };
    const { gapStartedAt: _ignored, ...accepted } = { ...frame('resync_accepted'), completionId: ctx.completions[0].completionId };
    await ctx.deliver(accepted);
    assert.equal(failed, true);
    await waitFor(async () => (await ctx.store.load(INSTALLATION))?.state === 'acknowledged', 'durable acknowledgement');
    await ctx.coordinator.stop();
});
