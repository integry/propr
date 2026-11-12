import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/db/connection.js', { namedExports: { db: () => { throw new Error('no database in this suite'); }, closeConnection: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('use the fake client'); } } });

const {
    ensureUpToDateBeforeMerge, mergeWhenUpToDate, noteCiWaitAfterBranchUpdate, BRANCH_UPDATE_PENDING_MS, UPDATE_TURN_TTL_SECONDS, MERGE_OWNERSHIP_TTL_SECONDS,
} = await import('../src/webhook/autoMergeUpToDate.js');
const { loadDeferredUpToDateCandidates, settleDeferredUpToDateCandidate, DEFERRED_RETRY_MAX_AGE_MS } = await import('../src/webhook/autoMergeUpToDateRetry.js');
type Deps = import('../src/webhook/autoMergeUpToDate.js').UpToDateDependencies;

/**
 * In-memory Redis with the commands the up-to-date gate uses. TTLs are simulated
 * against the test clock only with `expiring`; other tests keep every key.
 */
function fakeRedis(options: { expiring?: boolean } = {}) {
    const values = new Map<string, string>();
    const expiresAt = new Map<string, number>();
    const sets = new Map<string, Map<string, number>>();
    const live = (key: string) => {
        if (options.expiring && (expiresAt.get(key) ?? Infinity) <= clock) {
            values.delete(key);
            expiresAt.delete(key);
        }
        return values.has(key);
    };
    return {
        values,
        async get(key: string) { return live(key) ? values.get(key)! : null; },
        async set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX') {
            if (nx && live(key)) return null;
            values.set(key, value);
            expiresAt.set(key, clock + seconds * 1000);
            return 'OK';
        },
        async del(key: string) { expiresAt.delete(key); return values.delete(key) ? 1 : 0; },
        async expire(key: string, seconds: number) {
            if (!live(key)) return 0;
            expiresAt.set(key, clock + seconds * 1000);
            return 1;
        },
        async zadd(key: string, score: number, member: string) { (sets.get(key) ?? sets.set(key, new Map()).get(key)!).set(member, score); return 1; },
        async zrange(key: string, _start: number, _stop: number, withScores?: 'WITHSCORES') {
            const sorted = [...(sets.get(key) ?? new Map<string, number>()).entries()].sort((a, b) => a[1] - b[1]);
            return withScores ? sorted.flatMap(([member, score]) => [member, String(score)]) : sorted.map(([member]) => member);
        },
        async zrem(key: string, member: string) { return sets.get(key)?.delete(member) ? 1 : 0; },
        /** The token-checked renew/release and the deferred-settle scripts, by their commands. */
        async eval(script: string, _keys: number, key: string, ...args: Array<string | number>) {
            if (script.includes('zscore')) {
                const score = sets.get(key)?.get(String(args[0]));
                return score !== undefined && score <= Number(args[1]) && sets.get(key)!.delete(String(args[0])) ? 1 : 0;
            }
            if (!live(key) || values.get(key) !== String(args[0])) return 0;
            if (script.includes("'expire'")) { expiresAt.set(key, clock + Number(args[1]) * 1000); return 1; }
            if (script.includes("'del'")) { expiresAt.delete(key); values.delete(key); return 1; }
            throw new Error('unexpected script');
        },
    };
}

interface FakePR { behindBy: number; state?: string; updateError?: { status: number; message: string } }

/** A fake GitHub that records branch updates and comments. */
function fakeGitHub(prs: Record<number, FakePR>) {
    const updates: Array<{ pull_number: number; expected_head_sha: string }> = [];
    const comments: Array<{ issue_number: number; body: string }> = [];
    const octokit = {
        async request(route: string, params: Record<string, unknown> = {}) {
            if (route.startsWith('GET /repos/{owner}/{repo}/compare/')) {
                const prNumber = Number(/\d+/.exec(String(params.basehead).split('...')[1])?.[0]);
                if (!prs[prNumber]) throw Object.assign(new Error('Not Found'), { status: 404 });
                return { data: { behind_by: prs[prNumber].behindBy, base_commit: { sha: 'base-sha' } } };
            }
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { state: prs[params.pull_number as number]?.state ?? 'open' } };
            }
            if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch') {
                const pr = prs[params.pull_number as number];
                if (pr.updateError) throw Object.assign(new Error(pr.updateError.message), { status: pr.updateError.status });
                updates.push({ pull_number: params.pull_number as number, expected_head_sha: params.expected_head_sha as string });
                return { data: { message: 'Updating pull request branch.' } };
            }
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
                comments.push({ issue_number: params.issue_number as number, body: params.body as string });
                return { data: {} };
            }
            throw new Error(`unexpected route ${route}`);
        },
    };
    return { octokit, updates, comments };
}

