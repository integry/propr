import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PR_STATUS_BLOCK_MAX_LENGTH } from '@propr/shared';
import {
    computePullRequestStatus,
    type PullRequestStatusFacts,
    type PullRequestStatusTask,
} from '../src/services/pullRequestStatus/pullRequestStatus.js';
import {
    applyPullRequestStatusBlock,
    extractPullRequestStatusBlock,
    isStatusBlockOnlyEdit,
    PR_STATUS_BLOCK_END,
    PR_STATUS_BLOCK_START,
    preservePullRequestStatusBlock,
    renderCompactPullRequestStatusBlock,
    renderPullRequestStatusBlock,
    renderPullRequestStatusLine,
    sameRenderedStatus,
    stripPullRequestStatusBlock,
} from '../src/services/pullRequestStatus/pullRequestStatusBlock.js';

const NOW = new Date('2026-11-13T09:41:00Z');

function facts(overrides: Partial<PullRequestStatusFacts> = {}): PullRequestStatusFacts {
    return {
        pullRequest: { state: 'open', merged: false, headSha: 'abc', mergeable: true },
        isProprPullRequest: true,
        tasks: [{ type: 'issue', mode: null, state: 'completed', createdAt: '2026-11-13T09:00:00Z' }],
        queuedJobs: 0,
        ultrafix: null,
        checks: { complete: true, passed: 35, failed: 0, pending: 0, failedNames: [] },
        latestReviewScore: null,
        ratingGoal: 7,
        epic: null,
        ...overrides,
    };
}

function task(type: string, state: string, mode: PullRequestStatusTask['mode'] = null, createdAt = '2026-11-13T09:30:00Z'): PullRequestStatusTask {
    return { type, mode, state, createdAt };
}

const loop = (overrides: Partial<NonNullable<PullRequestStatusFacts['ultrafix']>> = {}): NonNullable<PullRequestStatusFacts['ultrafix']> => ({
    active: true, cycleCount: 2, maxCycles: 10, goal: 7, completionStatus: null, completionReason: null,
    finalScore: null, completedAt: null, waitingForCi: false, ...overrides,
});

// --- state table: none ---

test('closed, merged and non-ProPR pull requests have no status', () => {
    assert.equal(computePullRequestStatus(facts({ pullRequest: { state: 'closed', merged: false, headSha: 'a', mergeable: true } })).state, 'none');
    assert.equal(computePullRequestStatus(facts({ pullRequest: { state: 'closed', merged: true, headSha: 'a', mergeable: true } })).state, 'none');
    assert.equal(computePullRequestStatus(facts({ isProprPullRequest: false })).state, 'none');
});

// --- state table: working ---

test('a queued or running ProPR task is working, with its activity', () => {
    const cases: Array<[PullRequestStatusTask, string]> = [
        [task('issue', 'claude_execution'), 'implementing'],
        [task('pr-comment', 'pending', 'follow_up'), 'follow_up'],
        [task('pr-comment', 'processing', 'review'), 'review'],
        [task('review', 'processing'), 'review'],
        [task('merge_conflict', 'post_processing'), 'resolving_conflicts'],
    ];
    for (const [running, activity] of cases) {
        const status = computePullRequestStatus(facts({ tasks: [running] }));
        assert.equal(status.state, 'working', activity);
        assert.equal(status.detail.activity, activity);
    }
});

test('a queued job that has no task yet is working', () => {
    const status = computePullRequestStatus(facts({ queuedJobs: 1 }));
    assert.equal(status.state, 'working');
    assert.equal(status.detail.activity, 'queued');
});

test('an active Ultrafix loop is working, including while it waits for CI', () => {
    const cycling = computePullRequestStatus(facts({ ultrafix: loop() }));
    assert.equal(cycling.state, 'working');
    assert.equal(cycling.detail.activity, 'ultrafix');
    assert.deepEqual(cycling.detail.ultrafix, { cycle: 3, maxCycles: 10 });

    const waiting = computePullRequestStatus(facts({ ultrafix: loop({ waitingForCi: true }) }));
    assert.equal(waiting.state, 'working');
    assert.equal(waiting.detail.activity, 'waiting_for_ci');
});

test('checks still pending on the current head are working', () => {
    const status = computePullRequestStatus(facts({ checks: { complete: true, passed: 31, failed: 0, pending: 4, failedNames: [] } }));
    assert.equal(status.state, 'working');
    assert.equal(status.detail.activity, 'waiting_for_ci');
});

