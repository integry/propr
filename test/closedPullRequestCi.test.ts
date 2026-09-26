import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    CLOSED_PULL_REQUEST_CI_KEY, closedPullRequestCiField, recordClosedPullRequestForCiCancellation, type ClosedPullRequestCiRequest,
} from '../packages/core/src/webhook/closedPullRequestCi.js';
import { cancelClosedPullRequestValidation, isObsoleteClosedPullRequestRun } from '../src/jobs/closedPullRequestCiCancellation.js';
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

    function octokitWith(runs: ReturnType<typeof run>[], openPullRequests: Array<{ number: number; head: { sha: string } }> = []) {
        const cancelled: number[] = [];
        return {
            cancelled,
            async request(route: string, params: Record<string, unknown>) {
                if (route === 'GET /repos/{owner}/{repo}/actions/runs') return { data: { workflow_runs: runs, total_count: runs.length } };
                if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: openPullRequests };
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
