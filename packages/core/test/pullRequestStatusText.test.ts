import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { PullRequestStatusFacts } from '../src/services/pullRequestStatus/pullRequestStatus.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { computePullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatus.js');
const {
    describeChildStatus, renderCompactPullRequestStatusBlock, renderPullRequestStatusLine, sameRenderedStatus, statusTimestamp,
} = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const { onlyCheckProgressChanged } = await import('../src/services/pullRequestStatus/pullRequestStatusEditPacing.js');
const { loadPullRequestStatusChecks } = await import('../src/services/pullRequestStatus/pullRequestStatusFacts.js');

after(async () => {
    await closeConnection();
});

const NOW = new Date('2026-11-16T13:59:00Z');

function facts(overrides: Partial<PullRequestStatusFacts> = {}): PullRequestStatusFacts {
    return {
        pullRequest: { state: 'open', merged: false, headSha: 'abc', mergeable: true },
        isProprPullRequest: true,
        tasks: [{ type: 'issue', mode: null, state: 'completed', createdAt: '2026-11-16T09:00:00Z' }],
        queuedJobs: 0,
        ultrafix: null,
        checks: { complete: true, passed: 35, failed: 0, pending: 0, failedNames: [] },
        latestReviewScore: null,
        ratingGoal: 8,
        epic: null,
        ...overrides,
    };
}

const line = (overrides: Partial<PullRequestStatusFacts>) => renderPullRequestStatusLine(computePullRequestStatus(facts(overrides)), NOW);

type Run = { name: string; status: string; conclusion: string | null };
const run = (name: string, conclusion: string | null, status = conclusion === null ? 'in_progress' : 'completed'): Run => ({ name, status, conclusion });

async function checksOf(runs: Run[], patterns: string[] = []) {
    return await loadPullRequestStatusChecks({
        github: {
            request: async (route: string) => {
                if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') return { data: { total_count: runs.length, check_runs: runs } };
                if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') return { data: { state: 'pending', total_count: 0, statuses: [] } };
                throw new Error(`unexpected ${route}`);
            },
        },
        loadNonBlockingChecks: async () => patterns,
    }, 'acme', 'widgets', 'abc');
}

// --- 1: skipped checks ---

test('skipped checks are not counted as passed, and are shown apart only when there are any', async () => {
    const runs = [...Array.from({ length: 35 }, (_, index) => run(`ok-${index}`, 'success')), ...Array.from({ length: 12 }, (_, index) => run(`skip-${index}`, 'skipped'))];
    const checks = await checksOf(runs);
    assert.equal(checks.passed, 35);
    assert.equal(checks.skipped, 12);
    assert.equal(line({ checks }), '**ProPR** ✅ Ready · checks: 35 passed, 12 skipped · updated Nov 16 13:59 UTC');
    const none = await checksOf(runs.slice(0, 35));
    assert.equal(none.skipped, undefined);
    assert.equal(line({ checks: none }), '**ProPR** ✅ Ready · checks: 35 passed · updated Nov 16 13:59 UTC');
    // A non-blocking skipped check is not counted at all, like any non-blocking check.
    assert.equal((await checksOf([run('unit', 'success'), run('optional', 'skipped')], ['optional'])).skipped, undefined);
});

// --- 2: the stamp carries its date ---

test('the update stamp carries the date', () => {
    assert.equal(statusTimestamp(NOW), 'Nov 16 13:59 UTC');
    assert.equal(statusTimestamp(new Date('2026-01-02T03:04:00Z')), 'Jan 2 03:04 UTC');
    assert.match(renderCompactPullRequestStatusBlock(computePullRequestStatus(facts()), NOW)!, /✅ Ready · updated Nov 16 13:59 UTC\n/);
    // A block written before the date was added is the same status as one with it.
    assert.ok(sameRenderedStatus('**ProPR** ✅ Ready · updated 13:59 UTC', '**ProPR** ✅ Ready · updated Nov 17 08:00 UTC'));
    assert.ok(!sameRenderedStatus('**ProPR** ✅ Ready · updated 13:59 UTC', '**ProPR** ⚠️ Needs you · updated Nov 17 08:00 UTC'));
});

// --- 3: one score ---

test('a review below the goal reads as one score and its goal', () => {
    assert.equal(line({ latestReviewScore: 6 }), '**ProPR** ⚠️ Needs you · review 6/10, goal 8 · checks: 35 passed · updated Nov 16 13:59 UTC');
    const status = computePullRequestStatus(facts({ latestReviewScore: 6 }));
    assert.equal(describeChildStatus(status), 'review 6/10, goal 8');
    assert.equal(describeChildStatus(status, 'comment'), 'review 6/10, goal 8');
    // Another reason keeps the score as its own part.
    assert.equal(line({ latestReviewScore: 6, pullRequest: { state: 'open', merged: false, headSha: 'abc', mergeable: false } }),
        '**ProPR** ⚠️ Needs you · conflicts with base · review 6/10 · checks: 35 passed · updated Nov 16 13:59 UTC');
});

// --- 4: Ultrafix once ---

