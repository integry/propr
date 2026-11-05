/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker
 * (see taskFollowupIssueLiveQueue.ts): recovery dispatches whose history
 * predates the run another worker accepted past an independent relabel, or
 * whose history read is answered only after that run settled the request.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, postFollowup, applyLabels, database, FIRST_COMMENT_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { openRequests, onIssue, dedupKey, requestChildId, consumedTrigger } from './taskFollowupIssueDispatch.js';
import {
  type LiveQueue, skip, JOB_ID, owned, runRecords, retiredRecords, until, hooks, withLiveQueue, livePoll, routings, assertDispatched, assertChildRun,
  assertFailedAttempt, assertCompleted, alreadyDispatched, runRecordOf,
} from './taskFollowupIssueLiveQueue.js';

/** A dispatch suspended once its selection has read the history and the open requests, before it reads a request's run record, until `resume` runs. */
function suspendedBeforeRunRead(): { reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  hooks.beforeRunRead = async () => { reach(); await resumed; };
  return { reached, resume };
}

/** A dispatch suspended once GitHub read the issue's timeline for it, before the answer arrives, until `resume` runs. */
function suspendedAtTimelineRead(): { reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  state.onDispatchTimelineRead = async () => {
    state.onDispatchTimelineRead = undefined;
    reach();
    await resumed;
  };
  return { reached, resume };
}

/** The ID of the ordinary child a trigger runs without a request: a submission's is the trigger's, an issue-only one the issue's. */
const ordinaryChildId = (backed: boolean, eventId: number) => `issue-integry-propr-14-claude-claude-opus-5-5-main${backed ? `-trigger-${eventId}` : ''}`;

/**
 * After the first request's run was its only child, a genuinely later relabel runs once, as an ordinary run of
 * the submitter's or of whoever relabelled, which a submission's receipt then records.
 */
async function assertLaterTriggerRunsOnce(live: LiveQueue, backed: boolean) {
  live.failChildren(false);
  state.now += 60_000;
  applyLabels(['AI'], HUMAN_ACTOR_ID);
  const later = state.timeline.at(-1)!.id;
  await owned.del(dedupKey);
  assert.equal((await livePoll()).status, 'accepted');
  const dispatched = await live.settled();
  assert.equal(dispatched.event === 'completed' && dispatched.result.status, 'dispatched', dispatched.event === 'failed' ? dispatched.error.message : undefined);
  assert.equal((await live.childSettled()).event, 'completed');
  await live.drained();
  assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId(), ordinaryChildId(backed, later)]);
  assert.equal(live.runs.length, 2, 'the request ran once, and the later trigger once');
  assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
  assert.deepEqual([live.runs[1].data.userId, live.runs[1].data.retryRequesterId, live.runs[1].data.retryCommentId], [backed ? 'submitter' : '99', undefined, undefined]);
  assert.doesNotMatch(live.runs[1].prompt, /First instructions/);
  if (backed) assert.equal(await consumedTrigger(), String(later));
  assert.deepEqual(await openRequests(), []);
  assert.deepEqual(await runRecords(), []);
}

