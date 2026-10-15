import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, add, postFollowup, database, applyLabels, landDelayedLabels, APP_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, dispatchQueued, promptFor, onIssue, takeRecordsOffline, deliverAndDispatch, requestChildId, consumedTrigger } from './taskFollowupIssueDispatch.js';

// A request's publication window opens when its trigger write begins, however
// long posting it took, and a trigger write the route saw land keeps a path to
// its run when its outcome can be neither recorded nor kept in Redis: the job
// it queues records it, or the route's retry does once the database recovers.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null } | undefined>;
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };
const ELEVEN_MINUTES = 11 * 60_000;

/** The dispatched run carries the first request, for its requester and with its instructions. */
async function assertRequestRun({ dispatched, children }: Awaited<ReturnType<typeof dispatchQueued>>, instructions: RegExp) {
  assert.equal(dispatched.status, 'dispatched');
  const [{ data: child }] = children;
  assert.equal(child.userId, 'user-1');
  assert.equal(child.retryRequesterId, 'user-1');
  assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
  assert.match(await promptFor(child), instructions);
  assert.deepEqual(await openRequests(), [], 'the request is released once its run carries it');
}

/** Posting the request's comment completes after the publication window of its reservation has passed. */
function delayCommentPost() {
  state.onCommentPost = () => { state.now += ELEVEN_MINUTES; };
}

for (const [routing, backed] of routings) {
  test(`${routing} request whose comment takes longer than the publication window to post still runs on its own trigger`, async () => {
    await onIssue(backed, `slow-comment-${backed}`, async () => {
      delayCommentPost();
      const result = await postFollowup({ body: 'Retry after a slow post' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      assert.deepEqual((await openRequests()).map(held => [held.published_at! - held.requested_at, held.published_at, held.publication]),
        [[ELEVEN_MINUTES, state.now, 'possible']], 'the publication window opens when the trigger write begins, apart from the reservation');

      const own = state.timeline.at(-1)!.id;
      const run = await dispatchQueued(0);
      assert.equal(run.children[0].jobId, await requestChildId());
      if (backed) assert.equal(await consumedTrigger(), String(own), 'it ran on its own trigger');
      await assertRequestRun(run, /Retry after a slow post/);
      if (backed) assert.equal((await submissionRow())?.retry_event_id, String(own));
    });
  });

  test(`${routing} request whose comment posts slowly and whose trigger response is lost is confirmed by its own trigger in the read-back`, async () => {
    await onIssue(backed, `slow-comment-lost-trigger-${backed}`, async () => {
      delayCommentPost();
      state.labelAdd = 'lost';
      const result = await postFollowup({ body: 'Retry after a slow post' }, 'failed-issue-task');
      assert.equal(result.json.success, true, 'the read-back matches the trigger against the window its write opened');
      assert.equal(result.json.state, 'queued');
      await assertRequestRun(await dispatchQueued(0), /Retry after a slow post/);
    });
  });

  test(`${routing} request whose comment posts slowly and whose trigger write lands late is recovered for its requester`, async () => {
    await onIssue(backed, `slow-comment-late-trigger-${backed}`, async () => {
      delayCommentPost();
      state.labelAdd = 'delayed';
      assert.equal((await postFollowup({ body: 'Retry after a slow post' }, 'failed-issue-task')).json.state, 'unknown');
      assert.equal(add.mock.callCount(), 0);
      state.onCommentPost = undefined;

      state.now += 5000;
      landDelayedLabels();
      await assertRequestRun(await deliverAndDispatch(), /Retry after a slow post/);
    });
  });

  test(`${routing} confirmed trigger whose outcome can be neither recorded nor kept is reported unknown, and its queued job records it and runs for the requester`, async () => {
    await onIssue(backed, `confirmed-unrecorded-${backed}`, async () => {
      // The database and Redis fail from the trigger write on; GitHub applies the trigger and answers.
      let restore: () => Promise<void> = async () => undefined;
      state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
      const result = await postFollowup({ body: 'Retry with these instructions' }, 'failed-issue-task');
      await restore();
      state.redisFails = false;
      state.onLabelAdd = undefined;
      assert.equal(result.status, 202);
      assert.equal(result.json.success, false, 'no queued receipt while the trigger is unrecorded');
      assert.equal(result.json.state, 'unknown');
      assert.match(String(result.json.message), /could not be recorded yet/);
      assert.equal(add.mock.callCount(), 1, 'the job that carries the confirmation is queued');
      assert.equal(state.outcomeRetries.length, 1, 'the route also retries the record');
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
      const own = state.timeline.at(-1)!.id;

      // A relabel delivery carries no evidence of the outcome, so it still defers.
      assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
      if (backed) assert.equal((await submissionRow())?.retry_event_id, null);

      // The queued job's record fails at first: its dispatch fails to be retried, not skipped for good.
      state.confirmFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
      state.confirmFails = false;

      const run = await dispatchQueued(0);
      assert.equal(run.children[0].jobId, await requestChildId());
      if (backed) assert.equal(await consumedTrigger(), String(own), 'it ran on its own trigger');
      await assertRequestRun(run, /Retry with these instructions/);
      assert.equal(await state.outcomeRetries[0](), true, 'a late retry of the record changes nothing');
      assert.deepEqual(await openRequests(), []);
    });
  });

  for (const [write, labelAdd] of [['confirmed', 'ok'], ['timed-out', 'delayed'], ['refused', 'rejected']] as const) {
    test(`${routing} ${write} trigger write whose outcome and job cannot be saved in any store is recorded by the route's retry once the database recovers`, async () => {
      await onIssue(backed, `unsaved-${write}-${backed}`, async () => {
        state.labelAdd = labelAdd;
        state.queueFails = true;
        let restore: () => Promise<void> = async () => undefined;
        state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
        const result = await postFollowup({ body: 'Retry with these instructions' }, 'failed-issue-task');
        state.onLabelAdd = undefined;
        state.queueFails = false;
        state.labelAdd = 'ok';
        assert.equal(result.json.success, false);
        assert.equal(result.json.state, write === 'refused' ? 'failed' : 'unknown');
        assert.equal(add.mock.callCount(), write === 'confirmed' ? 1 : 0, 'no job carries the outcome');
        assert.equal(state.outcomeRetries.length, 1);

        // The retry fails while both stores are still unavailable, then records the outcome.
        assert.equal(await state.outcomeRetries[0](), false);
        state.redisFails = false;
        await restore();
        state.now += 5000;
        if (write === 'timed-out') landDelayedLabels();
        if (write === 'refused') applyLabels(['AI'], APP_ACTOR_ID);
        assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled, 'until it is recorded, the trigger is deferred');
        assert.equal(await state.outcomeRetries[0](), true);

        if (write === 'refused') {
          assert.deepEqual(await openRequests(), [], 'a recorded refusal releases the request');
          const { dispatched, children: [{ data: child }] } = await deliverAndDispatch();
          assert.equal(dispatched.status, 'dispatched');
          assert.equal(child.retryCommentId, undefined, 'the app\'s later trigger runs without the refused request');
          assert.equal(child.retryRequesterId, undefined);
          return;
        }
        assert.deepEqual((await openRequests()).map(held => held.publication), ['possible']);
        await assertRequestRun(await deliverAndDispatch(), /Retry with these instructions/);
      });
    });
  }
}
