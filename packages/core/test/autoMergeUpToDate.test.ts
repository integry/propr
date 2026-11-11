import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/db/connection.js', { namedExports: { db: () => { throw new Error('no database in this suite'); }, closeConnection: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('use the fake client'); } } });

const { ensureUpToDateBeforeMerge, noteCiWaitAfterBranchUpdate, BRANCH_UPDATE_PENDING_MS } = await import('../src/webhook/autoMergeUpToDate.js');
type Deps = import('../src/webhook/autoMergeUpToDate.js').UpToDateDependencies;

/** In-memory Redis with the commands the up-to-date gate uses (TTLs are not simulated). */
function fakeRedis() {
    const values = new Map<string, string>();
    const sets = new Map<string, Map<string, number>>();
    return {
        values,
        async get(key: string) { return values.get(key) ?? null; },
        async set(key: string, value: string, _ex: 'EX', _seconds: number, nx?: 'NX') {
            if (nx && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        },
        async del(key: string) { return values.delete(key) ? 1 : 0; },
        async expire() { return 1; },
        async zadd(key: string, score: number, member: string) { (sets.get(key) ?? sets.set(key, new Map()).get(key)!).set(member, score); return 1; },
        async zrange(key: string) { return [...(sets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member); },
        async zrem(key: string, member: string) { return sets.get(key)?.delete(member) ? 1 : 0; },
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
