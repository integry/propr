import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readStatusSlot, renderStatusSlot } from '@propr/shared';
import {
    computePullRequestStatus,
    isUndeterminedPullRequestStatus,
    type EpicChildStatus,
    type EpicStatusFacts,
    type PullRequestStatus,
    type PullRequestStatusFacts,
} from '../src/services/pullRequestStatus/pullRequestStatus.js';
import {
    describeChildStatus, renderCompactPullRequestStatusBlock, renderPullRequestStatusLine,
} from '../src/services/pullRequestStatus/pullRequestStatusBlock.js';
import { decidePullRequestTitle, titleStatusOf } from '../src/services/pullRequestStatus/pullRequestStatusTitle.js';

// The progress comment module reads GitHub credentials on import.
process.env.PROPR_DEMO_MODE = 'true';
const { epicProgressActivity, renderOpenEpicProgressComment } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicSync.js');
const { closeConnection } = await import('../src/db/connection.js');

after(async () => {
    await closeConnection();
});

const NOW = new Date('2026-11-13T09:41:00Z');

function facts(overrides: Partial<PullRequestStatusFacts> = {}): PullRequestStatusFacts {
    return {
        pullRequest: { state: 'open', merged: false, headSha: 'abc', mergeable: true },
        isProprPullRequest: true,
        tasks: [],
        queuedJobs: 0,
        ultrafix: null,
        checks: { complete: true, passed: 12, failed: 0, pending: 0, failedNames: [] },
        latestReviewScore: 9,
        ratingGoal: 7,
        epic: null,
        ...overrides,
    };
}

/** A sub-PR's own status, computed by the same computation. */
function childStatus(overrides: Partial<PullRequestStatusFacts>): PullRequestStatus {
    return computePullRequestStatus(facts({ tasks: [{ type: 'issue', mode: null, state: 'completed', createdAt: '2026-11-13T09:00:00Z' }], ...overrides }));
}

const ULTRAFIX_CHILD = childStatus({
    latestReviewScore: 6,
    ultrafix: { active: true, cycleCount: 3, maxCycles: 10, goal: 8, completionStatus: null, completionReason: null, finalScore: null, completedAt: null, waitingForCi: false },
});
const READY_CHILD = childStatus({ latestReviewScore: 8 });
const FAILED_CHILD = childStatus({ checks: { complete: true, passed: 3, failed: 1, pending: 0, failedNames: ['unit'] } });

function child(status: PullRequestStatus, prNumber = 3523, issueNumber: number | null = 3475): EpicChildStatus {
    return { prNumber, issueNumber, title: 'Let an automation run when a plan issue is blocked', status };
}

function epic(overrides: Partial<EpicStatusFacts> = {}): PullRequestStatusFacts {
    return facts({ epic: { merged: 3, total: 5, children: [], startedIssues: [], upNext: [], nextIssueQueued: false, queuePaused: false, ...overrides } });
}

function line(status: PullRequestStatus): string {
    return renderPullRequestStatusLine(status, NOW);
}

// --- state table ---

test('an epic with a working sub-PR is working and names the issue in progress', () => {
    const status = computePullRequestStatus(epic({ children: [child(ULTRAFIX_CHILD)] }));
    assert.equal(status.state, 'working');
    assert.equal(line(status), '**ProPR** 🔨 3 of 5 issues merged · #3475 in progress (Ultrafix cycle 4 of 10, last review 6/10) · updated 09:41 UTC');
    assert.equal(status.detail.reviewScore, null, 'an epic shows no review score');
});

