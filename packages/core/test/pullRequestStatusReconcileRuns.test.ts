import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type {
    PullRequestListCursor,
    PullRequestStatusBackfillResult,
    PullRequestStatusBackfillWork,
    PullRequestStatusBasePushResult,
} from '../src/services/pullRequestStatus/pullRequestStatusReconcile.js';
import {
    schedulePullRequestStatusBaseListing,
    startPullRequestStatusBackfillRun,
    stopPullRequestStatusReconcileRuns,
    type PullRequestStatusReconcileRunner,
} from '../src/services/pullRequestStatus/pullRequestStatusReconcileRuns.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await pause(5);
}

const REPOSITORY = 'integry/propr';
const page = (number: number): PullRequestListCursor => ({ page: number, after: number * 100 });
/** A branch whose open pull requests take three batches: the start, page 3 and page 5. */
const NEXT: Record<string, PullRequestListCursor | null> = { start: page(3), 3: page(5), 5: null };
const where = (from: PullRequestListCursor | null) => (from ? String(from.page) : 'start');

function runner(overrides: Partial<PullRequestStatusReconcileRunner> = {}): PullRequestStatusReconcileRunner & { enabledNow: boolean } {
    const state: PullRequestStatusReconcileRunner & { enabledNow: boolean } = {
        enabledNow: true,
        enabled: () => state.enabledNow,
        retryDelaysMs: () => [10, 10],
        debounceMs: 5,
        backfill: async () => ({ repositories: 0, scheduled: 0, failed: [], remaining: [], resumeAfterMs: 5 }),
        refreshForBasePush: async () => ({ scheduled: [], next: null, resumeAfterMs: 5 }),
        ...overrides,
    };
    return state;
}

afterEach(() => stopPullRequestStatusReconcileRuns());

// --- Pushes to a base branch ---

function baseRun(onBatch: (call: { sha: string; from: string }) => void = () => {}) {
    const calls: Array<{ sha: string; from: string }> = [];
    const failures = new Map<string, number>();
    const run = runner({
        refreshForBasePush: async ({ sha, from }): Promise<PullRequestStatusBasePushResult> => {
            const call = { sha, from: where(from) };
            calls.push(call);
            onBatch(call);
            const failing = failures.get(call.from) ?? 0;
            if (failing > 0) {
                failures.set(call.from, failing - 1);
                throw new Error('GitHub unavailable');
            }
            return { scheduled: [], next: NEXT[call.from], resumeAfterMs: 20 };
        },
    });
    const pushTo = (sha: string) => schedulePullRequestStatusBaseListing(run, { repository: REPOSITORY, branch: 'main', sha });
    return { calls, failures, run, pushTo };
}

test('a base listing cut short by its batch budget resumes where it stopped until it is complete', async () => {
    const { calls, pushTo } = baseRun();
    pushTo('tip-1');
    pushTo('tip-1');
    await until(() => calls.length >= 3);
    await pause(60);
    assert.deepEqual(calls, [{ sha: 'tip-1', from: 'start' }, { sha: 'tip-1', from: '3' }, { sha: 'tip-1', from: '5' }]);
});

test('a push while a batch runs moves the listing to the new tip, and the pages before it are listed again', async () => {
    let pushTo: (sha: string) => void = () => {};
    const listing = baseRun(call => { if (call.sha === 'tip-1' && call.from === '3') pushTo('tip-2'); });
    pushTo = listing.pushTo;
    pushTo('tip-1');
    await until(() => listing.calls.length >= 6);
    await pause(60);
    assert.deepEqual(listing.calls, [
        { sha: 'tip-1', from: 'start' }, { sha: 'tip-1', from: '3' },
        // The rest of the pass reads for the new tip, then the pass lists again what it covered for the older one.
        { sha: 'tip-2', from: '5' }, { sha: 'tip-2', from: 'start' }, { sha: 'tip-2', from: '3' }, { sha: 'tip-2', from: '5' },
    ]);
});

test('pushes between batches do not restart the listing, so its last page is still reached', async () => {
    let pushes = 0;
    let pushTo: (sha: string) => void = () => {};
    // Each batch is followed by a push before the next batch starts: a restart on every push would never pass the first batch.
    const listing = baseRun(() => { if (pushes < 3) setTimeout(() => pushTo(`tip-${++pushes + 1}`), 5); });
    pushTo = listing.pushTo;
    pushTo('tip-1');
    await until(() => listing.calls.some(call => call.from === '5'));
    assert.deepEqual(listing.calls.slice(0, 3).map(call => call.from), ['start', '3', '5']);
    await until(() => listing.calls.length >= 6);
    await pause(80);
    const last = listing.calls.at(-1)!;
    assert.equal(last.sha, 'tip-4', 'the listing ends on the newest tip');
    assert.deepEqual(listing.calls.filter(call => call.sha === 'tip-4').map(call => call.from).slice(-3), ['start', '3', '5']);
});

