import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, postFollowup, database, applyLabels, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, dispatchQueued, promptFor, onIssue, deliverAndDispatch, pollDelivery, dedupKey, retryRuns, requestChildId, consumedTrigger,
} from './taskFollowupIssueDispatch.js';

// The processing label is configured anew after a request's run was accepted
// through a trigger under the old one. Raw history still shows that trigger,
// which the queue's record of the run names, so recovery orders a genuinely
// later trigger under the new label after it and runs that trigger once,
// without the request; the old trigger is kept only to order on, never run.
// Only a history that does not show the receipt at all defers, a bounded
// number of reads per delivery.

/** The ID of the request posted as `commentId`, as the queue's record of its run is keyed. */
const requestOf = async (commentId = FIRST_COMMENT_ID) =>
  ({ id: (await database('issue_retry_request_states').where({ comment_id: commentId }).first('id') as { id: number }).id, commentId });
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };

/** Hides the trigger `eventId` from every history read until the returned restore runs, as if GitHub no longer showed it. */
function hideEvent(eventId: string) {
  const full = state.timeline;
  state.timeline = full.filter(event => String(event.id) !== eventId);
  return () => { state.timeline = full; };
}

/** The submission's request R runs on its own trigger, but neither the submission's receipt nor R's consumption is recorded. */
async function unsettledRun() {
  const e1 = String(state.timeline[0].id);
  await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e1 });
  assert.equal((await postFollowup({ body: 'Old instructions' }, 'failed-issue-task')).json.state, 'queued');
  const e2 = String(state.timeline.at(-1)!.id);
  state.recordDispatchFails = true;
  state.consumeFails = true;
  await assert.rejects(dispatchQueued(0), /database is locked/);
  state.recordDispatchFails = false;
  state.consumeFails = false;
  const request = await requestOf();
  assert.deepEqual(await retryRuns.read(request), { receiptEventId: e2 }, 'the queue accepted R\'s run through its own trigger');
  assert.equal(await consumedTrigger(), e1, 'the receipt still records the earlier trigger');
  assert.deepEqual((await openRequests()).map(held => held.publication), ['possible']);
  return { e1, e2, request };
}