test('an epic whose issue started without a sub-PR yet is working', () => {
    const status = computePullRequestStatus(epic({ startedIssues: [{ issueNumber: 3476, title: 'Next', working: true }] }));
    assert.equal(status.state, 'working');
    assert.match(line(status), /🔨 3 of 5 issues merged · #3476 in progress ·/);
});

test('an epic whose next issue is queued to start is working', () => {
    const status = computePullRequestStatus(epic({ nextIssueQueued: true, upNext: [{ issueNumber: 3477, title: null }] }));
    assert.equal(status.state, 'working');
    assert.match(line(status), /🔨 3 of 5 issues merged · #3477 starts next ·/);
});

test('a working sub-PR outweighs another that needs a person', () => {
    const status = computePullRequestStatus(epic({ children: [child(FAILED_CHILD, 3524, 3476), child(ULTRAFIX_CHILD)] }));
    assert.equal(status.state, 'working');
});

test('a ready sub-PR waiting to be merged makes the epic need attention and names the PR', () => {
    const status = computePullRequestStatus(epic({ children: [child(READY_CHILD)] }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'epic_child_ready');
    assert.equal(line(status), '**ProPR** ⚠️ 3 of 5 issues merged · #3523 (issue #3475) waits to be merged into the epic branch · updated 09:41 UTC');
});

test('a sub-PR that needs a person makes the epic need attention, with its reason', () => {
    const status = computePullRequestStatus(epic({ children: [child(FAILED_CHILD)] }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'epic_child_needs_attention');
    assert.match(line(status), /⚠️ 3 of 5 issues merged · #3523 \(issue #3475\) needs you \(checks failed, review 9\/10\)/);
});

test('a paused queue, a conflict with the base, or nothing left running needs attention', () => {
    const paused = computePullRequestStatus(epic({ queuePaused: true, nextIssueQueued: true }));
    assert.equal(paused.state, 'needs_attention');
    assert.match(line(paused), /⚠️ 3 of 5 issues merged · queue paused/);
    const conflict = computePullRequestStatus(facts({ ...epic(), pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(conflict.detail.reason, 'merge_conflict');
    assert.match(line(conflict), /conflicts with base/);
    assert.equal(computePullRequestStatus(epic()).detail.reason, 'epic_idle');
});

test('sub-PRs people opened (no ProPR status) do not decide the epic', () => {
    const none = computePullRequestStatus(facts({ isProprPullRequest: false }));
    assert.equal(computePullRequestStatus(epic({ children: [child(none)], nextIssueQueued: true })).state, 'working');
});

test('every issue merged with passing checks is ready; a failed check or a conflict needs attention', () => {
    const ready = computePullRequestStatus(epic({ merged: 5, total: 5 }));
    assert.equal(ready.state, 'ready');
    assert.equal(line(ready), '**ProPR** ✅ 5 of 5 issues merged · checks: 12 passed · updated 09:41 UTC');
    const failed = computePullRequestStatus(facts({ ...epic({ merged: 5, total: 5 }), checks: { complete: true, passed: 2, failed: 1, pending: 0, failedNames: ['build'] } }));
    assert.equal(failed.state, 'needs_attention');
    assert.match(line(failed), /⚠️ 5 of 5 issues merged · failed: build/);
    const conflict = computePullRequestStatus(facts({ ...epic({ merged: 5, total: 5 }), pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(conflict.state, 'needs_attention');
    assert.match(line(conflict), /⚠️ 5 of 5 issues merged · conflicts with base/);
    const pending = computePullRequestStatus(facts({ ...epic({ merged: 5, total: 5 }), checks: { complete: true, passed: 2, failed: 0, pending: 1, failedNames: [] } }));
    assert.equal(pending.state, 'working', 'not ready until every check on the head completed');
});

test('a review score below the goal never holds an epic back', () => {
    assert.equal(computePullRequestStatus(facts({ ...epic({ merged: 5, total: 5 }), latestReviewScore: 3 })).state, 'ready');
});

test('an epic whose remaining issues were all closed without a merge shows no review score and is not held back by it', () => {
    // Closed issues are excluded from the progress, so the epic has no issue left to count.
    const status = computePullRequestStatus(facts({ ...epic({ merged: 0, total: 0 }), latestReviewScore: 3 }));
    assert.equal(status.state, 'ready');
    assert.equal(status.detail.reason, null);
    assert.equal(status.detail.reviewScore, null);
    assert.equal(line(status), '**ProPR** ✅ Ready · checks: 12 passed · updated 09:41 UTC', 'no empty progress count, no score');
    assert.equal(renderStatusSlot(titleStatusOf(status)), '✅', 'the title slot shows neither a count nor a score');
    const conflict = computePullRequestStatus(facts({ ...epic({ merged: 0, total: 0 }), latestReviewScore: 3, pullRequest: { state: 'open', merged: false, headSha: 'a', mergeable: false } }));
    assert.equal(conflict.detail.reason, 'merge_conflict', 'its own facts still decide');
    assert.equal(line(conflict), '**ProPR** ⚠️ Needs you · conflicts with base · checks: 12 passed · updated 09:41 UTC');
});

test('the compact block keeps the progress', () => {
    assert.match(renderCompactPullRequestStatusBlock(computePullRequestStatus(epic({ nextIssueQueued: true })), NOW)!, /\*\*ProPR\*\* 🔨 3 of 5 issues merged · updated 09:41 UTC/);
});

// --- title slot ---

test('the title slot shows the state and merged/total, never a score', () => {
    const slot = (status: PullRequestStatus) => renderStatusSlot(titleStatusOf(status));
    assert.equal(slot(computePullRequestStatus(epic({ nextIssueQueued: true }))), '◑ 3/5');
    assert.equal(slot(computePullRequestStatus(epic({ children: [child(READY_CHILD)] }))), '⚠️ 3/5');
    assert.equal(slot(computePullRequestStatus(epic({ merged: 5, total: 5 }))), '✅ 5/5');
    assert.equal(readStatusSlot('🔨 3/5 [Epic] Scheduler primitives'), '🔨 3/5', 'a legacy working epic slot is still read');
    assert.equal(readStatusSlot('◑ 3/5 [Epic] Scheduler primitives'), '◑ 3/5');
});

test('a working epic title shows a pie circle; ⚠️, ✅ and ordinary working pull requests are unchanged', () => {
    const slot = (overrides: Partial<EpicStatusFacts>) => renderStatusSlot(titleStatusOf(computePullRequestStatus(epic(overrides))));
    assert.equal(slot({ merged: 0, total: 5, nextIssueQueued: true }), '○ 0/5');
    assert.equal(slot({ merged: 1, total: 5, nextIssueQueued: true }), '◔ 1/5');
    assert.equal(slot({ merged: 4, total: 5, nextIssueQueued: true }), '◕ 4/5');
    assert.equal(slot({ merged: 5, total: 5 }), '✅ 5/5');
    assert.equal(renderStatusSlot(titleStatusOf(computePullRequestStatus(facts({ checks: { complete: false, passed: 3, failed: 0, pending: 2, failedNames: [] } })))), '🔨');
});

test('a legacy 🔨 epic title is rewritten to its circle once, as one slot, and then left alone', async () => {
    const status = computePullRequestStatus(epic({ merged: 3, total: 21, nextIssueQueued: true }));
    const input = { repository: 'integry/propr', prNumber: 7, status, isProprPullRequest: true, enabled: true, redis: null };
    const legacy = await decidePullRequestTitle({ ...input, title: '🔨 3/21 [Epic] Plugin system' });
    assert.deepEqual(legacy, { title: '◔ 3/21 [Epic] Plugin system', settleInMs: null });
    assert.deepEqual(await decidePullRequestTitle({ ...input, title: '◔ 3/21 [Epic] Plugin system' }), { title: null, settleInMs: null }, 'no rename when the slot is right');
});

test('activity inside working leaves the epic title slot as it is', () => {
    const slot = (overrides: Partial<EpicStatusFacts>) => renderStatusSlot(titleStatusOf(computePullRequestStatus(epic(overrides))));
    assert.equal(slot({ children: [child(ULTRAFIX_CHILD)] }), slot({ nextIssueQueued: true }));
    assert.notEqual(slot({ merged: 4, nextIssueQueued: true }), slot({ nextIssueQueued: true }), 'a merge changes the count');
});

// --- progress comment activity ---

test('sub-PR states read in a few words', () => {
    assert.equal(describeChildStatus(ULTRAFIX_CHILD, 'comment'), 'review 6/10, Ultrafix cycle 4 of 10');
    assert.equal(describeChildStatus(READY_CHILD, 'comment'), 'review 8/10, ready to merge');
    assert.equal(describeChildStatus(null, 'comment'), '');
});

test('the progress comment lists what is in progress and what is next', () => {
    const facts: EpicStatusFacts = {
        merged: 5, total: 7,
        children: [child(ULTRAFIX_CHILD)],
        startedIssues: [{ issueNumber: 3480, title: 'Started without a pull request', working: true }],
        upNext: [{ issueNumber: 3481, title: 'Last one' }],
        progress: { merged: 5, total: 7, excluded: 0, mergedPullRequests: [3490, 3504, 3507, 3515, 3518] },
        planName: 'Scheduler primitives',
    };
    assert.deepEqual(epicProgressActivity(facts).inProgress.map(item => item.prNumber), [3523, null]);
    const comment = renderOpenEpicProgressComment(facts)!;
    assert.match(comment, /Merged child PRs: #3490, #3504, #3507, #3515, #3518\n\nIn progress: #3523 \(issue #3475, Let an automation run when a plan issue is blocked\) - review 6\/10, Ultrafix cycle 4 of 10; #3480 \(Started without a pull request\)\n\nUp next: #3481 \(Last one\)\n/);
    const last = renderOpenEpicProgressComment({ ...facts, startedIssues: [], upNext: [] })!;
    assert.match(last, /\nUp next: none\n/);
    const idle = renderOpenEpicProgressComment({ ...facts, children: [], startedIssues: [], upNext: [] })!;
    assert.doesNotMatch(idle, /In progress|Up next/, 'empty lines are left out');
});

test('a title cannot close the progress comment\'s markup, with either comment end', () => {
    const comment = renderOpenEpicProgressComment({
        merged: 1, total: 3, children: [],
        startedIssues: [{ issueNumber: 3480, title: 'a --> b --!> c <!-- d', working: true }],
        progress: { merged: 1, total: 3, excluded: 0, mergedPullRequests: [3490] },
        planName: 'Scheduler primitives',
    })!;
    assert.match(comment, /In progress: #3480 \(a b c d\)/);
});

// --- an issue stopped on a reported blocker ---

test('an issue stopped on a reported blocker needs a person, not a hammer', () => {
    const status = computePullRequestStatus(epic({ startedIssues: [{ issueNumber: 3476, title: 'Blocked', working: false, blocked: true }] }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'epic_issue_blocked');
    assert.equal(status.detail.epic?.focus?.issueNumber, 3476);
    assert.match(line(status), /^\*\*ProPR\*\* ⚠️ 3 of 5 issues merged · #3476 stopped on a blocker · /);
    // Even a status still marked working is not running once the issue is blocked.
    assert.equal(computePullRequestStatus(epic({ startedIssues: [{ issueNumber: 3476, title: null, working: true, blocked: true }] })).detail.reason, 'epic_issue_blocked');
});

test('running sibling work still wins over a blocked issue', () => {
    const blocked = { issueNumber: 3476, title: null, working: false, blocked: true };
    const sibling = computePullRequestStatus(epic({ startedIssues: [blocked, { issueNumber: 3477, title: null, working: true }] }));
    assert.equal(sibling.state, 'working');
    assert.equal(sibling.detail.epic?.focus?.issueNumber, 3477);
    const child3523 = computePullRequestStatus(epic({ startedIssues: [blocked], children: [child(ULTRAFIX_CHILD)] }));
    assert.equal(child3523.state, 'working');
    assert.equal(child3523.detail.epic?.focus?.prNumber, 3523);
});

test('the progress comment names a blocked issue as stopped', () => {
    const activity = epicProgressActivity({ merged: 1, total: 3, startedIssues: [{ issueNumber: 3476, title: 'Blocked', working: false, blocked: true }] });
    assert.equal(activity.inProgress[0].state, 'stopped on a blocker');
});

// --- sub-PRs beyond the status read budget ---

test('a sub-PR whose status was not read keeps the epic undetermined rather than waiting on a person', () => {
    const ready = Array.from({ length: 10 }, (_, index) => child(READY_CHILD, 3600 + index, 3700 + index));
    const unread: EpicChildStatus = { prNumber: 3610, issueNumber: 3710, title: 'Eleventh', status: null, statusUnread: true };
    const status = computePullRequestStatus(epic({ children: [...ready, unread] }));
    assert.equal(status.state, 'needs_attention');
    assert.equal(status.detail.reason, 'epic_children_unread');
    assert.equal(status.detail.epic?.unreadChildren, 1);
    assert.ok(isUndeterminedPullRequestStatus(status), 'the status sync does not publish it');
    // Without the unread sub-PR the same facts are established: a ready sub-PR waits to be merged.
    const known = computePullRequestStatus(epic({ children: ready }));
    assert.equal(known.detail.reason, 'epic_child_ready');
    assert.equal(isUndeterminedPullRequestStatus(known), false);
    // A child with no ProPR status (null, read) is not unread.
    assert.equal(computePullRequestStatus(epic({ children: [...ready, { ...unread, statusUnread: false }] })).detail.reason, 'epic_child_ready');
});

test('a working sub-PR within the read budget still settles the epic as working', () => {
    const unread: EpicChildStatus = { prNumber: 3610, issueNumber: 3710, title: null, status: null, statusUnread: true };
    const status = computePullRequestStatus(epic({ children: [child(ULTRAFIX_CHILD), unread] }));
    assert.equal(status.state, 'working');
    assert.equal(isUndeterminedPullRequestStatus(status), false);
    assert.equal(computePullRequestStatus(epic({ children: [unread], nextIssueQueued: true })).state, 'working');
});
