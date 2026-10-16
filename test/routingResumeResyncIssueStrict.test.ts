import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { runResyncGeneration } from './helpers/resumeResyncHarness.js';

after(async () => {
    await closeConnection();
});

// Strict issue catch-up: a failed timeline (label-applier) read or withdrawal
// settlement fails the family instead of skipping the issue, so the generation
// never completes. Ordinary polling keeps its tolerant behavior.

process.env.GITHUB_USER_WHITELIST = 'alice';

let settlementError: Error | null = null;
const queued: Array<{ name: string; data: unknown; jobId: string }> = [];
let dedupeHeld = false;

await mock.module('../packages/core/src/daemon/configLoader.js', { namedExports: {
    getPrimaryProcessingLabels: () => ['AI'],
    loadPrimaryProcessingLabelsFromConfig: async () => undefined,
} });
await mock.module('../packages/core/src/services/taskIntent.js', { namedExports: {
    restoreIssueTrigger: async () => null,
    settleWithdrawalCleanups: async () => {
        if (settlementError) throw settlementError;
        return { idle: false };
    },
} });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
    getIssueQueue: async () => ({
        getActive: async () => [],
        getWaiting: async () => [],
        add: async (name: string, data: unknown, options: { jobId: string }) => { queued.push({ name, data, jobId: options.jobId }); },
    }),
} });

const { fetchIssuesForRepo, processDetectedIssue } = await import('../packages/core/src/daemon/issueDetection.js');

const redis = {
    set: async () => (dedupeHeld ? null : 'OK'),
    lpush: async () => 1,
    ltrim: async () => 'OK',
} as never;

let timelineFailure = true;
let issueRevision = 0;
function octokit() {
    return {
        paginate: async () => [{
            id: 1, number: 7, title: 'Add retries', html_url: 'https://github.com/acme/widgets/issues/7',
            labels: [{ name: 'AI' }], created_at: '2026-10-10T01:00:00Z', updated_at: `2026-10-11T0${issueRevision}:00:00Z`,
            user: { id: 9, login: 'alice' },
        }],
        request: async (endpoint: string) => {
            if (endpoint.endsWith('/timeline')) {
                if (timelineFailure) throw Object.assign(new Error('GitHub 502 on timeline'), { status: 502 });
                return { headers: {}, data: [{ event: 'labeled', label: { name: 'AI' }, actor: { id: 9, login: 'alice' } }] };
            }
            throw new Error(`unexpected ${endpoint}`);
        },
    } as never;
}

const issue = {
    id: 1, number: 7, title: 'Add retries', url: 'https://github.com/acme/widgets/issues/7', repoOwner: 'acme', repoName: 'widgets',
    labels: ['AI'], createdAt: '2026-10-10T01:00:00Z', updatedAt: '2026-10-11T00:00:00Z', triggeredBy: 'alice', triggeredById: '9',
    source: 'polling' as const,
};

beforeEach(() => {
    settlementError = null;
    queued.length = 0;
    dedupeHeld = false;
    timelineFailure = true;
    issueRevision += 1; // a new updated_at rotates the label-applier cache key
});

test('a failed timeline lookup fails a strict fetch; ordinary polling still skips the issue fail-closed', async () => {
    assert.deepEqual(await fetchIssuesForRepo(octokit(), 'acme/widgets', 'poll'), [], 'tolerant polling skips and retries next poll');
    await assert.rejects(fetchIssuesForRepo(octokit(), 'acme/widgets', 'resync', { throwOnError: true }), /GitHub 502 on timeline/);
});

test('a proved applier is still admitted by a strict fetch', async () => {
    timelineFailure = false;
    const issues = await fetchIssuesForRepo(octokit(), 'acme/widgets', 'resync', { throwOnError: true });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].triggeredBy, 'alice');
});

test('a timeline failure in labelled_issues never emits resync_complete', async () => {
    const result = await runResyncGeneration({
        steps: { labelled_issues: async ctx => {
            for (const found of await fetchIssuesForRepo(octokit(), ctx.repository, ctx.correlationId, { throwOnError: true })) {
                await processDetectedIssue(found, ctx.correlationId, redis, { strict: true });
            }
        } },
    });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.completions, []);
    assert.match(result.lastError ?? '', /labelled_issues: GitHub 502 on timeline/);
});

test('a withdrawal-settlement failure propagates in strict mode and stays tolerant otherwise', async () => {
    settlementError = new Error('redis unavailable during settlement');
    assert.deepEqual(await processDetectedIssue(issue, 'poll', redis), { status: 'ignored', reason: 'intent_not_current' });
    await assert.rejects(processDetectedIssue(issue, 'resync', redis, { strict: true }), /redis unavailable during settlement/);
    assert.deepEqual(queued, []);

    const result = await runResyncGeneration({
        steps: { labelled_issues: async ctx => { await processDetectedIssue(issue, ctx.correlationId, redis, { strict: true }); } },
    });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.completions, []);
});

test('strict admission does not trust another producer\'s dedupe window; the job ID keeps it idempotent', async () => {
    dedupeHeld = true;
    assert.deepEqual(await processDetectedIssue(issue, 'poll', redis), { status: 'ignored', reason: 'duplicate_delivery' });
    assert.deepEqual(queued, []);
    const disposition = await processDetectedIssue(issue, 'resync', redis, { strict: true });
    assert.equal(disposition.status, 'accepted');
    assert.deepEqual(queued.map(job => job.jobId), ['issue-acme-widgets-7']);
});
