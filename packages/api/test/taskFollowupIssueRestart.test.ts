import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, postFollowup, database, applyLabels, APP_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, postedComments, dispatchQueued, promptFor, onIssue, takeRecordsOffline, deliverAndDispatch, relabelWebhook, pollDelivery, dedupKey,
} from './taskFollowupIssueDispatch.js';

// A request still owed once its trigger write can no longer land is stranded
// when nothing will run it: its outcome was lost with the API process that
// learned it, or every delivery came before its trigger was visible. A later
// follow-up restarts it on a fresh trigger of its own, for its own requester
// with its own instructions, instead of posting; until then its trigger is
// deferred, never run without it.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null } | undefined>;
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };
const HOUR_MS = 60 * 60_000;
const ORIGINAL = 'Retry with the original instructions';

/** The issue's open request row, with when it was restarted. */
const heldRow = async () => database('issue_retry_request_states').where({ issue_number: 14 }).whereNotNull('owed_issue')
  .first('comment_id', 'requester_id', 'publication', 'published_at', 'resumed_at') as Promise<
    { comment_id: number; requester_id: string; publication: string; published_at: number; resumed_at: number | null } | undefined>;

/**
 * GitHub confirms the request's trigger write while the request records are
 * unavailable and the queue rejects its job without accepting it; the
 * records come back, and the API process restarts, losing its outcome retry.
 */
async function strandConfirmedRequest(body = ORIGINAL) {
  let restore: () => Promise<void> = async () => undefined;
  state.onLabelAdd = async () => { restore = await takeRecordsOffline(); };
  state.queueFails = true;
  const result = await postFollowup({ body }, 'failed-issue-task');
  await restore();
  state.onLabelAdd = undefined;
  state.queueFails = false;
  assert.equal(result.status, 202);
  assert.equal(result.json.state, 'unknown');
  assert.match(String(result.json.message), /follow up again to restart it/, 'the receipt names the recovery');
  assert.equal(add.mock.callCount(), 1);
  assert.equal(state.outcomeRetries.length, 1);
  state.outcomeRetries = [];
  assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
  return result;
}