let redis: ReturnType<typeof fakeRedis>;
let decisions: Array<{ prNumber: number; reason: string; action?: string; detail?: string; headSha?: string }>;
let clock: number;
const settings = { maxBranchUpdatesPerHour: 3 };
const target = (prNumber: number, headSha = `head-${prNumber}`) => ({ owner: 'Org', repo: 'Repo', prNumber, headSha, baseRef: 'main' });

function deps(github: ReturnType<typeof fakeGitHub>, extra: Partial<Deps> = {}): Deps {
    return {
        redis, octokit: github.octokit, now: () => clock,
        recordDecision: async input => {
            decisions.push({ prNumber: input.prNumber, reason: input.decision.reason, action: input.action, detail: input.decision.detail, headSha: input.headSha });
            return true;
        },
        queueConflictResolution: async () => ({ queued: false, reason: 'auto_resolve_disabled' }),
        checksFailed: async () => false,
        ...extra,
    };
}

beforeEach(() => {
    redis = fakeRedis();
    decisions = [];
    clock = 1_000_000_000;
});

test('an up-to-date head may merge without a branch update', async () => {
    const github = fakeGitHub({ 7: { behindBy: 0 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'up_to_date');
    assert.equal(github.updates.length, 0);
    assert.equal(decisions.length, 0);
});

test('a behind head is updated with its expected SHA instead of merged, and is not updated twice', async () => {
    const github = fakeGitHub({ 7: { behindBy: 2 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'updated');
    assert.deepEqual(github.updates, [{ pull_number: 7, expected_head_sha: 'head-7' }]);
    assert.deepEqual(decisions.map(d => [d.reason, d.action]), [['updated_branch', 'branch_updated']]);

    // The update has not produced a new head yet: wait, do not request again or merge.
    clock += 60_000;
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'waiting');
    assert.equal(github.updates.length, 1);
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_pending');
});

test('the updated head waits for CI, records it once, and merges once it contains the base', async () => {
    const github = fakeGitHub({ 7: { behindBy: 1 } });
    await ensureUpToDateBeforeMerge(target(7), settings, deps(github));
    // The old head is not "the updated head".
    await noteCiWaitAfterBranchUpdate(target(7), deps(github));
    assert.equal(decisions.length, 1);
    for (let i = 0; i < 3; i++) await noteCiWaitAfterBranchUpdate(target(7, 'updated-head'), deps(github));
    assert.deepEqual(decisions.map(d => d.reason), ['updated_branch', 'waiting_for_ci_updated_head']);
    assert.equal(decisions[1].headSha, 'updated-head');

    // CI passed on the updated head, which now contains the base commit.
    const updated = fakeGitHub({ 7: { behindBy: 0 } });
    const compareOnUpdated = { request: (route: string, params: Record<string, unknown> = {}) =>
        updated.octokit.request(route, { ...params, ...(params.basehead ? { basehead: 'main...head-7' } : {}) }) };
    assert.equal(await ensureUpToDateBeforeMerge(target(7, 'updated-head'), settings, deps(updated, { octokit: compareOnUpdated })), 'up_to_date');
    assert.equal([...redis.values.keys()].some(key => key.includes(':turn:') || key.includes(':marker:')), false, 'the turn and marker are released');
});

test('per-repository updates are serialised: only the oldest eligible PR is updated', async () => {
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 }, 12: { behindBy: 1 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(5), settings, deps(github)), 'updated');
    // PR 5 holds the turn while its updated head runs CI.
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'waiting');
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_serialized');
    assert.match(decisions.at(-1)?.detail ?? '', /PR #5/);

    // PR 5 is merged outside the queue; PR 12 must still wait for the older PR 10.
    github.octokit.request = (original => async (route: string, params: Record<string, unknown> = {}) =>
        route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && params.pull_number === 5 ? { data: { state: 'closed' } } : original(route, params))(github.octokit.request);
    assert.equal(await ensureUpToDateBeforeMerge(target(12), settings, deps(github)), 'waiting');
    assert.match(decisions.at(-1)?.detail ?? '', /PR #10 \(older\)/);
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'updated');
    assert.deepEqual(github.updates.map(update => update.pull_number), [5, 10]);
});

test('a repeated wait is recorded once per head and base', async () => {
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 } });
    await ensureUpToDateBeforeMerge(target(5), settings, deps(github));
    for (let i = 0; i < 5; i++) await ensureUpToDateBeforeMerge(target(10), settings, deps(github));
    assert.equal(decisions.filter(d => d.prNumber === 10).length, 1);
});