test('a running Ultrafix loop names its cycle once', () => {
    const ultrafix = { active: true, cycleCount: 2, maxCycles: 10, goal: 8, completionStatus: null, completionReason: null, finalScore: null, completedAt: null, waitingForCi: false };
    assert.equal(line({ ultrafix, latestReviewScore: 6 }), '**ProPR** 🔨 Ultrafix cycle 3 of 10 · last review 6/10 · checks: 35 passed · updated Nov 16 13:59 UTC');
    assert.match(renderCompactPullRequestStatusBlock(computePullRequestStatus(facts({ ultrafix })), NOW)!, /\*\*ProPR\*\* 🔨 Ultrafix cycle 3 of 10 · updated/);
    // While the loop's fix runs, the activity leads and the cycle follows.
    assert.match(line({ ultrafix, tasks: [{ type: 'pr-comment', mode: 'follow_up', state: 'claude_execution', createdAt: '2026-11-16T13:00:00Z' }] }),
        /^\*\*ProPR\*\* 🔨 Follow-up in progress · Ultrafix cycle 3 of 10 · /);
    assert.equal(describeChildStatus(computePullRequestStatus(facts({ ultrafix, latestReviewScore: 6 }))), 'Ultrafix cycle 3 of 10, last review 6/10');
});

// --- 5: cancelled and unexpanded checks ---

test('cancelled runs a newer run replaced, or whose name was never expanded, are neither failed nor counted', async () => {
    const checks = await checksOf([
        run('unit', 'success'),
        run('lint', 'cancelled'), run('lint', null),
        run('Validate unsigned ${{ matrix.platform }}-${{ matrix.arch }} package', 'cancelled'),
    ]);
    assert.deepEqual({ passed: checks.passed, failed: checks.failed, pending: checks.pending, cancelled: checks.cancelled }, { passed: 1, failed: 0, pending: 1, cancelled: undefined });
    assert.equal(line({ checks }), '**ProPR** 🔨 Waiting for CI · checks: 1 passed, 1 pending · updated Nov 16 13:59 UTC');
});

test('a cancelled run nothing replaced is reported as cancelled, not failed, and still needs you', async () => {
    const checks = await checksOf([run('unit', 'success'), run('e2e', 'cancelled')]);
    assert.equal(checks.failed, 0);
    assert.equal(checks.cancelled, 1);
    const status = computePullRequestStatus(facts({ checks }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(renderPullRequestStatusLine(status, NOW), '**ProPR** ⚠️ Needs you · cancelled: e2e · checks: 1 passed, 1 cancelled · updated Nov 16 13:59 UTC');
    // A real failure leads; the cancellation is only counted.
    const mixed = await checksOf([run('unit', 'failure'), run('e2e', 'cancelled')]);
    assert.equal(line({ checks: mixed }), '**ProPR** ⚠️ Needs you · failed: unit · checks: 1 failed, 1 cancelled · updated Nov 16 13:59 UTC');
});

test('a failed check name holding a workflow expression is counted, never listed', () => {
    const template = 'Validate unsigned ${{ matrix.platform }}-${{ matrix.arch }} package';
    assert.equal(line({ checks: { complete: true, passed: 12, failed: 2, pending: 0, failedNames: [template, 'unit'] } }),
        '**ProPR** ⚠️ Needs you · failed: unit +1 · checks: 12 passed, 2 failed · updated Nov 16 13:59 UTC');
    assert.equal(line({ checks: { complete: true, passed: 12, failed: 1, pending: 0, failedNames: [template] } }),
        '**ProPR** ⚠️ Needs you · checks failed · checks: 12 passed, 1 failed · updated Nov 16 13:59 UTC');
});

// --- 6: what the edit pacing holds back ---

test('only a change of check progress is held for the edit window', () => {
    const body = (status: string) => `<!-- propr:pr-status -->\n**ProPR** ${status}\n<!-- /propr:pr-status -->\n\n## Summary`;
    assert.ok(onlyCheckProgressChanged(body('🔨 Waiting for CI · checks: 3 passed, 4 pending · updated Nov 16 13:59 UTC'), body('🔨 Waiting for CI · checks: 4 passed, 3 pending · updated Nov 16 14:00 UTC')));
    assert.ok(onlyCheckProgressChanged(body('⚠️ Needs you · failed: a · checks: 1 failed, 4 pending · updated 13:59 UTC'), body('⚠️ Needs you · failed: a, b · checks: 2 failed, 3 pending · updated Nov 16 14:00 UTC')));
    assert.ok(!onlyCheckProgressChanged(body('🔨 Waiting for CI · checks: 4 pending · updated Nov 16 13:59 UTC'), body('⚠️ Needs you · failed: a · checks: 1 failed, 3 pending · updated Nov 16 14:00 UTC')));
    assert.ok(!onlyCheckProgressChanged(body('🔨 Waiting for CI · last review 6/10 · checks: 4 pending · updated Nov 16 13:59 UTC'), body('🔨 Waiting for CI · last review 7/10 · checks: 3 pending · updated Nov 16 14:00 UTC')));
    assert.ok(!onlyCheckProgressChanged(body('🔨 Waiting for CI · checks: 4 pending · updated Nov 16 13:59 UTC'), `${body('🔨 Waiting for CI · checks: 3 pending · updated Nov 16 14:00 UTC')} edited`), 'text outside the block changed');
    assert.ok(!onlyCheckProgressChanged('## Summary', body('🔨 Waiting for CI · checks: 3 pending · updated Nov 16 14:00 UTC')), 'a block added');
});