test('an issue-only request consumed through a trigger whose label was configured away lets a later trigger under the new label run once, without the request', async () => {
  await onIssue(false, 'label-change-issue-only', async () => {
    assert.equal((await postFollowup({ body: 'Old instructions' }, 'failed-issue-task')).json.state, 'queued');
    const e2 = String(state.timeline.at(-1)!.id);
    const ran = await dispatchQueued(0);
    assert.equal(ran.dispatched.status, 'dispatched');
    assert.deepEqual(ran.children.map(child => child.jobId), [await requestChildId()]);
    assert.deepEqual(await openRequests(), [], 'the request is recorded consumed');
    const request = await requestOf();
    assert.equal(await retryRuns.read(request), null, 'its run\'s record is retired');
    assert.deepEqual(await retryRuns.accepted(request), { receiptEventId: e2 }, 'the retired record names the trigger its run consumed');

    // The processing label is configured from AI to implement; the history still names AI for E2.
    state.processingLabels = ['implement'];
    state.now += 60_000;
    const quiet = await deliverAndDispatch(pollDelivery);
    assert.deepEqual(quiet.dispatched, { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: 14 },
      'the kept receipt orders triggers, and is not run again');
    assert.deepEqual(quiet.children, []);

    // Someone applies the new label: a genuinely later trigger E3.
    state.now += 60_000;
    applyLabels(['implement'], HUMAN_ACTOR_ID);
    assert.deepEqual(state.timeline.map(event => event.label.name).slice(-2), ['AI', 'implement'], 'raw history shows both labels');

    // Without the receipt in any history read, nothing can be ordered after it: the delivery defers, a bounded number of reads.
    const restore = hideEvent(e2);
    const missing = await deliverAndDispatch(pollDelivery);
    restore();
    assert.deepEqual(missing.dispatched, unreconciled);
    assert.deepEqual(missing.children, []);

    const later = await deliverAndDispatch(pollDelivery);
    assert.equal(later.dispatched.status, 'dispatched');
    assert.equal(later.children.length, 1, 'only the later trigger runs');
    const [{ jobId, data: child }] = later.children as Array<{ jobId: string; data: IssueJobData }>;
    assert.equal(jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main', 'an ordinary run of the issue');
    assert.deepEqual([child.retryCommentId, child.retryRequesterId], [undefined, undefined], 'no request is adopted');
    assert.notEqual(child.userId, 'user-1');
    assert.doesNotMatch(await promptFor(child), /Old instructions/);
  });
});

test('a submission-backed request whose accepted run is unsettled, through a trigger whose label was configured away, is settled and a later trigger under the new label runs once for the submitter', async () => {
  await onIssue(true, 'label-change-backed', async () => {
    const { e2, request } = await unsettledRun();
    state.processingLabels = ['implement'];
    state.now += 60_000;
    applyLabels(['implement'], HUMAN_ACTOR_ID);
    const e3 = String(state.timeline.at(-1)!.id);
    assert.deepEqual(state.timeline.map(event => event.label.name).slice(-2), ['AI', 'implement'], 'raw history shows both labels');

    // Without R's receipt in any history read, R's run cannot be ordered against E3: the delivery defers.
    const restore = hideEvent(e2);
    const missing = await deliverAndDispatch(pollDelivery);
    restore();
    assert.deepEqual(missing.dispatched, unreconciled);
    assert.deepEqual(missing.children, []);
    assert.deepEqual((await openRequests()).map(held => held.publication), ['possible'], 'R is kept');
    assert.deepEqual(await retryRuns.read(request), { receiptEventId: e2 });

    // With R's receipt shown, R is settled through E2, and E3 runs once, for the submitter, without R.
    const { dispatched, children } = await deliverAndDispatch(pollDelivery);
    assert.equal(dispatched.status, 'dispatched');
    assert.deepEqual(children.map(child => [child.jobId, child.data.userId, child.data.retryCommentId]),
      [[`issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${e3}`, 'submitter', undefined]], 'R\'s run is not added again');
    assert.doesNotMatch(await promptFor(children[0].data), /Old instructions/);
    assert.equal(await consumedTrigger(), e3);
    assert.deepEqual(await openRequests(), [], 'R is recorded consumed');
    assert.equal(await retryRuns.read(request), null, 'R\'s record is retired');

    // A redelivery runs nothing more.
    const again = await deliverAndDispatch(pollDelivery);
    assert.deepEqual(again.dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
    assert.deepEqual(again.children, []);
  });
});

test('a follow-up settles an accepted run through a trigger whose label was configured away and is queued, running on its own trigger for its requester', async () => {
  await onIssue(true, 'label-change-followup', async () => {
    const { e2 } = await unsettledRun();
    state.processingLabels = ['implement'];
    // R's write can no longer land, so its record alone tells whether it already ran.
    state.now += 11 * 60_000;
    claims.delete(dedupKey);
    const next = await postFollowup({ body: 'New instructions' }, 'failed-issue-task', 'user-2');
    assert.equal(next.status, 202);
    assert.equal(next.json.state, 'queued', 'the follow-up is not refused while the evidence is shown');
    assert.equal(next.json.commentId, FIRST_COMMENT_ID + 1);
    assert.equal(await consumedTrigger(), e2, 'the follow-up recorded the receipt R\'s run names');
    assert.equal(await retryRuns.read(await requestOf()), null, 'R is recorded consumed');
    const own = state.timeline.at(-1)!;
    assert.equal(own.label.name, 'implement');

    const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
    assert.equal(dispatched.status, 'dispatched');
    const [{ jobId, data: child }] = children as Array<{ jobId: string; data: IssueJobData }>;
    assert.equal(jobId, await requestChildId(FIRST_COMMENT_ID + 1));
    assert.deepEqual([child.userId, child.retryRequesterId, child.retryCommentId], ['user-2', 'user-2', FIRST_COMMENT_ID + 1]);
    const prompt = await promptFor(child);
    assert.match(prompt, /New instructions/);
    assert.doesNotMatch(prompt, /Old instructions/);
    assert.equal(await consumedTrigger(), String(own.id));
    assert.deepEqual(await openRequests(), []);
  });
});

test('a request whose write begins in the second of an earlier run\'s receipt, kept under a label configured away, runs on its own trigger, not on that receipt', async () => {
  await onIssue(false, 'label-change-same-second', async () => {
    assert.equal((await postFollowup({ body: 'Old instructions' }, 'failed-issue-task')).json.state, 'queued');
    const e2 = state.timeline.at(-1)!;
    assert.equal((await dispatchQueued(0)).dispatched.status, 'dispatched');
    assert.deepEqual(await openRequests(), []);

    // In the same second, with the label configured anew, a second request is posted and labels its own trigger.
    state.processingLabels = ['implement'];
    claims.delete(dedupKey);
    const next = await postFollowup({ body: 'New instructions' }, 'failed-issue-task', 'user-2');
    assert.equal(next.json.state, 'queued');
    const own = state.timeline.at(-1)!;
    assert.equal(own.label.name, 'implement');
    assert.equal(own.created_at, e2.created_at, 'both triggers carry the same GitHub second');

    const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
    assert.equal(dispatched.status, 'dispatched', 'the request is owed its own trigger, not the earlier run\'s receipt');
    const [{ jobId, data: child }] = children as Array<{ jobId: string; data: IssueJobData }>;
    assert.equal(jobId, await requestChildId(FIRST_COMMENT_ID + 1));
    assert.deepEqual([child.userId, child.retryRequesterId, child.retryCommentId], ['user-2', 'user-2', FIRST_COMMENT_ID + 1]);
    assert.match(await promptFor(child), /New instructions/);
    assert.deepEqual(await retryRuns.accepted(await requestOf(FIRST_COMMENT_ID + 1)), { receiptEventId: String(own.id) });
    assert.deepEqual(await openRequests(), []);
  });
});
