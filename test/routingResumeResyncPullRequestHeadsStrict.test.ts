import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Strict pull_request_heads catch-up: every nested helper that ordinary event
// handling lets turn a failed read into "no head", "not green", "hook not run"
// or "policy denied" throws in strict mode, so the family stays unfinished and
// no resync_complete is sent. Checks that are genuinely pending or failing, an
// ineligible PR and a real policy denial are observed current state and
// complete it. These tests run the real helpers against a fake GitHub, Redis,
// queue and repository configuration.

const root = await mkdtemp(path.join(tmpdir(), 'resync-pr-heads-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');

/** Every mocked module keeps its real exports and overrides only what these tests fake. */
async function mockModule(specifier: string, overrides: Record<string, unknown>): Promise<void> {
    const real = await import(specifier) as Record<string, unknown>;
    await mock.module(specifier, { namedExports: { ...real, ...overrides } });
}

type Route = (params: Record<string, unknown>) => unknown;
let routes: Record<string, Route> = {};
const failures = new Map<string, Error>();
const merges: number[] = [];
let ultrafixStateRedisDown = false;
let configError: Error | null = null;
let queueError: Error | null = null;

function gitHubError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

function respond(route: string, params: Record<string, unknown>): unknown {
    const failure = failures.get(route);
    if (failure) throw failure;
    const handler = routes[route];
    if (!handler) throw gitHubError(404, `Not Found: ${route}`);
    return handler(params);
}

const octokit = {
    request: async (route: string, params: Record<string, unknown> = {}) => ({ data: respond(route, params) }),
    paginate: async (route: string, params: Record<string, unknown> = {}) => respond(route, params),
};

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        number: 7, node_id: 'PR_7', state: 'open', draft: false, body: '', changed_files: 1,
        labels: [{ name: 'auto-merge' }], base: { ref: 'main' }, head: { ref: 'feature-7', sha: 'h7' },
        mergeable: true, mergeable_state: 'clean', auto_merge: null, ...overrides,
    };
}

function greenRepository(pr: Record<string, unknown> = pullRequest()): void {
    routes = {
        'GET /repos/{owner}/{repo}': () => ({ allow_squash_merge: true }),
        'GET /repos/{owner}/{repo}/pulls': () => [pr],
        'GET /repos/{owner}/{repo}/pulls/{pull_number}': () => pr,
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': () => [{ filename: 'src/app.ts' }],
        'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': params => ('filter' in params
            ? [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', output: {} }]
            : { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }),
        'GET /repos/{owner}/{repo}/commits/{ref}/status': () => ({ state: 'success', total_count: 0, statuses: [] }),
        'GET /repos/{owner}/{repo}/commits/{ref}/statuses': () => [],
        'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge': params => {
            merges.push(params.pull_number as number);
            return { merged: true, sha: 'merged' };
        },
    };
}

function pendingChecks(): void {
    routes['GET /repos/{owner}/{repo}/commits/{ref}/check-runs'] = params => ('filter' in params
        ? [{ id: 1, name: 'build', status: 'in_progress', conclusion: null, output: {} }]
        : { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }] });
}

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return {
                on: () => undefined,
                mget: async () => {
                    if (ultrafixStateRedisDown) throw new Error('Redis connection lost');
                    return [null, null];
                },
                del: async () => 0,
                quit: async () => undefined,
                disconnect: () => undefined,
            };
        },
    },
});
await mockModule('../packages/core/src/auth/githubAuth.js', { getAuthenticatedOctokit: async () => octokit });
await mockModule('../packages/core/src/config/configManager.js', {
    loadMonitoredReposRaw: async () => {
        if (configError) throw configError;
        return [{ name: 'acme/widgets', autoFollowupOnFailedCi: true, nonBlockingChecks: [] }];
    },
});
await mockModule('../packages/core/src/queue/taskQueue.js', {
    getIssueQueue: async () => {
        if (queueError) throw queueError;
        return { getJobs: async () => [] };
    },
});