test('updates are rate-limited per PR, and a rate-limited PR gives up its turn', async () => {
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 } });
    const limit = { maxBranchUpdatesPerHour: 2 };
    for (let i = 0; i < 2; i++) {
        assert.equal(await ensureUpToDateBeforeMerge(target(5, `head-5-${i}`), limit, deps(github)), 'updated');
        clock += 60_000;
    }
    // The base moved again after the second update.
    assert.equal(await ensureUpToDateBeforeMerge(target(5, 'head-5-2'), limit, deps(github)), 'waiting');
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_rate_limited');
    assert.equal(github.updates.length, 2);
    // The next PR is not held up by the rate-limited one.
    assert.equal(await ensureUpToDateBeforeMerge(target(10), limit, deps(github)), 'updated');

    // An hour later PR 5 may be updated again.
    clock += 60 * 60_000;
    await noteCiWaitAfterBranchUpdate(target(10, 'updated-10'), deps(github, { checksFailed: async () => true }));
    assert.equal(await ensureUpToDateBeforeMerge(target(5, 'head-5-2'), limit, deps(github)), 'updated');
});

test('waiting for CI on the same updated head does not renew the turn: it expires an hour after the update', async () => {
    redis = fakeRedis({ expiring: true });
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(5), settings, deps(github)), 'updated');
    // The sweep sees PR 5's updated head still pending every minute, and PR 10 waits.
    const minutes = UPDATE_TURN_TTL_SECONDS / 60;
    for (let minute = 1; minute < minutes; minute++) {
        clock += 60_000;
        await noteCiWaitAfterBranchUpdate(target(5, 'updated-5'), deps(github));
        assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'waiting', `minute ${minute}`);
    }
    assert.deepEqual(github.updates.map(update => update.pull_number), [5]);

    // An hour after PR 5's last update, polling alone no longer holds the turn.
    clock += 60_000;
    await noteCiWaitAfterBranchUpdate(target(5, 'updated-5'), deps(github));
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'updated');
    assert.deepEqual(github.updates.map(update => update.pull_number), [5, 10]);
});

test('a new branch update by the turn holder is progress and renews its turn', async () => {
    redis = fakeRedis({ expiring: true });
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(5), settings, deps(github)), 'updated');
    // The base moved again 50 minutes later: PR 5's updated head is updated once more.
    clock += 50 * 60_000;
    assert.equal(await ensureUpToDateBeforeMerge(target(5, 'updated-5'), settings, deps(github)), 'updated');
    clock += 50 * 60_000;
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'waiting', 'the turn lasts an hour from the latest update');
    clock += 10 * 60_000;
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'updated');
});

test('failed CI on the updated head ends the PR\'s turn so the next PR can be updated', async () => {
    const github = fakeGitHub({ 5: { behindBy: 1 }, 10: { behindBy: 1 } });
    await ensureUpToDateBeforeMerge(target(5), settings, deps(github));
    await noteCiWaitAfterBranchUpdate(target(5, 'updated-5'), deps(github, { checksFailed: async () => true }));
    assert.equal(decisions.at(-1)?.reason, 'waiting_for_ci_updated_head');
    assert.match(decisions.at(-1)?.detail ?? '', /failed/);
    assert.equal(await ensureUpToDateBeforeMerge(target(10), settings, deps(github)), 'updated');
});