test('a failed batch is retried from where it stopped, within the bounded schedule', async () => {
    const { calls, failures, pushTo } = baseRun();
    failures.set('3', 1);
    pushTo('tip-1');
    await until(() => calls.length >= 4);
    await pause(60);
    assert.deepEqual(calls.map(call => call.from), ['start', '3', '3', '5']);

    // A batch that keeps failing gives up after the schedule; the next push lists from the start.
    calls.length = 0;
    failures.set('3', 10);
    pushTo('tip-2');
    await until(() => calls.length >= 4);
    await pause(60);
    assert.deepEqual(calls.map(call => call.from), ['start', '3', '3', '3']);
    pushTo('tip-3');
    await until(() => calls.length >= 5);
    assert.deepEqual(calls.at(-1), { sha: 'tip-3', from: 'start' });
});

test('stopping the runs drops a pending batch, and a batch still running then schedules no further one', async () => {
    const pending = baseRun();
    pending.pushTo('tip-1');
    await until(() => pending.calls.length >= 1);
    stopPullRequestStatusReconcileRuns();
    await pause(60);
    assert.equal(pending.calls.length, 1);

    let release: () => void = () => {};
    const held = runner({
        refreshForBasePush: () => new Promise(resolve => { release = () => resolve({ scheduled: [], next: page(3), resumeAfterMs: 5 }); }),
    });
    let batches = 0;
    const counted = { ...held, refreshForBasePush: (push: Parameters<typeof held.refreshForBasePush>[0]) => { batches++; return held.refreshForBasePush(push); } };
    schedulePullRequestStatusBaseListing(counted, { repository: REPOSITORY, branch: 'main', sha: 'tip-1' });
    await until(() => batches === 1);
    stopPullRequestStatusReconcileRuns();
    release();
    await pause(60);
    assert.equal(batches, 1);
});

// --- Startup backfill ---

const key = (work?: PullRequestStatusBackfillWork[]) => (work ? work.map(item => `${item.repository}@${where(item.from)}`).join(',') : 'all');
const result = (overrides: Partial<PullRequestStatusBackfillResult> = {}): PullRequestStatusBackfillResult =>
    ({ repositories: 1, scheduled: 0, failed: [], remaining: [], resumeAfterMs: 5, ...overrides });

test('the backfill runs the work its batch budget left, and retries failed listings from where they were', async () => {
    const calls: string[] = [];
    let aAttempts = 0;
    const run = runner({
        backfill: async work => {
            calls.push(key(work));
            if (!work) return result({ failed: [{ repository: 'o/a', from: null }], remaining: [{ repository: 'o/b', from: page(3) }] });
            if (key(work) === 'o/a@start') {
                // Fails until the last retry, which is cut short: its rest still runs, as a deferral rather than a retry.
                return ++aAttempts < 2 ? result({ failed: work }) : result({ remaining: [{ repository: 'o/a', from: page(3) }] });
            }
            return result();
        },
    });
    startPullRequestStatusBackfillRun(run);
    await until(() => calls.includes('o/a@3'));
    await pause(60);
    assert.deepEqual([...calls].sort(), ['all', 'o/a@3', 'o/a@start', 'o/a@start', 'o/b@3'].sort());
    assert.equal(calls[0], 'all');
});

test('a backfill whose monitored repositories cannot be read is read again, within the bounded schedule', async () => {
    const calls: string[] = [];
    const run = runner({ backfill: async work => { calls.push(key(work)); throw new Error('config unavailable'); } });
    startPullRequestStatusBackfillRun(run);
    await until(() => calls.length >= 3);
    await pause(60);
    assert.deepEqual(calls, ['all', 'all', 'all']);
});

test('a backfill batch still running when the runs stop schedules no further batch', async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const run = runner({
        backfill: work => {
            calls.push(key(work));
            return new Promise(resolve => { release = () => resolve(result({ remaining: [{ repository: 'o/b', from: page(3) }] })); });
        },
    });
    startPullRequestStatusBackfillRun(run);
    await until(() => calls.length === 1);
    stopPullRequestStatusReconcileRuns();
    release();
    await pause(60);
    assert.deepEqual(calls, ['all']);

    // Disabled maintenance does not go on either.
    const disabled = runner({ backfill: async work => { calls.push(key(work)); return result({ remaining: [{ repository: 'o/b', from: page(3) }] }); } });
    disabled.enabledNow = false;
    startPullRequestStatusBackfillRun(disabled);
    await pause(60);
    assert.deepEqual(calls, ['all', 'all']);
});
