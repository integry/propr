import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    isCiFailureFollowupComment, postCiFailureFollowup, stripCiFailureFollowupMarker, type CiFailureFollowupRequest,
} from '../packages/core/src/webhook/ciFailureFollowup.js';
import {
    dropAggregatesWithListedShards, isAggregateOfShard, parseCiFailureEntries,
} from '../packages/core/src/webhook/ciFailureHeadComment.js';

after(async () => {
    await closeConnection();
});

const SHA = '91f89c3b90123456789abcdef0123456789abcde';

function failure(name: string, runId: number, sha = SHA): CiFailureFollowupRequest {
    return {
        owner: 'integry', repo: 'propr', prNumber: 3434,
        evidence: {
            kind: 'status', name, state: 'failure', sha,
            url: `https://github.com/integry/propr/actions/runs/${runId}/job/${runId}`,
            source: `status:${name}`, fallbackExcerpt: `${name} failed: expected 1 but got 2`,
        },
    };
}

function createRedis() {
    const values = new Map<string, string>();
    return {
        values,
        get: mock.fn(async (key: string) => values.get(key) ?? null),
        set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
}

/** PR comments as GitHub stores them, authored by the ProPR bot. */
function fakeGitHub() {
    const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    const posts: string[] = [];
    const patches: string[] = [];
    const octokit = {
        paginate: mock.fn(async () => comments),
        request: mock.fn(async (route: string, params: Record<string, unknown>) => {
            if (route.startsWith('POST ')) {
                const comment = { id: 500 + comments.length, body: String(params.body), user: { login: 'propr-dev[bot]' } };
                comments.push(comment);
                posts.push(comment.body);
                return { data: comment };
            }
            if (route === 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}') {
                const comment = comments.find(item => item.id === params.comment_id);
                if (!comment) throw new Error('HTTP 404');
                return { data: comment };
            }
            if (route.startsWith('PATCH ')) {
                const comment = comments.find(item => item.id === params.comment_id)!;
                comment.body = String(params.body);
                patches.push(comment.body);
                return { data: comment };
            }
            return { data: {} };
        }),
    };
    return { octokit, comments, posts, patches };
}

function dependencies(gh: ReturnType<typeof fakeGitHub>, redis = createRedis()) {
    return {
        isEnabled: async () => true,
        getOctokit: async () => gh.octokit,
        redisClient: redis as never,
        timing: { sleep: async () => undefined, lockWaitMs: 1000 },
    };
}