test('a conflicting update uses the opt-in conflict resolution when it is enabled', async () => {
    const github = fakeGitHub({ 7: { behindBy: 1, updateError: { status: 422, message: 'merge conflict between base and head' } } });
    const queueConflictResolution = mock.fn(async () => ({ queued: true }));
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github, { queueConflictResolution })), 'waiting');
    assert.equal(queueConflictResolution.mock.callCount(), 1);
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_conflict');
    assert.match(decisions.at(-1)?.detail ?? '', /queued/);
    assert.equal(github.comments.length, 0);
});

test('a conflicting update without conflict resolution comments why auto-merge is waiting, once', async () => {
    const github = fakeGitHub({ 7: { behindBy: 1, updateError: { status: 422, message: 'merge conflict between base and head' } } });
    for (let i = 0; i < 2; i++) {
        clock += BRANCH_UPDATE_PENDING_MS;
        assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'waiting');
    }
    assert.equal(github.comments.length, 1);
    assert.equal(github.comments[0].issue_number, 7);
    assert.match(github.comments[0].body, /Auto-merge waiting/);
    assert.match(github.comments[0].body, /waiting_branch_update_conflict/);
    assert.match(github.comments[0].body, /require_up_to_date/);
    assert.equal(github.comments[0].body.includes('\n'), false);
});

test('a head that moved before the update and an unavailable comparison never merge', async () => {
    const moved = fakeGitHub({ 7: { behindBy: 1, updateError: { status: 422, message: 'expected head sha didn\'t match current head ref.' } } });
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(moved)), 'waiting');
    assert.equal(decisions.length, 0);
    assert.equal([...redis.values.keys()].some(key => key.includes(':turn:')), false);

    const unavailable = fakeGitHub({});
    assert.equal(await ensureUpToDateBeforeMerge(target(9), settings, deps(unavailable)), 'waiting');
    assert.equal(decisions.at(-1)?.reason, 'waiting_base_comparison_unavailable');
});

