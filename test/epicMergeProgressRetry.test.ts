import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { EPIC_COMPLETE_MARKER, EPIC_PROGRESS_MARKER, updateEpicMergeProgress } from '../packages/core/src/webhook/epicMergeProgress.js';
import {
    EPIC_PROGRESS_RETRY_KEY, EPIC_PROGRESS_RETRY_MAX_AGE_MS, EpicProgressLeaseLostError, epicProgressRetryField,
    recordEpicProgressRetry, runEpicProgressUpdate, sweepEpicProgressRetries,
    type EpicProgressTarget,
} from '../packages/core/src/webhook/epicMergeProgressRetry.js';

after(async () => { await closeConnection(); });

const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
const target: EpicProgressTarget = { owner: 'integry', repo: 'propr', epicBranch: '100-epic-big-plan-abc', epicPrNumber: 500, mergedChildPrNumber: 203 };
const field = epicProgressRetryField(target.owner, target.repo, target.epicBranch);

function fakeRedis() {
    const hash = new Map<string, string>();
    const keys = new Map<string, string>();
    const extensions: string[] = [];
    return {
        hash,
        keys,
        extensions,
        async hget(_key: string, f: string) { return hash.get(f) ?? null; },
        async hset(_key: string, f: string, value: string) { hash.set(f, value); return 1; },
        async hgetall(key: string) { assert.equal(key, EPIC_PROGRESS_RETRY_KEY); return Object.fromEntries(hash); },
        async set(key: string, value: string) {
            if (keys.has(key)) return null;
            keys.set(key, value);
            return 'OK';
        },
        async eval(script: string, _n: number, key: string, ...args: string[]) {
            if (script.includes('HGET')) {
                if (hash.get(args[0]) !== args[1]) return 0;
                return Number(hash.delete(args[0]));
            }
            if (keys.get(key) !== args[0]) return 0;
            if (script.includes('PEXPIRE')) {
                extensions.push(args[1]);
                return 1;
            }
            return Number(keys.delete(key));
        },
    };
}

describe('runEpicProgressUpdate', () => {
    test('defers to a retry while another update holds the epic lease', async () => {
        const redis = fakeRedis();
        let concurrentOutcome: string | undefined;
        let updates = 0;
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 1_000,
            update: async () => {
                updates++;
                concurrentOutcome = await runEpicProgressUpdate(target, {
                    redis: redis as never, log, now: () => 1_000, update: async () => { updates++; return true; },
                });
                return true;
            },
        });
        assert.equal(outcome, 'updated');
        assert.equal(concurrentOutcome, 'retry_scheduled');
        assert.equal(updates, 1);
        // The deferred update was recorded after this one started, so it is kept.
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
        assert.equal(redis.keys.size, 0);
    });

    test('keeps a retry recorded by a later failure while an earlier update succeeds', async () => {
        const redis = fakeRedis();
        redis.hash.set(field, JSON.stringify({ ...target, attempts: 1, firstFailedAt: 0, nextAttemptAt: 0 }));
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 5_000,
            update: async () => {
                redis.hash.set(field, JSON.stringify({ ...target, mergedChildPrNumber: 204, attempts: 1, firstFailedAt: 4_000, nextAttemptAt: 0 }));
                return true;
            },
        });
        assert.equal(outcome, 'updated');
        assert.equal(JSON.parse(redis.hash.get(field)!).mergedChildPrNumber, 204);
    });
});