/** Dispatches the job a restart queued; the run is the first request's, for its requester. */
async function assertRestartedRun(backed: boolean, laterBody: string) {
  const fresh = state.timeline.at(-1)!.id;
  const index = add.mock.callCount() - 1;
  const [, queued] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  assert.deepEqual([queued.userId, queued.retryRequesterId, queued.retryCommentId], ['user-1', 'user-1', FIRST_COMMENT_ID]);
  assert.equal(queued.retryPublishedAt, (await heldRow())!.published_at, 'the job confirms the restart\'s own write only');
  const { dispatched, children } = await dispatchQueued(index);
  assert.equal(dispatched.status, 'dispatched');
  const [{ jobId, data: child }] = children;
  if (backed) assert.equal(jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${fresh}`);
  assert.equal(child.userId, 'user-1', 'the restarted request runs for its own requester');
  assert.equal(child.retryRequesterId, 'user-1');
  assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
  const prompt = await promptFor(child);
  assert.match(prompt, new RegExp(ORIGINAL));
  assert.doesNotMatch(prompt, new RegExp(laterBody));
  if (backed) assert.equal((await submissionRow())?.retry_event_id, String(fresh), 'the run consumes every trigger it was dispatched past');
  assert.deepEqual(await openRequests(), [], 'the request is released once its run carries it');
}

for (const [routing, backed] of routings) {
  test(`${routing} confirmed request whose outcome record and job are lost with the API process is restarted by a later follow-up and runs for its requester`, async () => {
    await onIssue(backed, `restart-lost-outcome-${backed}`, async () => {
      await strandConfirmedRequest();
      const own = state.timeline.at(-1)!.id;

      // An hour later, fresh webhook and poll deliveries cannot tell the trigger is the request's.
      state.now += HOUR_MS;
      for (const deliver of [relabelWebhook, pollDelivery, relabelWebhook]) {
        const { dispatched, children } = await deliverAndDispatch(deliver);
        assert.deepEqual(dispatched, unreconciled, 'neither with nor without the request');
        assert.equal(children.length, 0);
      }
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
      if (backed) assert.equal((await submissionRow())?.retry_event_id, null, 'its trigger stays unconsumed');

      // The short duplicate claim expires; the next follow-up, from another user, restarts the request.
      claims.delete(dedupKey);
      const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task', 'user-2');
      assert.equal(later.status, 202);
      assert.equal(later.json.success, false, 'the later request is refused, so the UI keeps it to send again');
      assert.equal(later.json.state, 'refused');
      assert.equal(later.json.posted, false);
      assert.equal(later.json.commentId, FIRST_COMMENT_ID);
      assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
      assert.match(String(later.json.message), /restarted and queued with its original instructions.*not posted/);
      assert.equal(postedComments().length, 1, 'the later request posts nothing');
      const held = await heldRow();
      assert.deepEqual([held?.comment_id, held?.requester_id, held?.publication, held?.resumed_at], [FIRST_COMMENT_ID, 'user-1', 'possible', state.now]);
      assert.ok(state.timeline.at(-1)!.id > own, 'the restart publishes a fresh trigger');
      await assertRestartedRun(backed, 'A later request');

      // The run failed again; a new follow-up is now an ordinary request of its own.
      state.now += 60_000;
      claims.delete(dedupKey);
      const next = await postFollowup({ body: 'Next instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued');
      assert.equal(next.json.posted, true);
      assert.equal(next.json.commentId, FIRST_COMMENT_ID + 1);
      assert.equal(next.json.restartedRequest, undefined);
    });
  });

  test(`${routing} stranded request is not restarted while its write may still land`, async () => {
    await onIssue(backed, `restart-too-early-${backed}`, async () => {
      await strandConfirmedRequest();
      const timeline = state.timeline.length;
      state.now += 5 * 60_000;
      claims.delete(dedupKey);
      const early = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.equal(early.status, 409);
      assert.match(String(early.json.error), /may still start/);
      assert.equal(postedComments().length, 1);
      assert.equal(state.timeline.length, timeline, 'nothing is relabelled');
      assert.equal(claims.has(dedupKey), false);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
    });
  });

  test(`${routing} restart GitHub refuses keeps the request owed and its trigger deferred, and a further follow-up restarts it`, async () => {
    await onIssue(backed, `restart-refused-${backed}`, async () => {
      await strandConfirmedRequest();
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      state.labelAdd = 'rejected';
      const refused = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      state.labelAdd = 'ok';
      assert.equal(refused.status, 202);
      assert.deepEqual(refused.json.restartedRequest, { state: 'failed', commentId: FIRST_COMMENT_ID });
      assert.match(String(refused.json.message), /GitHub refused the restart's 'AI' label, so it is still waiting/);
      assert.equal(claims.has(dedupKey), false);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['refused'], 'the refused restart does not release the request');

      // The trigger the lost write published is still not run without the request.
      applyLabels(['AI'], APP_ACTOR_ID);
      assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
      if (backed) assert.equal((await submissionRow())?.retry_event_id, null);

      state.now += 60_000;
      claims.delete(dedupKey);
      const restarted = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(restarted.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
      await assertRestartedRun(backed, 'A later request');
    });
  });

  test(`${routing} stale evidence of the lost write does not confirm a restart whose own outcome is unrecorded`, async () => {
    await onIssue(backed, `restart-stale-evidence-${backed}`, async () => {
      // The first write's job is accepted but never dispatched, and its outcome retry outlives the restart.
      let restore: () => Promise<void> = async () => undefined;
      state.onLabelAdd = async () => { restore = await takeRecordsOffline(); };
      assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'unknown');
      await restore();
      const [staleRetry] = state.outcomeRetries;
      state.outcomeRetries = [];

      // The restart's own write is confirmed, and its record and job are lost too.
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      state.queueFails = true;
      const restarted = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      await restore();
      state.queueFails = false;
      state.onLabelAdd = undefined;
      assert.deepEqual(restarted.json.restartedRequest, { state: 'unknown', commentId: FIRST_COMMENT_ID });
      assert.match(String(restarted.json.message), /follow up again to restart it/);
      const [restartRetry] = state.outcomeRetries;

      assert.equal(await staleRetry(), true, 'the lost write\'s outcome retry completes');
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending'], 'but records nothing for the restart');
      assert.deepEqual((await dispatchQueued(0)).dispatched, unreconciled, 'the lost write\'s job does not confirm the restart');

      // The restart's own outcome retry records it, and recovery runs the request on the restart's trigger.
      assert.equal(await restartRetry(), true);
      const fresh = state.timeline.at(-1)!.id;
      const { dispatched, children: [{ jobId, data: child }] } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      if (backed) assert.equal(jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${fresh}`);
      assert.equal(child.userId, 'user-1');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), new RegExp(ORIGINAL));
      assert.deepEqual(await openRequests(), []);
    });
  });

  test(`${routing} queued request whose trigger the timeline shows late stays reachable after early deliveries`, async () => {
    await onIssue(backed, `late-visibility-${backed}`, async () => {
      const result = await postFollowup({ body: ORIGINAL }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      // GitHub's timeline does not show the confirmed trigger yet.
      const own = state.timeline.pop()!;

      assert.deepEqual((await dispatchQueued(0)).dispatched, unreconciled, 'the queued job defers rather than run without its trigger');
      for (const deliver of [relabelWebhook, pollDelivery]) assert.deepEqual((await deliverAndDispatch(deliver)).dispatched, unreconciled);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['possible'], 'early deliveries neither release nor consume it');
      if (backed) assert.equal((await submissionRow())?.retry_event_id, null);

      // Once the trigger is visible, the next ordinary delivery runs the request.
      state.timeline.push(own);
      state.now += 30_000;
      const { dispatched, children: [{ jobId, data: child }] } = await deliverAndDispatch(pollDelivery);
      assert.equal(dispatched.status, 'dispatched');
      if (backed) assert.equal(jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${own.id}`);
      assert.equal(child.userId, 'user-1');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), new RegExp(ORIGINAL));
      assert.deepEqual(await openRequests(), []);
    });
  });

  test(`${routing} queued request whose trigger became visible after its last delivery is restarted by a later follow-up`, async () => {
    await onIssue(backed, `late-visibility-no-delivery-${backed}`, async () => {
      assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'queued');
      const own = state.timeline.pop()!;
      assert.deepEqual((await dispatchQueued(0)).dispatched, unreconciled);
      assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
      state.timeline.push(own);

      // No delivery comes once the trigger is visible; within its window a follow-up waits for one.
      state.now += 60_000;
      claims.delete(dedupKey);
      assert.equal((await postFollowup({ body: 'A later request' }, 'failed-issue-task')).status, 409);
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
      await assertRestartedRun(backed, 'A later request');
    });
  });

  test(`${routing} stranded request on a cancelled issue is neither restarted nor released`, async () => {
    await onIssue(backed, `restart-cancelled-${backed}`, async () => {
      await strandConfirmedRequest();
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      state.issueLabels = [...state.issueLabels, 'AI-cancelled'];
      const timeline = state.timeline.length;
      const cancelled = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.equal(cancelled.status, 409);
      assert.match(String(cancelled.json.error), /cancelled/);
      assert.equal(state.timeline.length, timeline, 'nothing is relabelled');
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending'], 'the request is kept for a restart once the issue is retried');
    });
  });
}
