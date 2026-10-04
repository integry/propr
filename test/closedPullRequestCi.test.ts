import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    CLOSED_PULL_REQUEST_CI_KEY, closedPullRequestCiField, recordClosedPullRequestForCiCancellation, type ClosedPullRequestCiRequest,
} from '../packages/core/src/webhook/closedPullRequestCi.js';
import { CLOSED_PULL_REQUEST_CI_MAX_AGE_MS, cancelClosedPullRequestValidation, isObsoleteClosedPullRequestRun } from '../src/jobs/closedPullRequestCiCancellation.js';
import { createValidationWorkflowPolicy } from '../src/jobs/followupCiSuspensionPolicy.js';

after(async () => { await closeConnection(); });

const HEAD = 'fef27a33ed13e8ed4508857d279350d95195aa92';
const CLOSED_AT = '2026-09-26T21:36:23Z';
const policy = createValidationWorkflowPolicy(['Full Test Suite', 'pr-build-check.yml'], 'repository');
const log = { debug() {}, info() {}, warn() {}, error() {} };

function fakeRedis(entries: Record<string, string> = {}) {
    const hash = new Map(Object.entries(entries));
    return {
        hash,
        async hset(_key: string, field: string, value: string) { hash.set(field, value); return 1; },
        async hgetall(key: string) { assert.equal(key, CLOSED_PULL_REQUEST_CI_KEY); return Object.fromEntries(hash); },
        async hget(_key: string, field: string) { return hash.get(field) ?? null; },
        async hdel(_key: string, ...fields: string[]) { fields.forEach(field => hash.delete(field)); return fields.length; },
        async eval(script: string, numberOfKeys: number, key: string, field: string, expected: string) {
            assert.equal(numberOfKeys, 1);
            assert.equal(key, CLOSED_PULL_REQUEST_CI_KEY);
            assert.match(script, /if redis.call\('HGET', KEYS\[1\], ARGV\[1\]\) == ARGV\[2\] then\s+return redis.call\('HDEL', KEYS\[1\], ARGV\[1\]\)\s+end\s+return 0/);
            if (hash.get(field) !== expected) return 0;
            return Number(hash.delete(field));
        },
    };
}

function run(overrides: Record<string, unknown> = {}) {
    return {
        id: 1, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', event: 'pull_request', status: 'queued',
        head_sha: HEAD, head_branch: 'feature', head_repository: { full_name: 'integry/propr' }, created_at: '2026-09-26T20:44:08Z',
        pull_requests: [], ...overrides,
    };
}

const request: ClosedPullRequestCiRequest = {
    repository: 'integry/propr', pullRequestNumber: 2552, headSha: HEAD, headRef: 'feature',
    headRepository: 'integry/propr', merged: true, closedAt: CLOSED_AT,
};

