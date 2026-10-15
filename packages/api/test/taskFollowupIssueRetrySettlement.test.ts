import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, claims, add, postFollowup, database, applyLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, postedComments, dispatchQueued, promptFor, onIssue, deliverAndDispatch, pollDelivery, dedupKey, retryRuns, requestChildId, assertIndependentRun,
} from './taskFollowupIssueDispatch.js';

/** The ID of the request posted as `commentId`. */
const requestId = async (commentId = FIRST_COMMENT_ID) => (await database('issue_retry_request_states').where({ comment_id: commentId }).first('id') as { id: number }).id;
/** Whether the queue keeps its record of the first request's run, which it keeps until the request is recorded consumed. */
const hasRunRecord = async () => await retryRuns.read({ id: await requestId(), commentId: FIRST_COMMENT_ID }) !== null;

// A request's accepted run settles it, and only it: a run whose consumption
// could not be recorded is settled by the dispatch's retry or the next
// follow-up without running again, a settlement keeps a later receipt another
// dispatch recorded, a stale or unordered history runs nothing on the triggers
// the run consumed, and a run whose record cannot be read restarts nothing.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null }>;
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };

for (const [routing, backed] of routings) {
  test(`${routing} retry whose consumption cannot be recorded is settled without running it again, and a later trigger runs without it`, async () => {
    await onIssue(backed, `consumption-unrecorded-${backed}`, async () => {
      const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      state.consumeFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/, 'the dispatch fails rather than leave its request owed silently');
      state.consumeFails = false;
      assert.ok(await hasRunRecord(), 'the queue kept its record of the request\'s run');
      if (backed) {
        assert.equal((await openRequests()).length, 1);
      } else {
        // The queue retries the failed dispatch, which finds the record of the request's run and adds nothing again.
        const retried = await dispatchQueued(0);
        assert.deepEqual(retried.dispatched, { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: 14 });
        assert.deepEqual(retried.children, []);
        assert.deepEqual(await openRequests(), []);
        assert.equal(await hasRunRecord(), false, 'the record is dropped once the request is recorded consumed');
      }

      // Within the request's lifetime the app's own identity triggers the issue again.
      state.now += 60_000;
      applyLabels(['AI'], APP_ACTOR_ID);
      await assertIndependentRun(backed);

      // The submission consumed the request's trigger, so a new request is not held back by it.
      state.now += 60_000;
      claims.delete(dedupKey);
      const next = await postFollowup({ body: 'Another retry' }, 'failed-issue-task');
      assert.equal(next.json.state, 'queued');
      assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID + 1]);
    });
  });

  if (backed) {
    test('a follow-up that settles an earlier request\'s accepted run keeps the later receipt a dispatch recorded after the follow-up read it', async () => {
      await onIssue(true, 'reconcile-later-receipt', async () => {
        assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
        const own = String(state.timeline.at(-1)!.id);
        // Its dispatch accepts its run through its own trigger, but can record neither the receipt nor the request consumed.
        state.recordDispatchFails = true;
        state.consumeFails = true;
        await assert.rejects(dispatchQueued(0), /database is locked/);
        state.recordDispatchFails = false;
        assert.ok(await hasRunRecord());
        assert.equal((await submissionRow()).retry_event_id, null);

        // Someone relabels the issue; the delivery is queued, and its claim expires before its dispatch runs.
        state.now += 60_000;
        applyLabels(['AI'], HUMAN_ACTOR_ID);
        const independent = String(state.timeline.at(-1)!.id);
        claims.delete(dedupKey);
        const relabel = add.mock.callCount();
        assert.notEqual((await pollDelivery()).status, 'ignored');
        claims.delete(dedupKey);
        // A later follow-up reads the receipt. While it reads the trigger history, the relabel's dispatch records the
        // request's trigger, still fails to record it consumed, and runs the later, independent trigger, recording it.
        state.onTimelineRead = async () => {
          state.onTimelineRead = undefined;
          const { dispatched, children } = await dispatchQueued(relabel);
          assert.equal(dispatched.status, 'dispatched');
          assert.deepEqual(children.map(child => [child.data.userId, child.data.retryCommentId]), [['submitter', undefined]]);
          assert.equal((await submissionRow()).retry_event_id, independent);
          state.consumeFails = false;
        };
        const next = await postFollowup({ body: 'Another retry' }, 'failed-issue-task', 'user-2');
        assert.equal(next.json.state, 'queued', String(next.json.error));
        assert.equal(state.onTimelineRead, undefined, 'the relabel was dispatched while the follow-up read the history');
        assert.notEqual(independent, own);
        // The follow-up records the earlier request consumed, but keeps the later receipt it did not read.
        assert.equal((await submissionRow()).retry_event_id, independent, 'the earlier request\'s trigger does not overwrite the later receipt');
        assert.equal(await hasRunRecord(), false);
        assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID + 1]);
        const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
        assert.equal(dispatched.status, 'dispatched');
        assert.deepEqual(children.map(child => [child.jobId, child.data.userId]), [[await requestChildId(FIRST_COMMENT_ID + 1), 'user-2']]);
        const latest = String(state.timeline.at(-1)!.id);
        assert.equal((await submissionRow()).retry_event_id, latest);

        // A redelivery of the consumed triggers runs nothing more.
        claims.delete(dedupKey);
        const index = add.mock.callCount();
        assert.notEqual((await pollDelivery()).status, 'ignored');
        const redelivered = await dispatchQueued(index);
        assert.deepEqual(redelivered.dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
        assert.deepEqual(redelivered.children, []);
      });
    });
  }

  test(`${routing} recovery dispatch whose history predates its request's accepted run, and during whose refresh another dispatch settles the request and runs a later trigger, runs nothing on the stale selection`, async () => {
    await onIssue(backed, `refresh-newer-receipt-${backed}`, async () => {
      // A submission's previous failed retry consumed E0.
      const e0 = String(state.timeline[0].id);
      if (backed) await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      // Independent relabels E2 and E3; the route's job accepts R's run through E3, but can record neither the
      // submission's receipt nor R consumed.
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const e3 = String(state.timeline.at(-1)!.id);
      state.recordDispatchFails = true;
      state.consumeFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      state.recordDispatchFails = false;
      state.consumeFails = false;
      assert.deepEqual(await retryRuns.read({ id: await requestId(), commentId: FIRST_COMMENT_ID }), { receiptEventId: e3 });

      // Polls queue two recovery parents carrying no request, A's and C's.
      claims.delete(dedupKey);
      const a = add.mock.callCount();
      assert.notEqual((await pollDelivery()).status, 'ignored');
      claims.delete(dedupKey);
      const c = add.mock.callCount();
      assert.notEqual((await pollDelivery()).status, 'ignored');

      // GitHub answers A's history read through E2, before E3 shows. A reads R's run through E3 and reads the history
      // afresh. That read is answered through E3, but while its answer is on its way E4 is labelled and C's dispatch
      // settles R, recording E3, and runs E4, recording that.
      const full = state.timeline;
      state.timeline = full.slice(0, -1);
      let later: Awaited<ReturnType<typeof dispatchQueued>> | undefined;
      state.onDispatchTimelineRead = async () => {
        state.timeline = full;
        state.onDispatchTimelineRead = async () => {
          state.onDispatchTimelineRead = undefined;
          state.now += 60_000;
          applyLabels(['AI'], HUMAN_ACTOR_ID);
          later = await dispatchQueued(c);
        };
      };
      const stale = await dispatchQueued(a);
      assert.equal(state.onDispatchTimelineRead, undefined, 'C was dispatched while A read the history afresh');
      const e4 = state.timeline.at(-1)!.id;
      assert.equal(later?.dispatched.status, 'dispatched');
      assert.deepEqual(later.children.map(child => [child.jobId, child.data.userId, child.data.retryCommentId]),
        [[`issue-integry-propr-14-claude-claude-opus-5-5-main${backed ? `-trigger-${e4}` : ''}`, backed ? 'submitter' : '99', undefined]], 'C runs the later E4');

      // A, whose selection admitted triggers after E0 and found R settled, runs nothing, neither E3 nor E4 again.
      assert.deepEqual(stale.dispatched, { status: 'skipped', reason: backed ? 'submission_already_dispatched' : 'retry_request_already_dispatched', issueNumber: 14 });
      assert.deepEqual(stale.children, []);
      if (backed) assert.equal((await submissionRow()).retry_event_id, String(e4));
      assert.deepEqual(await openRequests(), []);
    });
  });

  test(`${routing} recovery dispatch that no history read shows its request's accepted run to defers without running or settling anything, and runs nothing more once one does`, async () => {
    await onIssue(backed, `unordered-run-${backed}`, async () => {
      const e0 = String(state.timeline[0].id);
      if (backed) await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const e3 = String(state.timeline.at(-1)!.id);
      state.recordDispatchFails = true;
      state.consumeFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      state.recordDispatchFails = false;
      state.consumeFails = false;

      // The history the dispatch reads, however often, no longer shows E3, which R's run consumed.
      const full = state.timeline;
      state.timeline = full.slice(0, -1);
      let reads = 0;
      state.onDispatchTimelineRead = () => { reads++; };
      claims.delete(dedupKey);
      const poll = add.mock.callCount();
      assert.notEqual((await pollDelivery()).status, 'ignored');
      const deferred = await dispatchQueued(poll);
      assert.deepEqual(deferred.dispatched, unreconciled, 'its triggers cannot be ordered against the run\'s, so it defers');
      assert.deepEqual(deferred.children, []);
      assert.equal(reads, 3, 'after a bounded number of fresh reads');
      assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID], 'R is not settled on an unordered history');
      assert.deepEqual(await retryRuns.read({ id: await requestId(), commentId: FIRST_COMMENT_ID }), { receiptEventId: e3 });
      if (backed) assert.equal((await submissionRow()).retry_event_id, e0);

      // Once the history shows E3 again, a delivery settles R and runs nothing on the triggers its run consumed.
      state.timeline = full;
      state.onDispatchTimelineRead = undefined;
      const settled = await dispatchQueued(poll);
      assert.deepEqual(settled.dispatched, { status: 'skipped', reason: backed ? 'submission_already_dispatched' : 'retry_request_already_dispatched', issueNumber: 14 });
      assert.deepEqual(settled.children, []);
      assert.deepEqual(await openRequests(), []);
      if (backed) assert.equal((await submissionRow()).retry_event_id, e3);
    });
  });

  test(`${routing} retry whose run's record cannot be read once its publication window has passed is not restarted, and the next follow-up runs only its own instructions`, async () => {
    await onIssue(backed, `unreadable-run-record-${backed}`, async () => {
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      // Its dispatch adds its run but can record neither the request consumed nor the submission's receipt.
      state.consumeFails = true;
      state.recordDispatchFails = backed;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      state.consumeFails = false;
      state.recordDispatchFails = false;
      assert.ok(await hasRunRecord());

      // Past the window the request looks stranded, but whether its run was accepted cannot be read: it is not restarted.
      state.now += 11 * 60_000;
      claims.delete(dedupKey);
      state.runRecordsFail = true;
      const unchecked = await postFollowup({ body: 'Another retry' }, 'failed-issue-task', 'user-2');
      state.runRecordsFail = false;
      assert.equal(unchecked.status, 503);
      assert.match(String(unchecked.json.error), /could not be checked, so it was not restarted/);
      assert.equal(postedComments().length, 1, 'nothing more is posted');
      assert.equal(add.mock.callCount(), 1, 'nothing more is queued');
      assert.equal(state.timeline.length, 2, 'no trigger is written');
      assert.deepEqual(await database('issue_retry_request_states').whereNotNull('owed_issue').select('comment_id', 'resumed_at'),
        [{ comment_id: FIRST_COMMENT_ID, resumed_at: null }], 'the request stays open, never restarted');
      assert.equal(claims.has(dedupKey), false, 'the claim is released');

      // Once it can be read, the record settles the request, and the follow-up runs its own.
      const next = await postFollowup({ body: 'Another retry' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued', String(next.json.error));
      assert.equal(next.json.restartedRequest, undefined);
      assert.equal(await hasRunRecord(), false);
      const { dispatched, children } = await dispatchQueued(add.mock.callCount() - 1);
      assert.equal(dispatched.status, 'dispatched');
      assert.deepEqual(children.map(child => [child.jobId, child.data.userId, child.data.retryCommentId]),
        [[await requestChildId(FIRST_COMMENT_ID + 1), 'user-2', FIRST_COMMENT_ID + 1]]);
      assert.match(await promptFor(children[0].data), /Another retry/);
      assert.deepEqual(await openRequests(), []);
    });
  });

  if (!backed) {
    test('an issue-only retry whose consumption cannot be recorded is recorded consumed by the next follow-up, which runs only its own instructions', async () => {
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      state.consumeFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      state.consumeFails = false;
      assert.equal((await openRequests()).length, 1, 'no retry of the dispatch recorded it');

      // Past the publication window the request would be stranded, but its receipt shows it ran: it is not restarted.
      state.now += 11 * 60_000;
      claims.delete(dedupKey);
      const next = await postFollowup({ body: 'Another retry' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued');
      assert.equal(next.json.restartedRequest, undefined);
      assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID + 1]);
      assert.equal(await hasRunRecord(), false);
      const { dispatched, children: [child] } = await dispatchQueued(add.mock.callCount() - 1);
      assert.equal(dispatched.status, 'dispatched');
      assert.deepEqual([child.data.userId, child.data.retryCommentId], ['user-2', FIRST_COMMENT_ID + 1]);
      const prompt = await promptFor(child.data);
      assert.match(prompt, /Another retry/);
      assert.deepEqual(await openRequests(), []);
    });

    test('an issue-only retry runs under its request\'s own child ID, recorded with its children, and a run that never reached the queue is added by the retry', async () => {
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      state.runEnqueueFails = true;
      await assert.rejects(dispatchQueued(0), /Connection is closed/);
      state.runEnqueueFails = false;
      assert.equal((await openRequests()).length, 1, 'a run that was not added leaves its request owed');
      assert.equal(await hasRunRecord(), false, 'and no record of a run');
      const retried = await dispatchQueued(0);
      assert.equal(retried.dispatched.status, 'dispatched');
      const [child] = retried.children;
      assert.equal(child.jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-request-${await requestId()}-${FIRST_COMMENT_ID}`);
      assert.deepEqual([child.data.userId, child.data.retryCommentId], ['user-1', FIRST_COMMENT_ID]);
      assert.equal(child.options?.deduplication, undefined, 'its record, not an expiring deduplication, keeps it from running again');
      assert.deepEqual(await openRequests(), []);
      assert.equal(await hasRunRecord(), false);

      // A later trigger, without a request, keeps the issue's own child ID.
      state.now += 60_000;
      applyLabels(['AI'], APP_ACTOR_ID);
      const { children: [plain] } = await deliverAndDispatch();
      assert.equal(plain.jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main');
      assert.equal(plain.data.retryCommentId, undefined);
    });
  }
}

for (const persistent of [true, false]) {
  test(`a single recovery dispatch that settles its request's accepted run and selects again on a history read from before that run's receipt ${persistent ? 'defers, running nothing and keeping the receipt, and a later trigger still runs once' : 'reads it afresh until it shows the receipt, and runs nothing'}`, async () => {
    await onIssue(true, `reselect-stale-history-${persistent}`, async () => {
      // A previous failed retry consumed E0. R owns E1; E2 is an independent relabel its terminal work admits.
      const e0 = String(state.timeline[0].id);
      await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
      assert.equal((await postFollowup({ body: 'Retry' }, 'failed-issue-task')).json.state, 'queued');
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const e2 = String(state.timeline.at(-1)!.id);
      state.now += 2_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const e3 = String(state.timeline.at(-1)!.id);
      // The route's job accepts R's run through E3, but can record neither the submission's receipt nor R consumed.
      state.recordDispatchFails = true;
      state.consumeFails = true;
      await assert.rejects(dispatchQueued(0), /database is locked/);
      state.recordDispatchFails = false;
      state.consumeFails = false;
      assert.deepEqual(await retryRuns.read({ id: await requestId(), commentId: FIRST_COMMENT_ID }), { receiptEventId: e3 });
      assert.equal((await submissionRow()).retry_event_id, e0);

      // One poll's dispatch, and no other. GitHub answers its first history read through E2 only, its fresh read and
      // the settlement's through E3, and its selection on the settled receipt from before E3 again: once, or every time.
      claims.delete(dedupKey);
      const poll = add.mock.callCount();
      assert.notEqual((await pollDelivery()).status, 'ignored');
      const full = state.timeline;
      const stale = full.slice(0, -1);
      const answers = [full, full, ...(persistent ? [] : [stale])];
      let reads = 0;
      state.timeline = stale;
      state.onDispatchTimelineRead = () => { reads++; state.timeline = answers.shift() ?? (persistent ? stale : full); };
      const { dispatched, children } = await dispatchQueued(poll);
      state.onDispatchTimelineRead = undefined;
      state.timeline = full;

      // The settlement recorded E3 and R consumed; nothing ran on E2, which R's run consumed, for anyone.
      assert.deepEqual(children, [], 'no ordinary child is added for a trigger the receipt covers');
      assert.equal((await submissionRow()).retry_event_id, e3, 'the receipt never moves back to E2');
      assert.deepEqual(await openRequests(), []);
      assert.equal(await hasRunRecord(), false, 'R\'s record is retired');
      assert.notEqual(e2, e3);
      if (persistent) {
        assert.deepEqual(dispatched, { status: 'skipped', reason: 'trigger_history_unordered', issueNumber: 14 }, 'it defers');
        assert.equal(reads, 6, 'its selection on the settled receipt read the history a bounded number of times');
      } else {
        assert.deepEqual(dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
        assert.equal(reads, 5);
      }

      // A redelivery on the current history runs nothing more; a genuinely later trigger runs once, for the submitter.
      claims.delete(dedupKey);
      const redelivery = add.mock.callCount();
      assert.notEqual((await pollDelivery()).status, 'ignored');
      const redelivered = await dispatchQueued(redelivery);
      assert.deepEqual(redelivered.dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
      assert.deepEqual(redelivered.children, []);
      state.now += 60_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const e4 = String(state.timeline.at(-1)!.id);
      const { dispatched: later, children: laterChildren } = await deliverAndDispatch();
      assert.equal(later.status, 'dispatched');
      assert.deepEqual(laterChildren.map(child => [child.jobId, child.data.userId, child.data.retryCommentId]),
        [[`issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${e4}`, 'submitter', undefined]]);
      assert.equal((await submissionRow()).retry_event_id, e4);
    });
  });
}