for (const [routing, backed] of routings) {
  for (const resumes of ['settling', 'unsettled', 'unreadable'] as const) {
    const when = {
      settling: 'settles the request on that run\'s trigger',
      unsettled: 'while the request still cannot be settled, leaves it and its run\'s record for that worker\'s retry',
      unreadable: 'while the issue\'s history cannot be read afresh, fails without selecting anything',
    }[resumes];
    test(`a ${routing} recovery dispatch whose history predates the run another worker accepted, after recovering its stalled parent past an independent relabel, ${when}, adds no child for the relabel that run consumed, and a later trigger still runs once`, { skip, timeout: 60_000 }, async () => {
      await onIssue(backed, `live-stale-history-${backed}-${resumes}`, async () => {
        // A submission's previous failed retry consumed E0.
        const e0 = String(state.timeline[0].id);
        if (backed) await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
        await withLiveQueue(async live => {
          // Request R publishes E1, but the job the route queued for it is lost before any worker runs it.
          assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
          const e1 = state.timeline.at(-1)!.id;
          await (await live.queue.getJob(JOB_ID))!.remove();
          // Someone relabels the issue, publishing the independent E2. A poll queues a recovery parent carrying no
          // request; worker A's dispatch reads the history through E2 and the open R, and is suspended before it
          // reads R's run record, missing its lock renewals.
          state.now += 2_000;
          applyLabels(['AI'], HUMAN_ACTOR_ID);
          const e2 = state.timeline.at(-1)!.id;
          await owned.del(dedupKey);
          assert.equal((await livePoll()).status, 'accepted');
          const suspended = suspendedBeforeRunRead();
          const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
          await suspended.reached;

          // Another relabel publishes E3 before worker B's stalled check recovers the same parent. B selects R through
          // E3, and its transaction accepts R's run and records E3 with it, but storage cannot record the
          // submission's receipt or the request consumed. R's child fails at once.
          state.now += 2_000;
          applyLabels(['AI'], HUMAN_ACTOR_ID);
          const e3 = state.timeline.at(-1)!.id;
          state.recordDispatchFails = true;
          state.consumeFails = true;
          live.failChildren(true);
          const workerB = live.startWorker({ stalledInterval: 250 });
          assertFailedAttempt(await live.settled(), /database is locked/);
          assert.equal((await live.childSettled()).event, 'failed');
          assert.deepEqual(live.stalls, [JOB_ID]);
          assert.deepEqual(await runRecordOf(live, FIRST_COMMENT_ID), { receiptEventId: String(e3) }, 'the queue records B\'s run through E3');
          assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId()]);
          // B's retry is held back until A has returned.
          await workerB.pause(true);
          if (resumes !== 'unsettled') {
            state.recordDispatchFails = false;
            state.consumeFails = false;
          }
          state.dispatchTimelineFails = resumes === 'unreadable';

          // A resumes with its history through E2 and reads R's record of a run through E3.
          const before = live.dispatches.length;
          suspended.resume();
          await until(async () => live.dispatches.length === before + 1, 'the suspended dispatch did not return');
          const stale = live.dispatches.at(-1);
          if (resumes === 'unreadable') assert.match(stale instanceof Error ? stale.message : '', /ECONNRESET/);
          else assert.deepEqual(stale, alreadyDispatched(backed));
          assert.equal(await (await live.queue.getJob(JOB_ID))?.getState(), 'delayed', 'A resumed before B\'s retry');
          await workerA.close(true);
          assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId()], 'A adds no ordinary child for E2, or for any trigger R\'s run consumed');
          if (resumes === 'settling') {
            if (backed) assert.equal(await consumedTrigger(), String(e3), 'A records the accepted run\'s E3');
            assert.deepEqual(await openRequests(), []);
          } else {
            if (backed) assert.equal(await consumedTrigger(), e0, 'the receipt is unchanged');
            assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID], 'the request stays open');
            assert.equal((await runRecords()).length, 1, 'with the unretired record of its run');
          }

          // Storage and GitHub recover; B's retry settles R, if A did not, and runs nothing more.
          state.recordDispatchFails = false;
          state.consumeFails = false;
          state.dispatchTimelineFails = false;
          workerB.resume();
          assertCompleted(await live.settled(), alreadyDispatched(backed));
          await live.drained();
          assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId()], 'B\'s retry adds nothing either');
          if (backed) assert.equal(await consumedTrigger(), String(e3));
          assert.deepEqual(await openRequests(), []);
          assert.deepEqual(await runRecords(), []);

          await assertLaterTriggerRunsOnce(live, backed);
          assert.ok(e1 < e2 && e2 < e3);
        });
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`a ${routing} recovery dispatch whose history read is answered only after another worker recovered its stalled parent, ran the request past an independent relabel and settled it, adds no child for the relabel that run consumed, and a later trigger still runs once`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-settled-during-read-${backed}`, async () => {
      const e0 = String(state.timeline[0].id);
      if (backed) await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
      await withLiveQueue(async live => {
        // Request R publishes E1, but the job the route queued for it is lost before any worker runs it.
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        await (await live.queue.getJob(JOB_ID))!.remove();
        // The independent E2; a poll's recovery parent reaches worker A, whose history read GitHub answers through E2,
        // but the answer arrives only after A missed its lock renewals.
        state.now += 2_000;
        applyLabels(['AI'], HUMAN_ACTOR_ID);
        const e2 = state.timeline.at(-1)!.id;
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        const suspended = suspendedAtTimelineRead();
        const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
        await suspended.reached;

        // E3, then worker B's stalled check recovers the parent: it runs R through E3, records that, and settles R.
        state.now += 2_000;
        applyLabels(['AI'], HUMAN_ACTOR_ID);
        const e3 = state.timeline.at(-1)!.id;
        live.failChildren(true);
        live.startWorker({ stalledInterval: 250 });
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.equal((await live.childSettled()).event, 'failed');
        assert.deepEqual(live.stalls, [JOB_ID]);
        if (backed) assert.equal(await consumedTrigger(), String(e3));
        assert.deepEqual(await openRequests(), []);
        assert.equal((await retiredRecords()).length, 1, 'R\'s retired record names its run through E3');
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the recovered parent is removed');

        // A's answer arrives: a history through E2, and, read after it, no open request.
        const before = live.dispatches.length;
        suspended.resume();
        await until(async () => live.dispatches.length === before + 1, 'the suspended dispatch did not return');
        assert.deepEqual(live.dispatches.at(-1), alreadyDispatched(backed));
        await workerA.close(true);
        await live.drained();
        assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId()], 'A adds no ordinary child for E2, or for E3');
        if (backed) assert.equal(await consumedTrigger(), String(e3));
        assert.ok(e2 < e3);

        await assertLaterTriggerRunsOnce(live, backed);
      });
    });
  });
}
