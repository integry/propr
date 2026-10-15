import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, claims, add, postFollowup, database, applyLabels, landDelayedLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, routes, postedComments, dispatchQueued, promptFor, onIssue, takeRecordsOffline, deliverAndDispatch, dedupKey, requestChildId, assertIndependentRun,
} from './taskFollowupIssueDispatch.js';

// A recorded retry request belongs only to the trigger it published: a later,
// independent trigger must not adopt it, a trigger write that may still land
// keeps it for that write, a newer trigger does not strand it, a write whose
// outcome is unknown defers its trigger however long that takes, and an issue
// owes at most one request at a time.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null }>;
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };
const DAY_MS = 24 * 60 * 60 * 1000;

for (const [routing, backed] of routings) {
  test(`${routing} trigger write that times out and lands after a negative read-back stays unconfirmed and runs for the requester`, async () => {
    await onIssue(backed, `delayed-trigger-${backed}`, async () => {
      state.labelAdd = 'delayed';
      const result = await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task');
      assert.equal(result.status, 202);
      assert.equal(result.json.success, false);
      assert.equal(result.json.state, 'unknown', 'a negative read-back does not prove a timed-out write was refused');
      assert.match(String(result.json.message), /may still start/);
      const afterAdd = routes().slice(routes().indexOf('POST /repos/{owner}/{repo}/issues/{issue_number}/labels') + 1);
      assert.ok(afterAdd.includes('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline'), 'the read-back saw no trigger of the request');
      assert.equal(add.mock.callCount(), 0);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['possible'], 'the request is kept for the write that may still land');
      assert.ok(claims.has(dedupKey));

      // GitHub finishes the accepted write; its relabel is delivered after the shared window.
      state.now += 5000;
      landDelayedLabels();
      const { dispatched, children } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      const [{ data: child }] = children;
      assert.equal(child.userId, 'user-1', 'the late trigger runs for the requester');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), /Retry after the timeout/);
      assert.deepEqual(await openRequests(), []);
    });
  });

  test(`${routing} person's relabel while the trigger write times out does not confirm the request, which still runs on its own late trigger`, async () => {
    await onIssue(backed, `delayed-trigger-human-relabel-${backed}`, async () => {
      state.labelAdd = 'delayed';
      state.onLabelAdd = () => applyLabels(['AI'], HUMAN_ACTOR_ID);
      const result = await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task');
      assert.equal(result.json.state, 'unknown', 'the label someone else applied is not the request\'s publication');
      assert.equal(add.mock.callCount(), 0);
      state.onLabelAdd = undefined;

      // The person's trigger is delivered while the request's write may still land.
      state.now += 31_000;
      assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled, 'it is neither run with the request nor consumed past it');
      if (backed) assert.equal((await submissionRow()).retry_event_id, null);

      // The person removes their label again, so the late add is not a no-op on it.
      state.issueLabels = state.issueLabels.filter(name => name !== 'AI');
      state.now += 5000;
      landDelayedLabels();
      const own = state.timeline.at(-1)!.id;
      const { dispatched, children } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      const [{ jobId, data: child }] = children;
      assert.equal(jobId, await requestChildId());
      if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
      assert.equal(child.userId, 'user-1');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), /Retry after the timeout/);
    });
  });

  test(`${routing} trigger write GitHub refuses while a person relabels is reported as not started and never adopted`, async () => {
    await onIssue(backed, `refused-human-relabel-${backed}`, async () => {
      state.labelAdd = 'rejected';
      // The person's label lands while the route awaits GitHub's answer, which is a refusal.
      state.onLabelAdd = () => applyLabels(['AI'], HUMAN_ACTOR_ID);
      const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
      assert.equal(result.status, 202);
      assert.equal(result.json.success, false);
      assert.equal(result.json.state, 'failed', 'the person\'s label does not make the refused write successful');
      assert.equal(add.mock.callCount(), 0, 'no job is queued for the refused request');
      assert.deepEqual(await openRequests(), [], 'the refused request is released');
      assert.equal(claims.has(dedupKey), false);
      state.onLabelAdd = undefined;
      state.labelAdd = 'ok';

      // The person's own trigger runs without the refused request.
      await assertIndependentRun(backed);
    });
  });

  for (const [who, actorId, delay] of [
    ['another actor', HUMAN_ACTOR_ID, 60_000],
    ['the app within the publication window', APP_ACTOR_ID, 60_000],
    ['the app after the publication window', APP_ACTOR_ID, 11 * 60_000],
  ] as const) {
    test(`${routing} trigger GitHub refused whose refusal can be neither recorded nor kept is not adopted by a later trigger from ${who}`, async () => {
      await onIssue(backed, `refused-unrecorded-${backed}-${actorId}-${delay}`, async () => {
        state.labelAdd = 'rejected';
        // The database and Redis fail from the trigger write on, so the refusal can be neither recorded nor kept.
        let restore: () => Promise<void> = async () => undefined;
        state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
        const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
        await restore();
        state.redisFails = false;
        assert.equal(result.json.state, 'failed', 'a write GitHub refused is still reported as not started');
        assert.equal(add.mock.callCount(), 0);
        assert.deepEqual((await openRequests()).map(held => held.publication), ['pending'], 'no recovery adopts a request whose outcome was not recorded');
        assert.equal(claims.has(dedupKey), true, 'Redis could not release the claim, which expires on its own');
        claims.delete(dedupKey);
        state.labelAdd = 'ok';
        state.onLabelAdd = undefined;

        state.now += delay;
        applyLabels(['AI'], actorId);
        if (actorId === APP_ACTOR_ID && delay < 10 * 60_000) {
          // Nothing tells the app's trigger from the request's own late write: neither runs.
          assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
          return;
        }
        if (actorId === HUMAN_ACTOR_ID) {
          // The person's trigger waits until the request's own write can no longer land, then runs without it.
          assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
          state.now += 10 * 60_000;
          await assertIndependentRun(backed);
          return;
        }
        await assertIndependentRun(backed);
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`${routing} request made while an earlier trigger write may still land is refused before posting, and the earlier request still runs for its requester`, async () => {
    await onIssue(backed, `pending-then-second-${backed}`, async () => {
      state.labelAdd = 'delayed';
      const first = await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task');
      assert.equal(first.json.state, 'unknown');

      // After the shared window, but before the timed-out write lands, a second request
      // arrives whose own trigger GitHub would refuse.
      state.now += 31_000;
      claims.delete(dedupKey);
      state.labelAdd = 'rejected';
      const second = await postFollowup({ body: 'A second request' }, 'failed-issue-task');
      assert.equal(second.status, 409);
      assert.match(String(second.json.error), /earlier retry .* may still start/);
      assert.equal(postedComments().length, 1, 'the second request posts nothing');
      assert.equal(claims.has(dedupKey), false, 'a refusal holds no dedup window');
      assert.deepEqual((await openRequests()).map(held => [held.comment_id, held.publication]), [[FIRST_COMMENT_ID, 'possible']], 'the earlier request is kept as it was');

      // The first request's write lands late and its relabel is delivered.
      state.now += 5000;
      landDelayedLabels();
      const { dispatched, children } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      const [{ data: child }] = children;
      assert.equal(child.userId, 'user-1', 'the late trigger runs for the earlier requester');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), /Retry after the timeout/);
      assert.deepEqual(await openRequests(), []);
    });
  });

  test(`${routing} request after an earlier trigger write failed to land within the publication window replaces it`, async () => {
    await onIssue(backed, `pending-expired-then-second-${backed}`, async () => {
      state.labelAdd = 'delayed';
      assert.equal((await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task')).json.state, 'unknown');
      state.delayedLabels = [];

      state.now += 11 * 60_000;
      claims.delete(dedupKey);
      state.labelAdd = 'ok';
      const second = await postFollowup({ body: 'A second request' }, 'failed-issue-task');
      assert.equal(second.json.state, 'queued');
      assert.deepEqual((await openRequests()).map(held => [held.comment_id, held.requested_at, held.publication]),
        [[FIRST_COMMENT_ID + 1, state.now, 'possible']], 'only the second request is held');
    });
  });

  test(`${routing} second follow-up while an accepted request whose enqueue failed is still owed a run is refused before posting, and both run in turn on their own triggers`, async () => {
    await onIssue(backed, `owed-then-second-${backed}`, async () => {
      state.queueFails = true;
      const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
      assert.equal(first.json.state, 'unknown');
      state.queueFails = false;
      const firstTrigger = state.timeline.at(-1)!.id;

      // The shared window has passed and nothing is queued, but the first request is owed a run.
      state.now += 31_000;
      claims.delete(dedupKey);
      const refused = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(refused.status, 409);
      assert.match(String(refused.json.error), /earlier retry .* may still start/);
      assert.equal(postedComments().length, 1, 'the second request posts nothing');
      assert.equal(state.timeline.at(-1)!.id, firstTrigger, 'and publishes no trigger');
      assert.equal(claims.has(dedupKey), false);
      assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID]);

      // Recovery runs the first request on its own trigger, from the relabel's job rather than the failed enqueue's.
      const recovered = await deliverAndDispatch();
      assert.equal(recovered.dispatched.status, 'dispatched');
      const [{ jobId: firstJob, data: firstChild }] = recovered.children;
      assert.equal(firstJob, await requestChildId());
      if (backed) assert.equal(firstChild.correlationId?.split('-').at(-1), String(firstTrigger), 'it runs on its own trigger');
      assert.equal(firstChild.userId, 'user-1');
      assert.equal(firstChild.retryRequesterId, 'user-1');
      assert.equal(firstChild.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(firstChild), /First instructions/);
      assert.deepEqual(await openRequests(), []);

      // The run failed; the second follow-up, from another user, is now accepted and runs on its own trigger.
      state.now += 60_000;
      claims.delete(dedupKey);
      const second = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(second.json.state, 'queued');
      assert.equal(second.json.commentId, FIRST_COMMENT_ID + 1);
      const secondTrigger = state.timeline.at(-1)!.id;
      const secondJob = add.mock.callCount() - 1;
      const [, queued] = add.mock.calls[secondJob].arguments as unknown as [string, { retryCommentId?: number; retryRequesterId?: string }];
      assert.deepEqual([queued.retryCommentId, queued.retryRequesterId], [FIRST_COMMENT_ID + 1, 'user-2'], 'the second request\'s own job is dispatched');
      const { dispatched, children } = await dispatchQueued(secondJob);
      assert.equal(dispatched.status, 'dispatched');
      const [{ jobId, data: child }] = children;
      assert.equal(jobId, await requestChildId(FIRST_COMMENT_ID + 1));
      if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(secondTrigger), 'it runs on its own trigger');
      assert.equal(child.userId, 'user-2');
      assert.equal(child.retryRequesterId, 'user-2');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID + 1);
      const prompt = await promptFor(child);
      assert.match(prompt, /Second instructions/);
      assert.doesNotMatch(prompt, /First instructions/);
      if (backed) assert.equal((await submissionRow()).retry_event_id, String(secondTrigger));
      assert.deepEqual(await openRequests(), []);
    });
  });

  for (const [write, labelAdd] of [['timed-out', 'delayed'], ['refused', 'rejected']] as const) {
    test(`${routing} ${write} trigger write whose outcome cannot be recorded in either store defers the trigger it may own beyond retention, unconsumed, until a later follow-up restarts it for its requester`, async () => {
      await onIssue(backed, `unrecorded-trigger-${backed}-${write}`, async () => {
        state.labelAdd = labelAdd;
        // Both the database and Redis fail from the trigger write on.
        let restore: () => Promise<void> = async () => undefined;
        state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
        assert.equal((await postFollowup({ body: 'Retry with the original instructions' }, 'failed-issue-task')).json.state, write === 'refused' ? 'failed' : 'unknown');
        await restore();
        state.redisFails = false;
        state.onLabelAdd = undefined;
        state.labelAdd = 'ok';
        const recorded = await openRequests();
        assert.deepEqual(recorded.map(held => [held.comment_id, held.requester_id, held.publication]), [[FIRST_COMMENT_ID, 'user-1', 'pending']],
          'the request was recorded before its trigger was written');

        // The app's next trigger is the request's own if its write landed late, or an
        // independent one if GitHub refused it; nothing tells which.
        state.now += 5000;
        if (write === 'refused') applyLabels(['AI'], APP_ACTOR_ID); else landDelayedLabels();
        for (const elapsed of [0, DAY_MS + 60_000, 8 * DAY_MS]) {
          state.now += elapsed;
          const { dispatched, children } = await deliverAndDispatch();
          assert.deepEqual(dispatched, unreconciled, 'neither with nor without the request, however late');
          assert.equal(children.length, 0);
        }

        if (backed) assert.equal((await submissionRow()).retry_event_id, null, 'the trigger stays unconsumed for a later delivery');
        assert.deepEqual(await openRequests(), recorded, 'the obligation is retained');

        // Retention cleanup runs with a later follow-up, from another user, which restarts the
        // stranded request on a fresh trigger of its own instead of posting.
        claims.delete(dedupKey);
        const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task', 'user-2');
        assert.equal(later.status, 202);
        assert.equal(later.json.success, false, 'the later request itself was not posted');
        assert.equal(later.json.posted, false);
        assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
        assert.equal(postedComments().length, 1);
        const fresh = state.timeline.at(-1)!.id;
        const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
        assert.equal(dispatched.status, 'dispatched');
        const [{ jobId, data: child }] = children;
        assert.equal(jobId, await requestChildId());
        if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(fresh), 'it runs on its own trigger');
        assert.equal(child.userId, 'user-1', 'the restarted request runs for its own requester');
        assert.equal(child.retryRequesterId, 'user-1');
        assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
        const prompt = await promptFor(child);
        assert.match(prompt, /Retry with the original instructions/);
        assert.doesNotMatch(prompt, /A later request/);
        if (backed) assert.equal((await submissionRow()).retry_event_id, String(fresh), 'the run consumes the trigger it may own with its fresh one');
        assert.deepEqual(await openRequests(), []);
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`${routing} queued retry whose trigger a later, independent relabel supersedes still runs on its own trigger for its requester`, async () => {
    await onIssue(backed, `superseded-queued-retry-${backed}`, async () => {
      const result = await postFollowup({ body: 'Retry with these instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      const own = state.timeline.at(-1)!.id;
      const [, queued] = add.mock.calls[0].arguments as unknown as [string, { retryCommentId?: number }];
      assert.equal(queued.retryCommentId, FIRST_COMMENT_ID);

      // Before the queued job runs, a person removes and re-applies the trigger.
      state.now += 60_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const independent = state.timeline.at(-1)!.id;

      const { dispatched, children } = await dispatchQueued(0);
      assert.equal(dispatched.status, 'dispatched');
      const [{ jobId, data: child }] = children;
      assert.equal(jobId, await requestChildId());
      if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(own), 'the request runs on the trigger it published');
      assert.equal(child.userId, 'user-1');
      assert.equal(child.retryRequesterId, 'user-1');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), /Retry with these instructions/);
      assert.deepEqual(await openRequests(), [], 'the request is released once its run carries it');
      if (!backed) return;
      assert.equal((await submissionRow()).retry_event_id, String(independent), 'the run consumes the trigger it was dispatched past');

      // The independent trigger's own delivery starts no second run, with or without the request.
      assert.deepEqual((await deliverAndDispatch()).dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
    });
  });

  test(`${routing} retry whose enqueue failed is recovered on its own trigger after a later, independent relabel`, async () => {
    await onIssue(backed, `superseded-unqueued-retry-${backed}`, async () => {
      state.queueFails = true;
      const result = await postFollowup({ body: 'Retry with these instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'unknown');
      state.queueFails = false;
      const own = state.timeline.at(-1)!.id;

      // A person relabels before recovery; its delivery is the one that reaches the dispatcher.
      state.now += 60_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const independent = state.timeline.at(-1)!.id;
      const { dispatched, children } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      const [{ jobId, data: child }] = children;
      assert.equal(jobId, await requestChildId());
      if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
      assert.equal(child.userId, 'user-1', 'recovery runs the request for its requester');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
      assert.match(await promptFor(child), /Retry with these instructions/);
      if (backed) assert.equal((await submissionRow()).retry_event_id, String(independent));
      assert.deepEqual(await openRequests(), []);
    });
  });
}

test('a queued issue-only request runs only on a trigger its own identity published, like recovery', async () => {
  const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
  assert.equal(result.json.state, 'queued');
  // The only trigger after the request turns out to be a person's, not the request's own.
  state.timeline.at(-1)!.actor.id = HUMAN_ACTOR_ID;
  assert.deepEqual((await dispatchQueued(0)).dispatched, unreconciled, 'the request\'s own write may still land');

  state.now += 11 * 60_000;
  const { dispatched, children } = await dispatchQueued(0);
  assert.deepEqual(dispatched, { status: 'skipped', reason: 'retry_request_not_owed', issueNumber: 14 });
  assert.equal(children.length, 0, 'the request is not run on another actor\'s trigger');
});