test('goal reached while checks are pending is working, not ready', () => {
    const status = computePullRequestStatus(facts({
        latestReviewScore: 8,
        ultrafix: loop({ active: false, completionStatus: 'succeeded', completionReason: 'goal_reached', finalScore: 8, completedAt: '2026-11-13T09:40:00Z' }),
        checks: { complete: true, passed: 30, failed: 0, pending: 5, failedNames: [] },
    }));
    assert.equal(status.state, 'working');
    assert.equal(status.detail.activity, 'waiting_for_ci');
});

// --- state table: needs_attention ---

test('the last ProPR run failed', () => {
    const status = computePullRequestStatus(facts({ tasks: [task('pr-comment', 'failed', 'follow_up'), task('issue', 'completed')] }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'last_run_failed');
});

test('a failed conflict resolution needs attention', () => {
    const status = computePullRequestStatus(facts({ tasks: [task('merge_conflict', 'failed')], pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'conflict_resolution_failed');
});

test('an Ultrafix loop that ended without its goal needs attention', () => {
    const status = computePullRequestStatus(facts({
        latestReviewScore: 6,
        ultrafix: loop({ active: false, cycleCount: 10, completionStatus: 'failed', completionReason: 'cycles_exhausted', finalScore: 6, completedAt: '2026-11-13T10:00:00Z' }),
    }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'ultrafix_stopped');
    assert.deepEqual(status.detail.ultrafixStopped, { cycles: 10, finalScore: 6, reason: 'cycles_exhausted' });
});

test('an Ultrafix stop is superseded by a ProPR run started after it', () => {
    const status = computePullRequestStatus(facts({
        tasks: [task('pr-comment', 'completed', 'follow_up', '2026-11-13T11:00:00Z')],
        latestReviewScore: 8,
        ultrafix: loop({ active: false, completionStatus: 'failed', completionReason: 'CI did not settle', completedAt: '2026-11-13T10:00:00Z' }),
    }));
    assert.equal(status.state, 'ready');
});

test('goal reached with a failed check needs attention', () => {
    const status = computePullRequestStatus(facts({
        latestReviewScore: 8,
        ultrafix: loop({ active: false, completionStatus: 'succeeded', completionReason: 'goal_reached', finalScore: 8, completedAt: '2026-11-13T09:40:00Z' }),
        checks: { complete: true, passed: 34, failed: 1, pending: 0, failedNames: ['unit tests'] },
    }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'check_failed');
    assert.deepEqual(status.detail.failedChecks, ['unit tests']);
});

test('goal reached with one failed check and another still pending needs attention', () => {
    const status = computePullRequestStatus(facts({
        latestReviewScore: 8,
        ultrafix: loop({ active: false, completionStatus: 'succeeded', completionReason: 'goal_reached', finalScore: 8, completedAt: '2026-11-13T09:40:00Z' }),
        checks: { complete: true, passed: 33, failed: 1, pending: 1, failedNames: ['unit tests'] },
    }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'check_failed');
    assert.equal(status.detail.activity, null);
    assert.deepEqual(status.detail.checks, { passed: 33, failed: 1, pending: 1 });
    assert.match(renderPullRequestStatusLine(status, NOW), /^\*\*ProPR\*\* ⚠️ Needs you · failed: unit tests · review 8\/10 · checks: 33 passed, 1 failed, 1 pending · /);
});

test('checks still pending never hide a confirmed problem once no ProPR work is left', () => {
    const pending = { complete: true, passed: 30, failed: 0, pending: 2, failedNames: [] };
    const conflicting = { state: 'open', merged: false, headSha: 'a', mergeable: false };
    const cases: Array<[Partial<PullRequestStatusFacts>, string]> = [
        [{ tasks: [task('pr-comment', 'failed', 'follow_up')] }, 'last_run_failed'],
        [{ tasks: [task('merge_conflict', 'failed')], pullRequest: conflicting }, 'conflict_resolution_failed'],
        [{ ultrafix: loop({ active: false, cycleCount: 10, completionStatus: 'failed', completionReason: 'cycles_exhausted', finalScore: 6, completedAt: '2026-11-13T10:00:00Z' }) }, 'ultrafix_stopped'],
        [{ pullRequest: conflicting }, 'merge_conflict'],
        [{ latestReviewScore: 6 }, 'review_below_goal'],
    ];
    for (const [overrides, reason] of cases) {
        const status = computePullRequestStatus(facts({ checks: pending, ...overrides }));
        assert.equal(status.state, 'needs_attention', reason);
        assert.equal(status.detail.reason, reason);
    }
});

test('ProPR work still in progress stays working over a failed check while others are pending', () => {
    const mixed = { complete: true, passed: 30, failed: 1, pending: 1, failedNames: ['unit'] };
    const running = computePullRequestStatus(facts({ checks: mixed, tasks: [task('pr-comment', 'processing', 'follow_up')] }));
    assert.equal(running.state, 'working');
    assert.equal(running.detail.activity, 'follow_up');
    const cycling = computePullRequestStatus(facts({ checks: mixed, ultrafix: loop() }));
    assert.equal(cycling.state, 'working');
    assert.equal(cycling.detail.activity, 'waiting_for_ci');
    const queued = computePullRequestStatus(facts({ checks: mixed, queuedJobs: 1 }));
    assert.equal(queued.state, 'working');
    assert.equal(queued.detail.activity, 'queued');
});

test('checks partly unread with some still pending wait for CI: being unread is no confirmed problem', () => {
    const status = computePullRequestStatus(facts({ checks: { complete: false, passed: 3, failed: 0, pending: 2, failedNames: [] } }));
    assert.equal(status.state, 'working');
    assert.equal(status.detail.activity, 'waiting_for_ci');
    // A failure among the checks that were read is confirmed, read completely or not.
    const failed = computePullRequestStatus(facts({ checks: { complete: false, passed: 3, failed: 1, pending: 2, failedNames: ['lint'] } }));
    assert.equal(failed.state, 'needs_attention');
    assert.equal(failed.detail.reason, 'check_failed');
});

test('a conflict with the base and no resolution queued needs attention', () => {
    const status = computePullRequestStatus(facts({ pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'merge_conflict');
});

test('a queued conflict resolution is working, not needs attention', () => {
    const status = computePullRequestStatus(facts({ tasks: [task('merge_conflict', 'pending')], pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(status.state, 'working');
    assert.equal(status.detail.activity, 'resolving_conflicts');
});

test('reviewed below the goal with nothing running needs attention', () => {
    const status = computePullRequestStatus(facts({ latestReviewScore: 6 }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'review_below_goal');
});

test('checks that could not be read never report ready', () => {
    const status = computePullRequestStatus(facts({ checks: { complete: false, passed: 3, failed: 0, pending: 0, failedNames: [] } }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'checks_unavailable');
});

test('unknown mergeability is never ready: the status waits for GitHub to finish computing it', () => {
    const unknown = { state: 'open', merged: false, headSha: 'a', mergeable: null };
    for (const latestReviewScore of [null, 7, 8]) {
        const status = computePullRequestStatus(facts({ pullRequest: unknown, latestReviewScore }));
        assert.equal(status.state, 'working');
        assert.equal(status.detail.activity, 'checking_mergeability');
        assert.match(renderPullRequestStatusLine(status, NOW), /^\*\*ProPR\*\* 🔨 Checking for conflicts · /);
    }
    // A known problem still needs you while mergeability is being computed.
    const failed = computePullRequestStatus(facts({ pullRequest: unknown, checks: { complete: true, passed: 1, failed: 1, pending: 0, failedNames: ['unit'] } }));
    assert.equal(failed.state, 'needs_attention');
    assert.equal(computePullRequestStatus(facts({ pullRequest: unknown, latestReviewScore: 6 })).detail.reason, 'review_below_goal');
});

// --- state table: ready ---

test('never reviewed with passing checks is ready', () => {
    const status = computePullRequestStatus(facts());
    assert.equal(status.state, 'ready');
    assert.equal(status.detail.reviewScore, null);
    assert.deepEqual(status.detail.checks, { passed: 35, failed: 0, pending: 0 });
});

test('reviewed at the goal with passing checks and no conflict is ready', () => {
    assert.equal(computePullRequestStatus(facts({ latestReviewScore: 7 })).state, 'ready');
    assert.equal(computePullRequestStatus(facts({ latestReviewScore: 8 })).state, 'ready');
});

// --- block rendering ---

test('the block renders the documented one-line examples', () => {
    assert.equal(
        renderPullRequestStatusLine(computePullRequestStatus(facts({
            tasks: [task('pr-comment', 'claude_execution', 'follow_up')], ultrafix: loop(), latestReviewScore: 6,
            checks: { complete: true, passed: 31, failed: 0, pending: 4, failedNames: [] },
        })), NOW),
        '**ProPR** 🔨 Follow-up in progress · Ultrafix cycle 3 of 10 · last review 6/10 · checks: 31 passed, 4 pending · updated 09:41 UTC',
    );
    assert.equal(
        renderPullRequestStatusLine(computePullRequestStatus(facts({ latestReviewScore: 8 })), new Date('2026-11-13T10:02:00Z')),
        '**ProPR** ✅ Ready · review 8/10 · checks: 35 passed · updated 10:02 UTC',
    );
    assert.equal(
        renderPullRequestStatusLine(computePullRequestStatus(facts({
            latestReviewScore: 6,
            ultrafix: loop({ active: false, cycleCount: 10, completionStatus: 'failed', completionReason: 'cycles_exhausted', finalScore: 6, completedAt: '2026-11-13T10:00:00Z' }),
        })), new Date('2026-11-13T10:15:00Z')),
        '**ProPR** ⚠️ Needs you · Ultrafix stopped after 10 cycles at 6/10 · updated 10:15 UTC',
    );
});

test('epic pull requests show merged and total issue counts', () => {
    const line = renderPullRequestStatusLine(computePullRequestStatus(facts({ epic: { merged: 2, total: 5 } })), NOW);
    assert.match(line, /issues: 2 of 5 merged/);
});

test('failed check names cannot break out of the one-line block', () => {
    const line = renderPullRequestStatusLine(computePullRequestStatus(facts({
        checks: { complete: true, passed: 1, failed: 1, pending: 0, failedNames: ['evil\n<!-- /propr:pr-status -->**x**'] },
    })), NOW);
    assert.equal(line.includes('\n'), false);
    assert.equal(line.includes(PR_STATUS_BLOCK_END), false);
});

test('the block never exceeds the size new descriptions reserve for it', () => {
    const longName = 'n'.repeat(200);
    const worst = computePullRequestStatus(facts({
        latestReviewScore: Number.MAX_SAFE_INTEGER, ratingGoal: 10,
        checks: { complete: true, passed: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER, pending: 0, failedNames: Array.from({ length: 99_999 }, () => longName) },
        tasks: [task('issue', 'completed')], epic: { merged: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
    }));
    assert.equal(worst.state, 'needs_attention');
    const block = renderPullRequestStatusBlock(worst, NOW);
    assert.ok(block && block.length <= PR_STATUS_BLOCK_MAX_LENGTH, `block is ${block?.length} characters`);
    assert.match(block!, /updated 09:41 UTC\n<!-- \/propr:pr-status -->$/, 'the block keeps its markers and update time');
    // Every state stays within the bound.
    for (const status of [computePullRequestStatus(facts()), computePullRequestStatus(facts({ tasks: [task('issue', 'processing')] }))]) {
        assert.ok(renderPullRequestStatusBlock(status, NOW)!.length <= PR_STATUS_BLOCK_MAX_LENGTH);
    }
});

test('the compact block keeps only the headline and the update time', () => {
    const status = computePullRequestStatus(facts({ latestReviewScore: 6 }));
    assert.equal(renderCompactPullRequestStatusBlock(status, NOW), `${PR_STATUS_BLOCK_START}\n**ProPR** ⚠️ Needs you · updated 09:41 UTC\n${PR_STATUS_BLOCK_END}`);
    assert.equal(renderCompactPullRequestStatusBlock(computePullRequestStatus(facts({ isProprPullRequest: false })), NOW), null);
});

test('none renders no block', () => {
    assert.equal(renderPullRequestStatusBlock(computePullRequestStatus(facts({ isProprPullRequest: false })), NOW), null);
});

// --- body editing ---

const HUMAN_BODY = [
    '## Summary',
    '',
    'Implementation summary.',
    '',
    'A human added this line.\r\n',
    '<!-- propr-continuation:task-1 -->',
    '',
    '<!-- propr:visual-preview -->',
    '### Visual preview',
    '![desktop](https://github.com/user-attachments/assets/1)',
    '<!-- /propr:visual-preview -->',
    '',
    'Fixes #12',
].join('\n');

function blockFor(overrides: Partial<PullRequestStatusFacts>, now = NOW): string {
    return renderPullRequestStatusBlock(computePullRequestStatus(facts(overrides)), now)!;
}

test('the block is inserted first, replaced in place and removed without touching the rest of the body', () => {
    const working = blockFor({ tasks: [task('pr-comment', 'processing', 'follow_up')] });
    const inserted = applyPullRequestStatusBlock(HUMAN_BODY, working);
    assert.ok(inserted.startsWith(`${PR_STATUS_BLOCK_START}\n**ProPR** 🔨`));
    assert.equal(stripPullRequestStatusBlock(inserted), HUMAN_BODY);

    const ready = blockFor({});
    const replaced = applyPullRequestStatusBlock(inserted, ready);
    assert.equal(extractPullRequestStatusBlock(replaced), ready);
    assert.equal(stripPullRequestStatusBlock(replaced), HUMAN_BODY);
    assert.equal(replaced.split(PR_STATUS_BLOCK_START).length, 2, 'exactly one block');

    assert.equal(applyPullRequestStatusBlock(replaced, null), HUMAN_BODY);
    assert.equal(applyPullRequestStatusBlock(HUMAN_BODY, null), HUMAN_BODY);
    assert.equal(applyPullRequestStatusBlock('', ready), ready);
    assert.equal(applyPullRequestStatusBlock(ready, null), '');
});

test('a block a human moved below their own text is updated where it is', () => {
    const working = blockFor({ queuedJobs: 1 });
    const body = `Human preface\n\n${working}\n\nRest`;
    const updated = applyPullRequestStatusBlock(body, blockFor({}));
    assert.equal(updated, `Human preface\n\n${blockFor({})}\n\nRest`);
});

test('another ProPR body writer keeps the current block and never duplicates it', () => {
    const current = applyPullRequestStatusBlock(HUMAN_BODY, blockFor({}));
    const rewritten = `${HUMAN_BODY}\n\nNew visual preview section`;
    const preserved = preservePullRequestStatusBlock(rewritten, current);
    assert.equal(extractPullRequestStatusBlock(preserved), blockFor({}));
    assert.equal(stripPullRequestStatusBlock(preserved), rewritten);
    // A writer that started from the current body (block included) does not get a second block.
    assert.equal(preservePullRequestStatusBlock(current, current), current);
    // Nothing to preserve: the writer's body is written as is.
    assert.equal(preservePullRequestStatusBlock(rewritten, HUMAN_BODY), rewritten);
});

test('bodies that differ only in the update time are the same status', () => {
    const a = applyPullRequestStatusBlock(HUMAN_BODY, blockFor({}, new Date('2026-11-13T09:00:00Z')));
    const b = applyPullRequestStatusBlock(HUMAN_BODY, blockFor({}, new Date('2026-11-13T09:05:00Z')));
    assert.notEqual(a, b);
    assert.equal(sameRenderedStatus(a, b), true);
    assert.equal(sameRenderedStatus(a, applyPullRequestStatusBlock(HUMAN_BODY, blockFor({ latestReviewScore: 6 }))), false);
});

test('an edited event that only changed the status block is recognised as ProPR\'s own edit', () => {
    const before = applyPullRequestStatusBlock(HUMAN_BODY, blockFor({ queuedJobs: 1 }));
    const after = applyPullRequestStatusBlock(HUMAN_BODY, blockFor({}));
    assert.equal(isStatusBlockOnlyEdit({ action: 'edited', changes: { body: { from: before } }, pull_request: { body: after } }), true);
    assert.equal(isStatusBlockOnlyEdit({ action: 'edited', changes: { body: { from: HUMAN_BODY } }, pull_request: { body: after } }), true, 'block inserted');
    assert.equal(isStatusBlockOnlyEdit({ action: 'edited', changes: { body: { from: before } }, pull_request: { body: HUMAN_BODY } }), true, 'block removed');
    assert.equal(isStatusBlockOnlyEdit({ action: 'edited', changes: { body: { from: before } }, pull_request: { body: `${after}\nhuman` } }), false);
    assert.equal(isStatusBlockOnlyEdit({ action: 'edited', changes: { title: { from: 'x' }, body: { from: before } }, pull_request: { body: after } } as never), false);
    assert.equal(isStatusBlockOnlyEdit({ action: 'opened', pull_request: { body: after } }), false);
});