const helpers = await import('../packages/core/src/webhook/checkRunHelpers.js');
const handler = await import('../packages/core/src/webhook/checkRunHandler.js');
const { evaluatePullRequestAutoMerge } = await import('../packages/core/src/services/autoMergeGate.js');
const { recoverCiFailureFollowups } = await import('../packages/core/src/webhook/ciFailureRecovery.js');
const { runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');

// The daemon reaches these through @propr/core; route them to the real source helpers above.
await mockModule('@propr/core', {
    getCurrentPRHead: helpers.getCurrentPRHead,
    getCheckRunsStatusForRepo: helpers.getCheckRunsStatusForRepo,
    triggerUltrafixCheckRunHook: handler.triggerUltrafixCheckRunHook,
    reevaluatePRAutoMerge: handler.reevaluatePRAutoMerge,
    recoverCiFailureFollowups,
});
const { reconcileUltrafixForPR } = await import('../src/polling/prCommentPolling.js');
const { createResumeResyncReconciler } = await import('../src/daemon/routingResumeResync.js');
const { runResyncGeneration } = await import('./helpers/resumeResyncHarness.js');

/** A deferred Ultrafix continuation is waiting on every PR. */
const loopRedis = {
    get: async (key: string) => (key.startsWith('ultrafix:deferred:') ? JSON.stringify({ step: 'review' }) : null),
} as never;
const repoContext = { owner: 'acme', repo: 'widgets', repoFullName: 'acme/widgets', correlationId: 'resync' };
const hookCalls: number[] = [];
let hookError: Error | null = null;

function pullRequestHeadsStep() {
    const reconciler = createResumeResyncReconciler({
        redisClient: loopRedis, PR_FOLLOWUP_TRIGGER_KEYWORDS: [], MODEL_LABEL_PATTERN: '',
        getOctokit: async () => octokit as never,
    });
    return reconciler.repositorySteps.find(step => step.family === 'pull_request_heads')!.run;
}

before(async () => {
    await runMigrations();
});

after(async () => {
    await closeConnection();
    helpers.resetUltrafixStateRedisForTests();
    await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
    greenRepository();
    failures.clear();
    merges.length = 0;
    hookCalls.length = 0;
    ultrafixStateRedisDown = false;
    configError = null;
    queueError = null;
    hookError = null;
    handler.setUltrafixCheckRunHook(async (_owner, _repo, prNumber) => {
        if (hookError) throw hookError;
        hookCalls.push(prNumber);
    });
});

test('getCurrentPRHead: a failed read is "unavailable" when tolerant and throws when strict', async () => {
    failures.set('GET /repos/{owner}/{repo}/pulls/{pull_number}', gitHubError(502, 'Bad gateway reading PR'));
    assert.equal(await helpers.getCurrentPRHead('acme', 'widgets', 7), null);
    await assert.rejects(helpers.getCurrentPRHead('acme', 'widgets', 7, { strict: true }), /Bad gateway reading PR/);
});

test('check status: unreadable signals read as "not green" when tolerant and throw when strict', async () => {
    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', gitHubError(502, 'check-runs unavailable'));
    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/status', gitHubError(502, 'status unavailable'));
    assert.equal((await helpers.getCheckRunsStatus('acme', 'widgets', 'h7')).allPassing, false);
    await assert.rejects(helpers.getCheckRunsStatus('acme', 'widgets', 'h7', [], { strict: true }), /check-runs unavailable/);
    assert.equal(await helpers.areAllChecksPassing('acme', 'widgets', 'h7'), false);
    await assert.rejects(helpers.areAllChecksPassing('acme', 'widgets', 'h7', undefined, { strict: true }), /check-runs unavailable/);
});

test('check status: one signal type failing transiently throws when strict; a missing permission does not', async () => {
    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/status', gitHubError(403, 'API rate limit exceeded'));
    assert.equal((await helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7')).allPassing, true);
    await assert.rejects(helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7', undefined, { strict: true }), /rate limit/);
    await assert.rejects(helpers.areAllChecksPassing('acme', 'widgets', 'h7', undefined, { strict: true }), /rate limit/);

    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/status', gitHubError(403, 'Resource not accessible by integration'));
    assert.equal((await helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7', undefined, { strict: true })).allPassing, true);
});

test('check status: an unreadable nonBlockingChecks configuration throws when strict', async () => {
    configError = new Error('config store unreadable');
    assert.equal((await helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7')).allPassing, true);
    await assert.rejects(helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7', undefined, { strict: true }), /config store unreadable/);
    await assert.rejects(helpers.areAllChecksPassing('acme', 'widgets', 'h7', undefined, { strict: true }), /config store unreadable/);
    const failingLoader = async () => { throw new Error('loader failed'); };
    await assert.rejects(helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7', failingLoader, { strict: true }), /loader failed/);
});

test('check status: genuinely pending checks are a successful strict observation, not an error', async () => {
    pendingChecks();
    const status = await helpers.getCheckRunsStatusForRepo('acme', 'widgets', 'h7', undefined, { strict: true });
    assert.deepEqual([status.allPassing, status.anyPending, status.blockingPending], [false, true, ['build']]);
    assert.equal(await helpers.areAllChecksPassing('acme', 'widgets', 'h7', undefined, { strict: true }), false);
});

test('triggerUltrafixCheckRunHook: a failed or missing hook returns false when tolerant and throws when strict', async () => {
    hookError = new Error('continuation queue unavailable');
    const target = { owner: 'acme', repo: 'widgets', prNumber: 7, headSha: 'h7' };
    assert.equal(await handler.triggerUltrafixCheckRunHook(target), false);
    await assert.rejects(handler.triggerUltrafixCheckRunHook(target, undefined, { strict: true }), /continuation queue unavailable/);
});

test('reconcileUltrafixForPR: a failed hook is no longer ignored in strict mode', async () => {
    const pr = { number: 7, title: 'Fix', labels: [{ name: 'ultrafix' }], head: { ref: 'feature-7', sha: 'h7' } };
    assert.equal(await reconcileUltrafixForPR(pr, repoContext, loopRedis, { throwOnError: true }), 'triggered');
    assert.deepEqual(hookCalls, [7]);

    hookError = new Error('continuation queue unavailable');
    assert.equal(await reconcileUltrafixForPR(pr, repoContext, loopRedis), 'hook_failed');
    await assert.rejects(reconcileUltrafixForPR(pr, repoContext, loopRedis, { throwOnError: true }), /continuation queue unavailable/);
});

test('reconcileUltrafixForPR: an unreadable head or check signal throws in strict mode', async () => {
    const headless = { number: 7, title: 'Fix', labels: [{ name: 'ultrafix' }], head: { ref: 'feature-7' } };
    failures.set('GET /repos/{owner}/{repo}/pulls/{pull_number}', gitHubError(502, 'Bad gateway reading PR'));
    assert.equal(await reconcileUltrafixForPR(headless, repoContext, loopRedis), 'head_unavailable');
    await assert.rejects(reconcileUltrafixForPR(headless, repoContext, loopRedis, { throwOnError: true }), /Bad gateway reading PR/);

    failures.clear();
    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', gitHubError(502, 'check-runs unavailable'));
    failures.set('GET /repos/{owner}/{repo}/commits/{ref}/status', gitHubError(502, 'status unavailable'));
    const pr = { ...headless, head: { ref: 'feature-7', sha: 'h7' } };
    assert.equal(await reconcileUltrafixForPR(pr, repoContext, loopRedis), 'checks_not_green');
    await assert.rejects(reconcileUltrafixForPR(pr, repoContext, loopRedis, { throwOnError: true }), /check-runs unavailable/);
    assert.deepEqual(hookCalls, []);
});

test('reconcileUltrafixForPR: pending checks on a waiting loop are a strict observation that leaves the loop deferred', async () => {
    pendingChecks();
    const pr = { number: 7, title: 'Fix', labels: [{ name: 'ultrafix' }], head: { ref: 'feature-7', sha: 'h7' } };
    assert.equal(await reconcileUltrafixForPR(pr, repoContext, loopRedis, { throwOnError: true }), 'checks_not_green');
    assert.deepEqual(hookCalls, []);
});

test('evaluatePullRequestAutoMerge: PR, policy and changed-file read failures deny when tolerant and throw when strict', async () => {
    const input = { owner: 'acme', repo: 'widgets', prNumber: 7, opportunity: 'check_merge' as const };
    failures.set('GET /repos/{owner}/{repo}/pulls/{pull_number}', gitHubError(502, 'Bad gateway reading PR'));
    assert.equal((await evaluatePullRequestAutoMerge(input)).decision.reason, 'skipped_policy_invalid');
    await assert.rejects(evaluatePullRequestAutoMerge({ ...input, strict: true }), /Bad gateway reading PR/);

    failures.clear();
    failures.set('GET /repos/{owner}/{repo}/contents/{path}', gitHubError(500, 'contents unavailable'));
    assert.equal((await evaluatePullRequestAutoMerge(input)).decision.reason, 'skipped_policy_invalid');
    await assert.rejects(evaluatePullRequestAutoMerge({ ...input, strict: true }), /contents unavailable/);

    failures.clear();
    failures.set('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', gitHubError(502, 'files unavailable'));
    assert.equal((await evaluatePullRequestAutoMerge(input)).decision.reason, 'skipped_diff_unavailable');
    await assert.rejects(evaluatePullRequestAutoMerge({ ...input, strict: true }), /files unavailable/);

    failures.clear();
    routes['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = () => pullRequest({ changed_files: undefined });
    assert.equal((await evaluatePullRequestAutoMerge(input)).decision.reason, 'skipped_diff_unavailable');
    await assert.rejects(evaluatePullRequestAutoMerge({ ...input, strict: true }), /unknown file count/);
});

test('evaluatePullRequestAutoMerge: a real policy denial still decides in strict mode', async () => {
    const workflow = Buffer.from('auto_merge:\n  enabled: false\n').toString('base64');
    routes['GET /repos/{owner}/{repo}/contents/{path}'] = () => ({ type: 'file', encoding: 'base64', content: workflow, size: 30 });
    const { decision } = await evaluatePullRequestAutoMerge({ owner: 'acme', repo: 'widgets', prNumber: 7, opportunity: 'check_merge', strict: true });
    assert.deepEqual([decision.arm, decision.reason], [false, 'skipped_disabled']);
});

test('reevaluatePRAutoMerge: each uncertain read keeps its tolerant outcome and throws when strict', async () => {
    // [layer, failure, tolerant outcome, strict error]: the tolerant active-work lookup fails open by design.
    const cases: Array<[string, () => void, string, RegExp]> = [
        ['PR head', () => failures.set('GET /repos/{owner}/{repo}/pulls/{pull_number}', gitHubError(502, 'Bad gateway reading PR')),
            'head_unavailable', /Bad gateway reading PR/],
        ['Ultrafix state', () => {
            const pr = pullRequest({ labels: [{ name: 'auto-merge' }, { name: 'ultrafix' }] });
            routes['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = () => pr;
            ultrafixStateRedisDown = true;
        }, 'not_eligible', /Redis connection lost/],
        ['linked issue', () => {
            const pr = pullRequest({ labels: [], body: 'Fixes #3' });
            routes['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = () => pr;
            failures.set('GET /repos/{owner}/{repo}/issues/{issue_number}', gitHubError(502, 'issue unavailable'));
        }, 'not_eligible', /issue unavailable/],
        ['check signals', () => failures.set('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', gitHubError(502, 'check-runs unavailable')),
            'checks_not_green', /check-runs unavailable/],
        ['active work', () => { queueError = new Error('queue scan failed'); }, 'merged', /queue scan failed/],
        ['policy', () => failures.set('GET /repos/{owner}/{repo}/contents/{path}', gitHubError(500, 'contents unavailable')),
            'policy_denied', /contents unavailable/],
        ['merge', () => failures.set('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', gitHubError(409, 'Head branch was modified')),
            'merge_failed', /Auto-merge of acme\/widgets#7 failed/],
    ];
    for (const [layer, fail, tolerant, error] of cases) {
        greenRepository(); failures.clear(); ultrafixStateRedisDown = false; queueError = null;
        fail();
        assert.equal(await handler.reevaluatePRAutoMerge('acme', 'widgets', 7, 'resync'), tolerant, `${layer}: tolerant`);
        merges.length = 0;
        await assert.rejects(handler.reevaluatePRAutoMerge('acme', 'widgets', 7, 'resync', { strict: true }), error, `${layer}: strict`);
        assert.deepEqual(merges, [], `${layer}: strict never merges after an uncertain read`);
    }
});

test('reevaluatePRAutoMerge: pending checks and a real policy denial are strict outcomes; a green PR merges', async () => {
    pendingChecks();
    assert.equal(await handler.reevaluatePRAutoMerge('acme', 'widgets', 7, 'resync', { strict: true }), 'checks_not_green');

    greenRepository();
    const workflow = Buffer.from('auto_merge:\n  enabled: false\n').toString('base64');
    routes['GET /repos/{owner}/{repo}/contents/{path}'] = () => ({ type: 'file', encoding: 'base64', content: workflow, size: 30 });
    assert.equal(await handler.reevaluatePRAutoMerge('acme', 'widgets', 7, 'resync', { strict: true }), 'policy_denied');

    greenRepository();
    assert.equal(await handler.reevaluatePRAutoMerge('acme', 'widgets', 7, 'resync', { strict: true }), 'merged');
    assert.deepEqual(merges, [7]);
});

test('recoverCiFailureFollowups: an unreadable configuration reads as "disabled" when tolerant and throws when strict', async () => {
    configError = new Error('config store unreadable');
    await recoverCiFailureFollowups('acme', 'widgets', 7, 'h7');
    await assert.rejects(recoverCiFailureFollowups('acme', 'widgets', 7, 'h7', { strict: true }), /config store unreadable/);
});

test('a swallowed layer inside pull_request_heads keeps the generation from completing', async () => {
    const step = pullRequestHeadsStep();
    const ultrafixPr = pullRequest({ labels: [{ name: 'ultrafix' }] });
    const scenarios: Array<[string, () => void, RegExp]> = [
        ['hook', () => { greenRepository(ultrafixPr); hookError = new Error('continuation queue unavailable'); }, /continuation queue unavailable/],
        ['checks', () => { greenRepository(ultrafixPr); failures.set('GET /repos/{owner}/{repo}/commits/{ref}/status', gitHubError(502, 'status unavailable')); }, /status unavailable/],
        ['CI configuration', () => { configError = new Error('config store unreadable'); }, /config store unreadable/],
        ['auto-merge policy', () => failures.set('GET /repos/{owner}/{repo}/contents/{path}', gitHubError(500, 'contents unavailable')), /contents unavailable/],
    ];
    for (const [layer, fail, error] of scenarios) {
        greenRepository(); failures.clear(); configError = null; hookError = null;
        fail();
        const result = await runResyncGeneration({ steps: { pull_request_heads: step } });
        assert.equal(result.state, 'failed', layer);
        assert.deepEqual(result.completions, [], `${layer}: no resync_complete`);
        assert.match(result.lastError ?? '', new RegExp(`pull_request_heads: ${error.source}`), layer);
    }
    assert.deepEqual(merges, []);
});

test('pending checks on every open PR are a converged pull_request_heads observation', async () => {
    greenRepository(pullRequest({ labels: [{ name: 'ultrafix' }, { name: 'auto-merge' }] }));
    pendingChecks();
    const result = await runResyncGeneration({ steps: { pull_request_heads: pullRequestHeadsStep() } });
    assert.equal(result.state, 'completed', result.lastError ?? undefined);
    assert.equal(result.completions.length, 1);
    assert.deepEqual([hookCalls, merges], [[], []]);
});