describe('closed pull request CI cancellation', () => {
    test('the webhook records closed pull requests only for repositories that opted in', async () => {
        const payload = {
            action: 'closed',
            repository: { full_name: 'integry/propr', owner: { login: 'integry' }, name: 'propr' },
            pull_request: { number: 2552, merged: true, closed_at: CLOSED_AT, head: { sha: HEAD, ref: 'feature', repo: { full_name: 'integry/propr' } } },
        };
        const redis = fakeRedis();
        assert.equal(await recordClosedPullRequestForCiCancellation(payload, redis as never, async () => false), false);
        assert.equal(redis.hash.size, 0);
        assert.equal(await recordClosedPullRequestForCiCancellation({ ...payload, action: 'labeled' }, redis as never, async () => true), false);
        assert.equal(await recordClosedPullRequestForCiCancellation(payload, redis as never, async () => true), true);
        assert.deepEqual(JSON.parse(redis.hash.get(closedPullRequestCiField('integry/propr', 2552))!), request);
    });

    test('only selected validation started before the close, on the final head, is obsolete', () => {
        assert.equal(isObsoleteClosedPullRequestRun(run(), request, policy), true);
        assert.equal(isObsoleteClosedPullRequestRun(run({ status: 'in_progress' }), request, policy), true);
        // Not selected, or not a pull request run: never touched.
        assert.equal(isObsoleteClosedPullRequestRun(run({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }), request, policy), false);
        assert.equal(isObsoleteClosedPullRequestRun(run({ event: 'push' }), request, policy), false);
        // Started by the close itself, or already finished.
        assert.equal(isObsoleteClosedPullRequestRun(run({ created_at: '2026-09-26T21:36:26Z' }), request, policy), false);
        assert.equal(isObsoleteClosedPullRequestRun(run({ status: 'completed' }), request, policy), false);
        // Another commit, branch or head repository validates something else.
        assert.equal(isObsoleteClosedPullRequestRun(run({ head_sha: 'a'.repeat(40) }), request, policy), false);
        assert.equal(isObsoleteClosedPullRequestRun(run({ head_branch: 'main' }), request, policy), false);
        assert.equal(isObsoleteClosedPullRequestRun(run({ head_repository: { full_name: 'fork/propr' } }), request, policy), false);
    });

    type OpenPullRequest = { number: number; head: { sha: string; ref?: string; repo?: { owner: { login: string } } } };

    function octokitWith(runs: ReturnType<typeof run>[], openPullRequests: OpenPullRequest[] = []) {
        const cancelled: number[] = [];
        const pullRequestPages: number[] = [];
        return {
            cancelled,
            pullRequestPages,
            async request(route: string, params: Record<string, unknown>) {
                if (route === 'GET /repos/{owner}/{repo}/actions/runs') return { data: { workflow_runs: runs, total_count: runs.length } };
                if (route === 'GET /repos/{owner}/{repo}/pulls') {
                    assert.equal(params.owner, 'integry');
                    assert.equal(params.repo, 'propr');
                    assert.equal(params.state, 'open');
                    const page = Number(params.page ?? 1);
                    const perPage = Number(params.per_page ?? 30);
                    pullRequestPages.push(page);
                    const filtered = openPullRequests.filter(pr => !params.head
                        || params.head === `${pr.head.repo?.owner.login ?? 'integry'}:${pr.head.ref ?? request.headRef}`);
                    return { data: filtered.slice((page - 1) * perPage, page * perPage) };
                }
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') { cancelled.push(params.run_id as number); return { data: {} }; }
                throw new Error(`unexpected ${route}`);
            },
        };
    }
    const field = closedPullRequestCiField('integry/propr', 2552);
    const now = () => Date.parse(CLOSED_AT) + 60_000;

    test('cancels the obsolete runs of a merged pull request and settles the request', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = octokitWith([run({ id: 1 }), run({ id: 2, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }), run({ id: 3, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target' })]);
        const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.deepEqual(octokit.cancelled, [1, 2]);
        assert.deepEqual(summary, { scanned: 1, cancelledRuns: 2, errors: 0 });
        assert.equal(redis.hash.size, 0);
    });

    test('keeps validation another open pull request of the same head still needs', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = octokitWith([run()], [{ number: 2600, head: { sha: HEAD } }]);
        await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.deepEqual(octokit.cancelled, []);
        assert.equal(redis.hash.size, 0);
    });

    test('keeps same-commit validation for another branch or head owner, including on later pages', async () => {
        for (const owner of ['integry', 'contributor']) {
            for (const precedingCount of [0, 100]) {
                const redis = fakeRedis({ [field]: JSON.stringify(request) });
                const openPullRequests: OpenPullRequest[] = Array.from({ length: precedingCount }, (_, i) => ({
                    number: 2700 + i, head: { sha: 'a'.repeat(40) },
                }));
                openPullRequests.push({ number: 2600, head: { sha: HEAD, ref: 'feature-b', repo: { owner: { login: owner } } } });
                const octokit = octokitWith([run()], openPullRequests);
                const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
                assert.deepEqual(octokit.cancelled, [], `${owner}, ${precedingCount} preceding PRs`);
                assert.deepEqual(octokit.pullRequestPages, precedingCount === 0 ? [1] : [1, 2]);
                assert.deepEqual(summary, { scanned: 1, cancelledRuns: 0, errors: 0 });
                assert.equal(redis.hash.size, 0);
            }
        }
    });

    test('cancels only after exhausting open PR pages without a matching head', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = octokitWith([run()], Array.from({ length: 100 }, (_, i) => ({
            number: 2700 + i, head: { sha: 'a'.repeat(40) },
        })));
        const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.deepEqual(octokit.pullRequestPages, [1, 2]);
        assert.deepEqual(octokit.cancelled, [1]);
        assert.deepEqual(summary, { scanned: 1, cancelledRuns: 1, errors: 0 });
        assert.equal(redis.hash.size, 0);
    });

    test('retains the request when a later open PR page fails and retries protection', async () => {
        const raw = JSON.stringify(request);
        const redis = fakeRedis({ [field]: raw });
        const openPullRequests: OpenPullRequest[] = Array.from({ length: 100 }, (_, i) => ({
            number: 2700 + i, head: { sha: 'a'.repeat(40) },
        }));
        openPullRequests.push({ number: 2600, head: { sha: HEAD, ref: 'feature-b' } });
        const octokit = octokitWith([run()], openPullRequests);
        const send = octokit.request.bind(octokit);
        let unavailable = true;
        octokit.request = async (route, params) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls' && params.page === 2 && unavailable) {
                throw Object.assign(new Error('Service Unavailable'), { status: 503 });
            }
            return send(route, params);
        };
        const deps = { redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now };
        assert.deepEqual(await cancelClosedPullRequestValidation(deps), { scanned: 1, cancelledRuns: 0, errors: 1 });
        assert.deepEqual(octokit.cancelled, []);
        assert.equal(redis.hash.get(field), raw);
        unavailable = false;
        assert.deepEqual(await cancelClosedPullRequestValidation(deps), { scanned: 1, cancelledRuns: 0, errors: 0 });
        assert.deepEqual(octokit.cancelled, []);
        assert.equal(redis.hash.size, 0);
    });

    test('keeps validation when the closed pull request reopens on the same head before reconciliation', async () => {
        const redis = fakeRedis();
        await recordClosedPullRequestForCiCancellation({
            action: 'closed',
            repository: { full_name: request.repository, owner: { login: 'integry' }, name: 'propr' },
            pull_request: { number: request.pullRequestNumber, merged: false, closed_at: CLOSED_AT,
                head: { sha: HEAD, ref: request.headRef, repo: { full_name: request.headRepository! } } },
        }, redis as never, async () => true);
        const octokit = octokitWith([run()], [{ number: request.pullRequestNumber, head: { sha: HEAD } }]);
        const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.deepEqual(octokit.cancelled, []);
        assert.deepEqual(summary, { scanned: 1, cancelledRuns: 0, errors: 0 });
        assert.equal(redis.hash.size, 0);
    });

    test('refreshes open pull request protection after each awaited cancellation', async () => {
        for (const number of [request.pullRequestNumber, 2600]) {
            const redis = fakeRedis({ [field]: JSON.stringify(request) });
            const openPullRequests: OpenPullRequest[] = [];
            const octokit = octokitWith([run({ id: 1 }), run({ id: 2 })], openPullRequests);
            const send = octokit.request.bind(octokit);
            octokit.request = async (route, params) => {
                const response = await send(route, params);
                if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') {
                    openPullRequests.push({ number, head: { sha: HEAD,
                        ref: number === request.pullRequestNumber ? request.headRef : 'feature-b',
                        repo: { owner: { login: number === request.pullRequestNumber ? 'integry' : 'contributor' } } } });
                }
                return response;
            };
            const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
            assert.deepEqual(octokit.cancelled, [1]);
            assert.equal(summary.cancelledRuns, 1);
            assert.equal(redis.hash.size, 0);
        }
    });

    test('a reopened pull request with a different head does not protect obsolete validation', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = octokitWith([run()], [{ number: request.pullRequestNumber, head: { sha: 'a'.repeat(40) } }]);
        await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.deepEqual(octokit.cancelled, [1]);
        assert.equal(redis.hash.size, 0);
    });

    test('retains an unreadable workflow selection and cancels after configuration recovers', async () => {
        const raw = JSON.stringify(request);
        const redis = fakeRedis({ [field]: raw });
        const octokit = octokitWith([run()]);
        let selection: string[] | null = null;
        const deps = { redis, octokit, isEnabled: async () => true, loadSelectedWorkflows: async () => selection, log, now };
        assert.deepEqual(await cancelClosedPullRequestValidation(deps), { scanned: 1, cancelledRuns: 0, errors: 1 });
        assert.deepEqual(octokit.cancelled, []);
        assert.equal(redis.hash.get(field), raw);
        selection = ['Full Test Suite'];
        assert.deepEqual(await cancelClosedPullRequestValidation(deps), { scanned: 1, cancelledRuns: 1, errors: 0 });
        assert.deepEqual(octokit.cancelled, [1]);
        assert.equal(redis.hash.size, 0);
    });

    test('unreadable selection still expires within the existing cleanup window', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = octokitWith([run()]);
        await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true,
            loadSelectedWorkflows: async () => null, log,
            now: () => Date.parse(CLOSED_AT) + CLOSED_PULL_REQUEST_CI_MAX_AGE_MS + 1 });
        assert.deepEqual(octokit.cancelled, []);
        assert.equal(redis.hash.size, 0);
    });

    test('settling an older closure atomically preserves a webhook replacement at the deletion boundary', async () => {
        for (const outcome of ['cancelled', 'disabled', 'empty', 'expired', 'invalid', 'permission'] as const) {
            const raw = outcome === 'invalid' ? '{' : JSON.stringify(request);
            const redis = fakeRedis({ [field]: raw });
            const newer = { ...request, headSha: 'b'.repeat(40), closedAt: '2026-09-26T21:37:23Z' };
            const replace = async () => {
                await recordClosedPullRequestForCiCancellation({
                    action: 'closed',
                    repository: { full_name: newer.repository, owner: { login: 'integry' }, name: 'propr' },
                    pull_request: { number: newer.pullRequestNumber, merged: newer.merged, closed_at: newer.closedAt,
                        head: { sha: newer.headSha, ref: newer.headRef, repo: { full_name: newer.headRepository! } } },
                }, redis as never, async () => true);
            };
            // Reproduce the old HGET/HDEL interleaving if settlement ever regresses.
            redis.hget = async (_key, name) => {
                const observed = redis.hash.get(name) ?? null;
                await replace();
                return observed;
            };
            const atomicDelete = redis.eval.bind(redis);
            redis.eval = async (...args) => {
                await replace(); // The webhook write reaches Redis before the settlement command.
                return atomicDelete(...args);
            };
            const octokit = octokitWith([run()]);
            if (outcome === 'permission') {
                const send = octokit.request.bind(octokit);
                octokit.request = async (route, params) => {
                    if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') {
                        throw Object.assign(new Error('Forbidden'), { status: 403 });
                    }
                    return send(route, params);
                };
            }
            await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => outcome !== 'disabled',
                workflowPolicy: outcome === 'empty' ? createValidationWorkflowPolicy([], 'repository') : policy, log,
                now: outcome === 'expired' ? () => Date.parse(CLOSED_AT) + CLOSED_PULL_REQUEST_CI_MAX_AGE_MS + 1 : now });
            assert.deepEqual(JSON.parse(redis.hash.get(field)!), newer, outcome);
        }
    });

    test('cancels nothing when the repository option is off or nothing is selected', async () => {
        for (const deps of [{ isEnabled: async () => false, workflowPolicy: policy }, { isEnabled: async () => true, workflowPolicy: createValidationWorkflowPolicy([], 'repository') }]) {
            const redis = fakeRedis({ [field]: JSON.stringify(request) });
            const octokit = octokitWith([run()]);
            await cancelClosedPullRequestValidation({ redis, octokit, log, now, ...deps });
            assert.deepEqual(octokit.cancelled, []);
            assert.equal(redis.hash.size, 0);
        }
    });

    test('retries after a transient GitHub failure', async () => {
        const redis = fakeRedis({ [field]: JSON.stringify(request) });
        const octokit = { async request() { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); } };
        const summary = await cancelClosedPullRequestValidation({ redis, octokit, isEnabled: async () => true, workflowPolicy: policy, log, now });
        assert.equal(summary.errors, 1);
        assert.equal(redis.hash.size, 1, 'the request stays for the next pass');
    });
});