describe('one CI-failure comment per head commit (#3622 point 4)', () => {
    test('eight failing jobs of one commit produce one comment listing each of them', async () => {
        const gh = fakeGitHub();
        const deps = dependencies(gh);
        const results = [];
        for (let shard = 1; shard <= 8; shard++) {
            results.push(await postCiFailureFollowup(failure(`Lint ${shard}`, 1000 + shard), `ci-${shard}`, deps));
        }
        assert.equal(gh.posts.length, 1);
        assert.equal(results.filter(result => result.posted).length, 1);
        assert.equal(results.filter(result => result.reason === 'merged').length, 7);
        const entries = parseCiFailureEntries(gh.comments[0].body);
        assert.deepEqual(entries.map(entry => entry.name), Array.from({ length: 8 }, (_, index) => `Lint ${index + 1}`));
        assert.match(gh.comments[0].body, /CI failed: \*\*8 checks\*\*/);
    });

    test('concurrent failures of one head still merge into one comment', async () => {
        const gh = fakeGitHub();
        const deps = dependencies(gh);
        await Promise.all([1, 2, 3, 4].map(index => postCiFailureFollowup(failure(`Job ${index}`, index), `c-${index}`, deps)));
        assert.equal(gh.posts.length, 1);
        assert.equal(parseCiFailureEntries(gh.comments[0].body).length, 4);
    });

    test('the Commit link points to the commit, and the check links point to the job', async () => {
        const gh = fakeGitHub();
        await postCiFailureFollowup(failure('Lint', 7), 'link', dependencies(gh));
        const body = gh.posts[0];
        assert.ok(body.includes(`- Commit: [\`${SHA.slice(0, 12)}\`](https://github.com/integry/propr/commit/${SHA})`));
        assert.ok(body.includes('[View CI failure](https://github.com/integry/propr/actions/runs/7/job/7)'));
    });

    test('an aggregate job is not listed next to its own failing shard, in either order', async () => {
        const shardFirst = fakeGitHub();
        const shardDeps = dependencies(shardFirst);
        await postCiFailureFollowup(failure('Full Test Suite Shard 2/4', 1), 'shard', shardDeps);
        const aggregate = await postCiFailureFollowup(failure('Run Full Test Suite', 2), 'aggregate', shardDeps);
        assert.deepEqual({ posted: aggregate.posted, reason: aggregate.reason }, { posted: false, reason: 'duplicate' });
        assert.deepEqual(parseCiFailureEntries(shardFirst.comments[0].body).map(entry => entry.name), ['Full Test Suite Shard 2/4']);

        const aggregateFirst = fakeGitHub();
        const aggregateDeps = dependencies(aggregateFirst);
        await postCiFailureFollowup(failure('Run Full Test Suite', 3), 'aggregate-first', aggregateDeps);
        await postCiFailureFollowup(failure('Full Test Suite Shard 1/4', 4), 'shard-later', aggregateDeps);
        assert.deepEqual(parseCiFailureEntries(aggregateFirst.comments[0].body).map(entry => entry.name), ['Full Test Suite Shard 1/4']);
    });

    test('a new head commit gets its own comment', async () => {
        const gh = fakeGitHub();
        const deps = dependencies(gh);
        await postCiFailureFollowup(failure('Lint', 1), 'a', deps);
        await postCiFailureFollowup(failure('Lint', 2, 'b'.repeat(40)), 'b', deps);
        assert.equal(gh.posts.length, 2);
    });

    test('the comment still triggers a follow-up and its entry markers never reach the agent', async () => {
        const gh = fakeGitHub();
        await postCiFailureFollowup(failure('Lint', 1), 'strip', dependencies(gh));
        assert.ok(isCiFailureFollowupComment(gh.posts[0]));
        assert.doesNotMatch(stripCiFailureFollowupMarker(gh.posts[0]), /propr:ci-failure/);
    });

    test('aggregate detection follows shard and matrix designators only', () => {
        assert.ok(isAggregateOfShard('Run Full Test Suite', 'Full Test Suite Shard 3/4'));
        assert.ok(isAggregateOfShard('Unit tests', 'Unit tests (2, 4)'));
        assert.equal(isAggregateOfShard('Lint', 'Full Test Suite Shard 3/4'), false);
        assert.equal(isAggregateOfShard('Full Test Suite Shard 1/4', 'Full Test Suite Shard 3/4'), false);
        assert.deepEqual(
            dropAggregatesWithListedShards([{ name: 'Run Full Test Suite' }, { name: 'Full Test Suite Shard 1/4' }, { name: 'Lint' }]).map(entry => entry.name),
            ['Full Test Suite Shard 1/4', 'Lint'],
        );
    });

    test('a failure that cannot get the head lock from a live publisher defers instead of publishing unlocked (F3)', async () => {
        const gh = fakeGitHub();
        const redis = createRedis();
        // Publisher A holds the head lock (its TTL has not lapsed) while it talks to GitHub.
        const lockKey = 'ci-failure-followup-head-lock:';
        const deps = { ...dependencies(gh, redis), timing: { sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, lockWaitMs: 20 } };
        const original = redis.set.mock.calls.length;
        await postCiFailureFollowup(failure('Lint', 1), 'a', dependencies(gh, redis));
        const heldKey = [...redis.values.keys()].find(key => key.startsWith(lockKey));
        assert.equal(heldKey, undefined, 'A released its lock');
        const headLockKey = redis.set.mock.calls.slice(original).map(call => String(call.arguments[0])).find(key => key.startsWith(lockKey))!;
        redis.values.set(headLockKey, 'publisher-a');

        await assert.rejects(postCiFailureFollowup(failure('Typecheck', 2), 'b', deps), { name: 'CiFailureHeadLockTimeoutError' });
        assert.equal(gh.posts.length, 1, 'no second comment');
        assert.equal(gh.patches.length, 0, 'no unlocked merge');
        assert.equal([...redis.values.keys()].filter(key => key !== headLockKey && !key.startsWith('ci-failure-followup-head:')).length, 1,
            'only the first check keeps its per-source claim; the deferred one can be delivered again');

        // Once A releases, a redelivery of B merges into the one comment.
        redis.values.delete(headLockKey);
        const retried = await postCiFailureFollowup(failure('Typecheck', 2), 'b-again', dependencies(gh, redis));
        assert.equal(retried.reason, 'merged');
        assert.deepEqual(parseCiFailureEntries(gh.comments[0].body).map(entry => entry.name), ['Lint', 'Typecheck']);
    });

    test('a publisher that lost the head lock before writing does not write (F3)', async () => {
        const gh = fakeGitHub();
        const redis = createRedis();
        await postCiFailureFollowup(failure('Lint', 1), 'first', dependencies(gh, redis));
        const request = gh.octokit.request.mock.calls.length;
        const paginate = gh.octokit.paginate;
        // While this publisher reads the comment, its lock lapses and another publisher takes it.
        gh.octokit.paginate = mock.fn(async () => {
            for (const key of redis.values.keys()) if (key.startsWith('ci-failure-followup-head-lock:')) redis.values.set(key, 'publisher-c');
            return paginate();
        });
        redis.values.forEach((_value, key) => { if (key.startsWith('ci-failure-followup-head:')) redis.values.delete(key); });
        await assert.rejects(postCiFailureFollowup(failure('Typecheck', 2), 'second', dependencies(gh, redis)), { name: 'CiFailureHeadLockLostError' });
        assert.equal(gh.patches.length, 0);
        assert.equal(gh.posts.length, 1);
        assert.ok(gh.octokit.request.mock.calls.length >= request);
        const lock = [...redis.values.entries()].find(([key]) => key.startsWith('ci-failure-followup-head-lock:'));
        assert.equal(lock?.[1], 'publisher-c', 'the other publisher\'s lock is left alone');
    });
});

