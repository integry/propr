import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job, JobsOptions } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, postFollowup, applyLabels, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, dispatchQueued, dispatcherDeps, promptFor, onIssue, deliverAndDispatch, pollDelivery, dedupKey, requestChildId, consumedTrigger, receiptRecorded,
} from './taskFollowupIssueDispatch.js';

const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');

// A follow-up runs for the person who made it. The selected request decides
// whose run it is, not the submission's dispatch receipt: a submission whose
// initial dispatch accepted its child but could never record its receipt is
// followed up like any other, and the follow-up's run is the requester's, with
// their comment and under the request's own child ID. Deliveries without a
// request, before or after that, stay the submitter's.

const ORDINARY_CHILD = 'issue-integry-propr-14-claude-claude-opus-5-5-main';
type Child = { jobId: string; data: IssueJobData; options?: JobsOptions };
const ownership = (child: Child) => [child.jobId, child.data.userId, child.data.retryRequesterId, child.data.retryCommentId];

/**
 * The submission's initial delivery: each attempt the parent has accepts the submitter's child, under the ordinary
 * ID BullMQ deduplicates, but fails to record the dispatch receipt, until the parent's attempts are exhausted.
 */
async function initialDispatchWithoutReceipt() {
  const index = add.mock.callCount();
  assert.notEqual((await pollDelivery()).status, 'ignored');
  const [name, data] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  assert.equal(data.retryCommentId, undefined, 'the initial delivery carries no request');
  const children: Child[] = [];
  state.recordDispatchFails = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data: { ...data } } as Job<IssueJobData>, dispatcherDeps(children)),
        /database is locked/, 'the receipt write fails, so the attempt fails');
    }
  } finally {
    state.recordDispatchFails = false;
  }
  assert.deepEqual(children.map(ownership), Array.from({ length: 3 }, () => [ORDINARY_CHILD, 'submitter', undefined, undefined]),
    'every attempt adds the submitter\'s ordinary child, which the queue deduplicates');
  assert.equal(await receiptRecorded(), false, 'the receipt is still not recorded');
  assert.equal(await consumedTrigger(), null);
}

test('a follow-up by another user, after the initial dispatch accepted the submitter\'s child but exhausted its attempts without recording its receipt, runs for that user with their comment', async () => {
  await onIssue(true, 'initial-receipt-unrecorded', async () => {
    await initialDispatchWithoutReceipt();

    // The child failed without a PR and no work is active; another user follows up, and their request is accepted.
    state.now += 60_000;
    claims.delete(dedupKey);
    const next = await postFollowup({ body: 'Instructions from the second user' }, 'failed-issue-task', 'user-2');
    assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
    assert.equal(next.json.restartedRequest, undefined);
    assert.deepEqual((await openRequests()).map(held => [held.comment_id, held.requester_id]), [[FIRST_COMMENT_ID, 'user-2']]);
    const own = String(state.timeline.at(-1)!.id);

    // The dispatcher selects their durable request and runs it for them, not for the submitter.
    const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
    assert.equal(dispatched.status, 'dispatched');
    assert.deepEqual(children.map(ownership), [[await requestChildId(), 'user-2', 'user-2', FIRST_COMMENT_ID]],
      'the request\'s child is its requester\'s, under the request\'s own ID');
    assert.match(await promptFor(children[0].data), /Instructions from the second user/);
    assert.equal(await consumedTrigger(), own, 'the receipt now records the request\'s trigger');
    assert.equal(await receiptRecorded(), true);
    assert.deepEqual(await openRequests(), [], 'the request is recorded consumed');

    // A later, independent relabel is an ordinary delivery: the submitter's, carrying no request.
    state.now += 60_000;
    applyLabels(['AI'], HUMAN_ACTOR_ID);
    const later = await deliverAndDispatch();
    assert.equal(later.dispatched.status, 'dispatched');
    assert.deepEqual(later.children.map(ownership), [[`${ORDINARY_CHILD}-trigger-${state.timeline.at(-1)!.id}`, 'submitter', undefined, undefined]]);
    assert.doesNotMatch(await promptFor(later.children[0].data), /Instructions from the second user/);
  }, { receipt: false });
});

test('an initial dispatch that records its receipt runs the submitter\'s ordinary child, and a follow-up by another user then runs for that user', async () => {
  await onIssue(true, 'initial-receipt-recorded', async () => {
    const index = add.mock.callCount();
    assert.notEqual((await pollDelivery()).status, 'ignored');
    const initial = await dispatchQueued(index);
    assert.equal(initial.dispatched.status, 'dispatched');
    assert.deepEqual(initial.children.map(ownership), [[ORDINARY_CHILD, 'submitter', undefined, undefined]], 'a delivery without a request is the submitter\'s');
    assert.equal(await receiptRecorded(), true);
    assert.equal(await consumedTrigger(), String(state.timeline.at(-1)!.id));

    state.now += 60_000;
    claims.delete(dedupKey);
    const next = await postFollowup({ body: 'Instructions from the second user' }, 'failed-issue-task', 'user-2');
    assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
    const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
    assert.equal(dispatched.status, 'dispatched');
    assert.deepEqual(children.map(ownership), [[await requestChildId(), 'user-2', 'user-2', FIRST_COMMENT_ID]]);
  }, { receipt: false });
});

for (const [routing, backed] of [['a submission-backed', true], ['an issue-only', false]] as const) {
  test(`${routing} follow-up on a dispatched failed run keeps running for its requester`, async () => {
    await onIssue(backed, `dispatched-followup-${backed}`, async () => {
      const next = await postFollowup({ body: 'Instructions from the second user' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
      const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
      assert.equal(dispatched.status, 'dispatched');
      assert.deepEqual(children.map(ownership), [[await requestChildId(), 'user-2', 'user-2', FIRST_COMMENT_ID]]);
      assert.match(await promptFor(children[0].data), /Instructions from the second user/);
    });
  });
}