/** One epic PR's bot comments, with a comment-list read that can be held open. */
function fakeEpicOctokit() {
    const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    const commentReadHolds: Array<{ until: Promise<void>; onHeld: () => void }> = [];
    let commentReads = 0;
    return {
        comments,
        /** Number of comment-list reads so far. */
        get commentReads() { return commentReads; },
        /** Holds the next comment read open after its snapshot is taken; queued holds apply to later reads in order. */
        holdCommentRead(until: Promise<void>, onHeld: () => void) { commentReadHolds.push({ until, onHeld }); },
        async paginate(route: string) {
            if (route === 'GET /repos/{owner}/{repo}/pulls') return [{ number: 203, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }];
            commentReads++;
            const snapshot = comments.map(comment => ({ ...comment }));
            const hold = commentReadHolds.shift();
            if (hold) {
                hold.onHeld();
                await hold.until;
            }
            return snapshot;
        },
        async request(route: string, parameters: Record<string, unknown>) {
            assert.equal(route, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
            comments.push({ id: comments.length + 1, body: parameters.body as string, user: { login: 'propr-dev[bot]' } });
            return { data: {} };
        },
    };
}

describe('runEpicProgressUpdate lease ownership', () => {
    test('an update whose lease expired during a comment read writes nothing', async () => {
        const redis = fakeRedis();
        const octokit = fakeEpicOctokit();
        let releaseRead!: () => void;
        let readHeld!: () => void;
        const held = new Promise<void>(resolve => { readHeld = resolve; });
        octokit.holdCommentRead(new Promise<void>(resolve => { releaseRead = resolve; }), readHeld);

        const stale = runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 1_000,
            update: lease => updateEpicMergeProgress({ ...target, epicPrNumber: 500 }, 'test', { getOctokit: async () => octokit, assertOwned: lease.assertOwned })
                .then(() => true),
        });
        // The stale update has read an empty comment list and is waiting on the response.
        await held;
        // The lease expires while the read is outstanding, and another delivery takes over.
        redis.keys.clear();
        const fresh = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 2_000,
            update: lease => updateEpicMergeProgress({ ...target, epicPrNumber: 500 }, 'test', { getOctokit: async () => octokit, assertOwned: lease.assertOwned })
                .then(() => true),
        });
        releaseRead();

        assert.equal(fresh, 'updated');
        assert.equal(await stale, 'retry_scheduled');
        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_PROGRESS_MARKER)).length, 1);
        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_COMPLETE_MARKER)).length, 1);
        // The aborted update keeps its obligation for the sweep.
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
    });

    test('two overlapping updates paused after an empty comment lookup post one tracking comment', async () => {
        // Both updates read the comment list before either has posted, so each
        // sees no tracking comment. The lease, re-checked before every write,
        // is what keeps the stale one from creating a duplicate.
        const redis = fakeRedis();
        const octokit = fakeEpicOctokit();
        const hold = () => {
            let release!: () => void;
            let onHeld!: () => void;
            const held = new Promise<void>(resolve => { onHeld = resolve; });
            octokit.holdCommentRead(new Promise<void>(resolve => { release = resolve; }), onHeld);
            return { held, release };
        };
        const staleRead = hold();
        const freshRead = hold();
        const deliver = (now: number) => runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => now,
            update: lease => updateEpicMergeProgress({ ...target, epicPrNumber: 500 }, 'test', { getOctokit: async () => octokit, assertOwned: lease.assertOwned })
                .then(() => true),
        });

        const stale = deliver(1_000);
        await staleRead.held;
        // The lease expires while the stale read is outstanding; a second delivery takes over and reads too.
        redis.keys.clear();
        const fresh = deliver(2_000);
        await freshRead.held;
        assert.equal(octokit.commentReads, 2);
        assert.deepEqual(octokit.comments, []);

        // The stale update resumes first, while the fresh one still holds the lease.
        staleRead.release();
        assert.equal(await stale, 'retry_scheduled');
        assert.deepEqual(octokit.comments, []);
        freshRead.release();
        assert.equal(await fresh, 'updated');

        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_PROGRESS_MARKER)).length, 1);
        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_COMPLETE_MARKER)).length, 1);
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
    });

    test('a delivery overlapping a held lease defers before reading or posting any comment', async () => {
        const redis = fakeRedis();
        const octokit = fakeEpicOctokit();
        let release!: () => void;
        let onHeld!: () => void;
        const held = new Promise<void>(resolve => { onHeld = resolve; });
        octokit.holdCommentRead(new Promise<void>(resolve => { release = resolve; }), onHeld);
        const deliver = (now: number) => runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => now,
            update: lease => updateEpicMergeProgress({ ...target, epicPrNumber: 500 }, 'test', { getOctokit: async () => octokit, assertOwned: lease.assertOwned })
                .then(() => true),
        });

        const first = deliver(1_000);
        await held;
        // The lease is still held, so the overlapping delivery never reaches GitHub.
        const second = await deliver(1_500);
        assert.equal(second, 'retry_scheduled');
        assert.equal(octokit.commentReads, 1);
        assert.deepEqual(octokit.comments, []);

        release();
        assert.equal(await first, 'updated');
        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_PROGRESS_MARKER)).length, 1);
        assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_COMPLETE_MARKER)).length, 1);
        // The deferred delivery's obligation was recorded after the first one started, so it survives for the sweep.
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
        assert.equal(redis.keys.size, 0);
    });

    test('assertOwned extends a held lease and rejects once it is taken over', async () => {
        const redis = fakeRedis();
        await runEpicProgressUpdate(target, {
            redis: redis as never, log,
            update: async lease => {
                await lease.assertOwned();
                assert.deepEqual(redis.extensions, [String(2 * 60 * 1000)]);
                redis.keys.set([...redis.keys.keys()][0], 'other-owner');
                await assert.rejects(lease.assertOwned(), EpicProgressLeaseLostError);
                return true;
            },
        });
        // The other owner's lease is not released.
        assert.deepEqual([...redis.keys.values()], ['other-owner']);
    });

    test('renews the lease while a slow update runs', async () => {
        mock.timers.enable({ apis: ['setInterval'] });
        try {
            const redis = fakeRedis();
            let finish!: () => void;
            const outcome = runEpicProgressUpdate(target, {
                redis: redis as never, log,
                update: () => new Promise<boolean>(resolve => { finish = () => resolve(true); }),
            });
            await new Promise(resolve => setImmediate(resolve));
            mock.timers.tick(30_000);
            mock.timers.tick(30_000);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(redis.extensions.length, 2);
            finish();
            assert.equal(await outcome, 'updated');
        } finally {
            mock.timers.reset();
        }
    });

    test('defers to a retry instead of writing unguarded when the lease cannot be acquired', async () => {
        const redis = fakeRedis();
        redis.set = async () => { throw new Error('redis unavailable'); };
        let updates = 0;
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 1_000, update: async () => { updates++; return true; },
        });
        assert.equal(outcome, 'retry_scheduled');
        assert.equal(updates, 0);
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
    });

    test('overlapping deliveries without Redis post no comments instead of duplicates', async () => {
        const redis = fakeRedis();
        redis.hget = async () => { throw new Error('redis unavailable'); };
        redis.hset = async () => { throw new Error('redis unavailable'); };
        const octokit = fakeEpicOctokit();
        const deliver = () => runEpicProgressUpdate(target, {
            redis: redis as never, log,
            update: lease => updateEpicMergeProgress({ ...target, epicPrNumber: 500 }, 'test', { getOctokit: async () => octokit, assertOwned: lease.assertOwned })
                .then(() => true),
        });
        assert.deepEqual(await Promise.all([deliver(), deliver()]), ['skipped', 'skipped']);
        assert.deepEqual(octokit.comments, []);
    });

    test('never runs the update when the lease is busy and the retry cannot be recorded', async () => {
        const redis = fakeRedis();
        redis.keys.set(`epic:merge-progress-lock:${field}`, 'other-owner');
        redis.hset = async () => { throw new Error('redis write failed'); };
        let updates = 0;
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, update: async () => { updates++; return true; },
        });
        assert.equal(outcome, 'skipped');
        assert.equal(updates, 0);
        assert.deepEqual([...redis.keys.values()], ['other-owner']);
    });
});

