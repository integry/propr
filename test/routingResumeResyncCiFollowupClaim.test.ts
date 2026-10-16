import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';

// Strict CI-failure recovery: the Redis NX claim excludes concurrent producers
// but does not prove a follow-up was published. A claim suppresses publication
// in strict mode only with a published claim or the bot's marked comment;
// otherwise the pull_request_heads family stays unfinished and retries.

let comments: Array<{ body: string; user: { login: string } }> = [];
let commentListError: Error | null = null;
const posted: string[] = [];
const octokit = {
    paginate: async (route: string) => {
        if (route.endsWith('/check-runs')) return [{ id: 1, name: 'build', status: 'completed', conclusion: 'failure', output: { summary: 'boom' } }];
        if (route.endsWith('/statuses')) return [];
        if (route.endsWith('/comments')) {
            if (commentListError) throw commentListError;
            return comments;
        }
        return [];
    },
    request: async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('POST ')) {
            posted.push(String(params.body));
            comments.push({ body: String(params.body), user: { login: 'propr-dev[bot]' } });
            return { data: {} };
        }
        return { data: { state: 'open', head: { sha: 'h7' } } };
    },
};

/** Redis with real NX and TTL semantics; `lapse` lets every TTL elapse. */
const values = new Map<string, { value: string; ttl: number | null }>();
const redis = {
    get: mock.fn(async (key: string) => values.get(key)?.value ?? null),
    set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
        if (args.includes('NX') && values.has(key)) return null;
        const ex = args.indexOf('EX');
        values.set(key, { value, ttl: ex === -1 ? null : Number(args[ex + 1]) });
        return 'OK';
    }),
    del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
};
function lapse(maxTtl: number): void {
    for (const [key, entry] of values) if (entry.ttl !== null && entry.ttl <= maxTtl) values.delete(key);
}

async function mockModule(specifier: string, overrides: Record<string, unknown>): Promise<void> {
    const real = await import(specifier) as Record<string, unknown>;
    await mock.module(specifier, { namedExports: { ...real, ...overrides } });
}
await mockModule('../packages/core/src/auth/githubAuth.js', { getAuthenticatedOctokit: async () => octokit });
await mockModule('../packages/core/src/daemon/configLoader.js', {
    isAutoCiFollowupEnabledForRepository: async () => true,
    getNonBlockingChecksForRepository: async () => [],
});
await mockModule('../packages/core/src/webhook/checkRunHelpers.js', { getUltrafixStateRedis: () => redis });

const { buildCiFailureDedupeKey, postCiFailureFollowup } = await import('../packages/core/src/webhook/ciFailureFollowup.js');
const { recoverCiFailureFollowups } = await import('../packages/core/src/webhook/ciFailureRecovery.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { runResyncGeneration } = await import('./helpers/resumeResyncHarness.js');

after(async () => {
    await closeConnection();
});

const request = {
    owner: 'acme', repo: 'widgets', prNumber: 7,
    evidence: { kind: 'status' as const, name: 'build', state: 'failure', sha: 'h7', url: '', source: 'check-run:build' },
};
const claimKey = `ci-failure-followup:${buildCiFailureDedupeKey(request)}`;

/** A producer that claimed and died before posting (the claim value is its claim time). */
function abandonedClaim(): void {
    values.set(claimKey, { value: String(Date.now()), ttl: 15 * 60 });
}

beforeEach(() => {
    values.clear(); comments = []; posted.length = 0; commentListError = null;
});

test('a claim left by a producer that died before posting keeps the family unfinished', async () => {
    abandonedClaim();
    await recoverCiFailureFollowups('acme', 'widgets', 7, 'h7'); // tolerant: the claim reads as a duplicate
    await assert.rejects(recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true }), /claimed but not yet published/);
    assert.equal(posted.length, 0, 'the live claim still excludes this producer');
    assert.equal(values.get(claimKey)?.value.startsWith('posted:'), false, 'the claim is not taken over');
});

test('the abandoned claim is a short lease; once it lapses the retry publishes exactly once', async () => {
    abandonedClaim();
    await assert.rejects(recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true }), /claimed but not yet published/);
    lapse(15 * 60);
    await recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true });
    assert.equal(posted.length, 1);
    assert.equal(values.get(claimKey)?.ttl, 30 * 24 * 60 * 60, 'a published follow-up holds the full dedupe TTL');
    await recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true });
    assert.equal(posted.length, 1, 'the published claim is completed evidence');
});

test('a claim whose follow-up comment already exists is a strict duplicate', async () => {
    abandonedClaim();
    comments = [{ body: `CI failed\n<!-- propr:ci-failure-followup key="${buildCiFailureDedupeKey(request)}" -->`, user: { login: 'propr-dev[bot]' } }];
    const result = await postCiFailureFollowup(request, 'strict', { strict: true });
    assert.deepEqual(result, { posted: false, reason: 'duplicate' });
    assert.ok(values.get(claimKey)?.value.startsWith('posted:'));
});

test('a claim lost to a concurrent producer is in flight, not a duplicate, in strict mode', async () => {
    redis.get.mock.mockImplementationOnce(async () => null); // the pre-check misses the racing claim
    abandonedClaim();
    assert.deepEqual(await postCiFailureFollowup(request, 'strict', { strict: true }), { posted: false, reason: 'in_flight' });
    assert.deepEqual(await postCiFailureFollowup(request, 'tolerant'), { posted: false, reason: 'duplicate' });
});

test('an unreadable comment list throws in strict mode instead of reading as "no follow-up"', async () => {
    commentListError = new Error('comments unavailable');
    abandonedClaim();
    await assert.rejects(postCiFailureFollowup(request, 'strict', { strict: true }), /comments unavailable/);
    values.clear();
    await assert.rejects(postCiFailureFollowup(request, 'strict', { strict: true }), /comments unavailable/);
    assert.equal(values.has(claimKey), false, 'the claim is released for the retry');
    assert.equal(posted.length, 0);
    assert.equal((await postCiFailureFollowup(request, 'tolerant')).posted, true, 'ordinary delivery still posts');
});

test('an unpublished claim never lets pull_request_heads complete', async () => {
    abandonedClaim();
    const result = await runResyncGeneration({
        steps: { pull_request_heads: async () => { await recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true }); } },
    });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.completions, []);
});