test('another update failure is recorded and releases the turn', async () => {
    const github = fakeGitHub({ 7: { behindBy: 1, updateError: { status: 403, message: 'Resource not accessible by integration' } }, 8: { behindBy: 1 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'waiting');
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_failed');
    assert.equal(await ensureUpToDateBeforeMerge(target(8), settings, deps(github)), 'updated');
});

test('overlapping current heads are serialised from comparison through merge; the later one compares against the merged base', async () => {
    const prs: Record<number, FakePR> = { 7: { behindBy: 0 }, 8: { behindBy: 0 } };
    const github = fakeGitHub(prs);
    const compared: number[] = [];
    let releaseCompare!: () => void;
    const compareInFlight = new Promise<void>(resolve => { releaseCompare = resolve; });
    const request = github.octokit.request.bind(github.octokit);
    github.octokit.request = async (route: string, params: Record<string, unknown> = {}) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/compare/')) {
            const prNumber = Number(/\d+/.exec(String(params.basehead).split('...')[1])?.[0]);
            compared.push(prNumber);
            // PR 7's comparison is still awaiting GitHub while PR 8 is evaluated.
            if (prNumber === 7) await compareInFlight;
        }
        return request(route, params);
    };
    const merged: number[] = [];
    const merge = (prNumber: number) => async () => {
        merged.push(prNumber);
        // Merging advances the base: the other PR no longer contains it.
        for (const other of Object.keys(prs)) if (Number(other) !== prNumber) prs[Number(other)].behindBy = 1;
    };

    const first = mergeWhenUpToDate(target(7), settings, merge(7), deps(github));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(compared, [7]);
    assert.equal(await mergeWhenUpToDate(target(8), settings, merge(8), deps(github)), 'waiting');
    assert.deepEqual(compared, [7], 'PR 8 is not compared while PR 7 owns the comparison-through-merge');
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_serialized');
    assert.match(decisions.at(-1)?.detail ?? '', /PR #7/);
    releaseCompare();
    assert.equal(await first, 'up_to_date');
    assert.deepEqual(merged, [7]);

    // The next evaluation of PR 8 compares against the base PR 7's merge produced.
    assert.equal(await mergeWhenUpToDate(target(8), settings, merge(8), deps(github)), 'updated');
    assert.deepEqual(compared, [7, 8]);
    assert.deepEqual(merged, [7], 'PR 8 is updated, not merged, after the base moved');
    assert.deepEqual(github.updates, [{ pull_number: 8, expected_head_sha: 'head-8' }]);
});

test('merge ownership is released after a failed merge, and never released on another holder\'s behalf', async () => {
    const github = fakeGitHub({ 7: { behindBy: 0 }, 8: { behindBy: 0 } });
    await assert.rejects(mergeWhenUpToDate(target(7), settings, async () => { throw new Error('merge refused'); }, deps(github)), /merge refused/);
    let merged = 0;
    assert.equal(await mergeWhenUpToDate(target(8), settings, async () => { merged++; }, deps(github)), 'up_to_date');
    assert.equal(merged, 1);

    // PR 7's ownership expired mid-merge and PR 8 took it over: PR 7 must not release PR 8's.
    const ownership = 'auto-merge:up-to-date:merging:org/repo';
    await mergeWhenUpToDate(target(7), settings, async () => { redis.values.set(ownership, '8:other'); }, deps(github));
    assert.equal(redis.values.get(ownership), '8:other');
});

// ---- F5: deferred candidates are retried without another webhook ----

const deferred = () => loadDeferredUpToDateCandidates({ redis, now: () => clock });

test('a candidate deferred behind another PR\'s turn is recorded for retry, plan PR or not, and merges on the retry', async () => {
    const prs: Record<number, FakePR> = { 5: { behindBy: 1 }, 10: { behindBy: 1 } };
    const github = fakeGitHub(prs);
    const merged: number[] = [];
    const merge = (prNumber: number) => async () => { merged.push(prNumber); };
    assert.equal(await mergeWhenUpToDate(target(5), settings, merge(5), deps(github)), 'updated');
    // PR 10's last green check arrives while PR 5 holds the turn: it waits and gets no further event.
    assert.equal(await mergeWhenUpToDate(target(10), settings, merge(10), deps(github)), 'waiting');
    assert.equal(decisions.at(-1)?.reason, 'waiting_branch_update_serialized');
    const retries = await deferred();
    assert.deepEqual(retries.map(r => [r.repository, r.prNumber]), [['Org/Repo', 5], ['Org/Repo', 10]]);

    // PR 5 merges (outside this PR's evaluation) and leaves the turn.
    prs[5].behindBy = 0;
    clock += 60_000;
    assert.equal(await mergeWhenUpToDate(target(5, 'updated-5'), settings, merge(5), deps(github)), 'up_to_date');
    github.octokit.request = (original => async (route: string, params: Record<string, unknown> = {}) =>
        route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && params.pull_number === 5 ? { data: { state: 'closed' } } : original(route, params))(github.octokit.request);

    // The sweep's retry of PR 10 is the guarded merge path again: PR 10 is updated now, then merges once current.
    clock += 60_000;
    const pr10 = (await deferred()).find(r => r.prNumber === 10)!;
    assert.equal(await mergeWhenUpToDate(target(10), settings, merge(10), deps(github)), 'updated');
    await settleDeferredUpToDateCandidate(pr10, { redis });
    assert.ok((await deferred()).some(r => r.prNumber === 10), 'deferred again by the retry, so it stays for the next sweep');
    prs[10].behindBy = 0;
    clock += 60_000;
    const again = (await deferred()).find(r => r.prNumber === 10)!;
    assert.equal(await mergeWhenUpToDate(target(10, 'updated-10'), settings, merge(10), deps(github)), 'up_to_date');
    await settleDeferredUpToDateCandidate(again, { redis });
    assert.deepEqual(merged, [5, 10]);
    assert.equal((await deferred()).some(r => r.prNumber === 10), false, 'settled once a retry did not defer it again');
});

test('a candidate that found the merge ownership taken is recorded for retry', async () => {
    const github = fakeGitHub({ 8: { behindBy: 0 } });
    redis.values.set('auto-merge:up-to-date:merging:org/repo', '7:other');
    assert.equal(await mergeWhenUpToDate(target(8), settings, async () => { throw new Error('must not merge'); }, deps(github)), 'waiting');
    assert.deepEqual((await deferred()).map(r => r.prNumber), [8]);
});

test('a conflicting update is not retried by the sweep; stale retry entries age out', async () => {
    const github = fakeGitHub({ 7: { behindBy: 1, updateError: { status: 422, message: 'merge conflict between base and head' } }, 8: { behindBy: 1 } });
    assert.equal(await ensureUpToDateBeforeMerge(target(7), settings, deps(github)), 'waiting');
    assert.deepEqual(await deferred(), []);
    assert.equal(await ensureUpToDateBeforeMerge(target(8), settings, deps(github)), 'updated');
    assert.deepEqual((await deferred()).map(r => r.prNumber), [8]);
    clock += DEFERRED_RETRY_MAX_AGE_MS + 1;
    assert.deepEqual(await deferred(), []);
});

// ---- F6: a holder that lost its merge ownership does not merge ----

test('an attempt whose ownership expired after the comparison does not merge; it compares again on the retry', async () => {
    redis = fakeRedis({ expiring: true });
    const prs: Record<number, FakePR> = { 7: { behindBy: 0 }, 8: { behindBy: 0 } };
    const github = fakeGitHub(prs);
    const merged: number[] = [];
    let resumeA!: () => void;
    const suspendedA = new Promise<void>(resolve => { resumeA = resolve; });
    const advanceBase = (prNumber: number) => { for (const other of Object.keys(prs)) if (Number(other) !== prNumber) prs[Number(other)].behindBy = 1; };

    // PR 7 compares against base X, then is suspended (e.g. resolving the merge method) beyond the ownership TTL.
    const first = mergeWhenUpToDate(target(7), settings, async stillOwned => {
        await suspendedA;
        if (!await stillOwned()) return;
        merged.push(7);
        advanceBase(7);
    }, deps(github, { ownershipRenewIntervalMs: 60 * 60_000 }));
    await new Promise(resolve => setImmediate(resolve));
    clock += MERGE_OWNERSHIP_TTL_SECONDS * 1000 + 1;

    // PR 8 takes the expired ownership, compares against X and merges, advancing the base.
    assert.equal(await mergeWhenUpToDate(target(8), settings, async stillOwned => {
        assert.equal(await stillOwned(), true);
        merged.push(8);
        advanceBase(8);
    }, deps(github)), 'up_to_date');

    resumeA();
    assert.equal(await first, 'waiting', 'PR 7 lost the ownership and does not merge on its stale comparison');
    assert.deepEqual(merged, [8]);
    assert.match(decisions.at(-1)?.detail ?? '', /ownership expired/);
    assert.ok((await deferred()).some(r => r.prNumber === 7), 'PR 7 is retried');

    // The retry reacquires the ownership, compares again against the new base, and updates instead of merging.
    assert.equal(await mergeWhenUpToDate(target(7), settings, async () => { merged.push(7); }, deps(github)), 'updated');
    assert.deepEqual(merged, [8]);
    assert.deepEqual(github.updates, [{ pull_number: 7, expected_head_sha: 'head-7' }]);
});

test('a live holder renews its ownership with its token while it works', async () => {
    redis = fakeRedis({ expiring: true });
    const github = fakeGitHub({ 7: { behindBy: 0 }, 8: { behindBy: 0 } });
    const ownership = 'auto-merge:up-to-date:merging:org/repo';
    let release!: () => void;
    const working = new Promise<void>(resolve => { release = resolve; });
    let ownedAtMerge: boolean | undefined;
    const first = mergeWhenUpToDate(target(7), settings, async stillOwned => {
        await working;
        ownedAtMerge = await stillOwned();
    }, deps(github, { ownershipRenewIntervalMs: 5 }));
    await new Promise(resolve => setImmediate(resolve));
    // Most of the TTL passes; the renewal timer extends it from the current clock.
    clock += (MERGE_OWNERSHIP_TTL_SECONDS - 1) * 1000;
    await new Promise(resolve => setTimeout(resolve, 30));
    clock += 2 * 1000;
    assert.match(await redis.get(ownership) ?? '', /^7:/, 'still owned past the original expiry');
    assert.equal(await mergeWhenUpToDate(target(8), settings, async () => { throw new Error('must not merge'); }, deps(github)), 'waiting');
    release();
    assert.equal(await first, 'up_to_date');
    assert.equal(ownedAtMerge, true);
    assert.equal(await redis.get(ownership), null, 'released with its token');
});