describe('recordEpicProgressRetry', () => {
    test('keeps a known epic PR number when a later failure could not locate it', async () => {
        const redis = fakeRedis();
        await recordEpicProgressRetry(redis as never, target, 1_000);
        await recordEpicProgressRetry(redis as never, { ...target, epicPrNumber: null, mergedChildPrNumber: 204 }, 2_000);
        const retry = JSON.parse(redis.hash.get(field)!);
        assert.equal(retry.epicPrNumber, 500);
        assert.equal(retry.mergedChildPrNumber, 204);
        assert.equal(retry.attempts, 2);
    });
});

describe('sweepEpicProgressRetries', () => {
    test('retries an obligation whose epic PR is not known yet', async () => {
        const redis = fakeRedis();
        await recordEpicProgressRetry(redis as never, { ...target, epicPrNumber: null }, 0);
        const retried: EpicProgressTarget[] = [];
        await sweepEpicProgressRetries({
            redis: redis as never, log, now: () => 10 * 60 * 1000,
            retry: async pending => { retried.push(pending); return 'updated'; },
        });
        assert.deepEqual(retried, [{ ...target, epicPrNumber: null }]);
    });

    test('drops a retry that has failed beyond the maximum age', async () => {
        const redis = fakeRedis();
        redis.hash.set(field, JSON.stringify({ ...target, attempts: 40, firstFailedAt: 0, nextAttemptAt: 0 }));
        let retries = 0;
        await sweepEpicProgressRetries({
            redis: redis as never, log, now: () => EPIC_PROGRESS_RETRY_MAX_AGE_MS + 1,
            retry: async () => { retries++; return 'updated'; },
        });
        assert.equal(retries, 0);
        assert.equal(redis.hash.size, 0);
    });
});
