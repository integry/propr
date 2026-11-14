import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { EpicChildPullRequest } from '../src/webhook/epicMergeProgress.js';
import type { PullRequestStatus } from '../src/services/pullRequestStatus/pullRequestStatus.js';
import {
    MAX_EPIC_CHILD_STATUSES, MAX_STALLED_EPIC_CHILD_READ_PASSES, noteEpicChildReadPass, planEpicChildReads, resetEpicChildReadsForTests,
    retainEpicChildStatus,
} from '../src/services/pullRequestStatus/pullRequestStatusEpicChildReads.js';

const EPIC_KEY = 'integry/propr#900';
const STATUS = { state: 'ready', detail: {} } as unknown as PullRequestStatus;

function openSubPrs(count: number, from = 1000): EpicChildPullRequest[] {
    return Array.from({ length: count }, (_, index) => ({
        number: from + index, merged: false, abandoned: false, open: true, headSha: `h${from + index}`, updatedAt: '2026-11-14T09:00:00Z',
    }));
}

/** One epic update, as childStatuses runs it: plan, read and keep, then note the pass. */
function pass(children: EpicChildPullRequest[], now: number): { read: Set<number>; unread: number; continueReads: boolean } {
    const plan = planEpicChildReads(EPIC_KEY, children, now);
    for (const child of children) if (plan.read.has(child.number)) retainEpicChildStatus(EPIC_KEY, child, STATUS, now);
    const unread = children.filter(child => !plan.read.has(child.number) && !plan.kept.has(child.number)).length;
    return { read: plan.read, unread, continueReads: noteEpicChildReadPass(EPIC_KEY, { read: plan.read, unread }) };
}

beforeEach(() => resetEpicChildReadsForTests());

test('a stable epic past the old twenty-one-update reach is read to the end, one continuation after another', () => {
    // The list allows up to 1000 pull requests into an epic branch; at ten per update 211 already outran the old limit.
    for (const count of [211, 1000]) {
        resetEpicChildReadsForTests();
        const children = openSubPrs(count);
        const seen = new Set<number>();
        let now = Date.parse('2026-11-14T09:00:00Z');
        for (let update = 1; ; update++) {
            const result = pass(children, now);
            for (const number of result.read) seen.add(number);
            if (result.unread === 0) {
                assert.equal(update, Math.ceil(count / MAX_EPIC_CHILD_STATUSES), `${count}: every update read sub-PRs not read before`);
                assert.equal(result.continueReads, false, 'nothing left to read: no further update is scheduled');
                break;
            }
            assert.equal(result.continueReads, true, `${count}: update ${update} left ${result.unread} unread and schedules the next`);
            now += 5_000;
        }
        assert.equal(seen.size, count, 'every sub-PR was read');
    }
});

test('sub-PRs whose statuses stop holding as fast as they are read stop the continuations after the stall limit', () => {
    let children = openSubPrs(15);
    const now = Date.parse('2026-11-14T09:00:00Z');
    const decisions: boolean[] = [];
    for (let update = 0; update < 40; update++) {
        const result = pass(children, now);
        decisions.push(result.continueReads);
        if (!result.continueReads) break;
        // Every sub-PR read changes again before the next update reads the epic.
        children = children.map(child => result.read.has(child.number) ? { ...child, updatedAt: `2026-11-14T09:${String(update + 1).padStart(2, '0')}:00Z` } : child);
    }
    // Two updates read sub-PRs for the first time; the stall limit counts only those after.
    assert.deepEqual(decisions, [...Array(2 + MAX_STALLED_EPIC_CHILD_READ_PASSES).fill(true), false]);
});

test('a sub-PR not read before resets the stall count; an update leaving none unread starts afresh', () => {
    let children = openSubPrs(15);
    const now = Date.parse('2026-11-14T09:00:00Z');
    const invalidateRead = (read: Set<number>, update: number) => {
        children = children.map(child => read.has(child.number) ? { ...child, updatedAt: `2026-11-14T10:${String(update).padStart(2, '0')}:00Z` } : child);
    };
    // Two updates read every sub-PR, then stall until one short of the limit.
    for (let update = 1; update <= 2 + MAX_STALLED_EPIC_CHILD_READ_PASSES - 1; update++) {
        const result = pass(children, now);
        assert.equal(result.continueReads, true);
        invalidateRead(result.read, update);
    }
    // A sub-PR opens: the update reads it first, which is progress.
    children = [...children, ...openSubPrs(1, 5000)];
    const opened = pass(children, now);
    assert.ok(opened.read.has(5000));
    assert.equal(opened.continueReads, true);
    invalidateRead(opened.read, 40);
    for (let stall = 1; stall <= MAX_STALLED_EPIC_CHILD_READ_PASSES; stall++) {
        const result = pass(children, now);
        assert.equal(result.continueReads, true, `stall ${stall} after the new sub-PR is within the limit`);
        invalidateRead(result.read, 40 + stall);
    }
    assert.equal(pass(children, now).continueReads, false, 'the limit is reached again without progress');

    // The sub-PRs settle (nothing changes any more) and an update reads the last of them: the next streak has the whole limit again.
    let settled = pass(children, now);
    while (settled.unread > 0) settled = pass(children, now);
    assert.equal(settled.continueReads, false);
    const fresh = openSubPrs(MAX_EPIC_CHILD_STATUSES + 1, 6000);
    children = [...children, ...fresh];
    assert.equal(pass(children, now).continueReads, true, 'a new streak reads sub-PRs not read since it began');
});
