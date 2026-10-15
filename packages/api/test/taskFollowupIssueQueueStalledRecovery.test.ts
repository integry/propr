/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker
 * (see taskFollowupIssueLiveQueue.ts): a dispatch that resumes after another
 * worker's stalled check recovered its job and ran the request's child, such a
 * dispatch's stale settlement after a newer request consumed a later trigger,
 * and one whose run another worker accepted past an independent relabel.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Queue } from 'bullmq';
import { state, postFollowup, applyLabels, database, FIRST_COMMENT_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { openRequests, onIssue, dedupKey, requestChildId, consumedTrigger } from './taskFollowupIssueDispatch.js';
import {
  skip, JOB_ID, raw, owned, runRecords, retiredRecords, until, hooks, withLiveQueue, livePoll, assertDispatched, assertChildRun, assertFailedAttempt,
  assertCompleted, alreadyDispatched, assertNextFollowupRunsOnce, runRecordOf,
} from './taskFollowupIssueLiveQueue.js';

/** The queue as a dispatch sees it that is suspended at its first child check, after it read the run's record, until `resume` runs. */
function suspendedAtCheck(): { suspend: (queue: Queue) => Queue; reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const suspend = (queue: Queue) => new Proxy(queue, { get: (target, prop) => {
    if (prop === 'getJob') return async (jobId: string) => { reach(); await resumed; return target.getJob(jobId); };
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { suspend, reached, resume };
}

/** A dispatch suspended once its selection has read a request's run record that shows a run, until `resume` runs. */
function suspendedAtRunRead(): { reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  hooks.nextRunRead = async () => { reach(); await resumed; };
  return { reached, resume };
}

/**
 * Runs `body` with a way to record the issue's latest run failing within the GitHub second of a trigger, as a run
 * that fails at once does: a trigger in that second is then admitted after a different consumed trigger. The
 * records are dropped afterwards.
 */
async function withFastFailures(body: (failsWithin: (eventId: number) => Promise<void>) => Promise<void>) {
  const { mark } = await database('task_history').max('history_id as mark').first() as { mark: number };
  try {
    await body(async eventId => {
      const event = state.timeline.find(labelled => labelled.id === eventId)!;
      await database('task_history').insert({ task_id: 'failed-issue-task', state: 'failed', timestamp: new Date(Date.parse(event.created_at) + 500).toISOString() });
    });
  } finally {
    await database('task_history').where('history_id', '>', mark).delete();
  }
}

for (const evidence of ['retained', 'retired'] as const) {
  test(`an issue-only retry's dispatch that resumes after another worker recovered its stalled job, and ran and removed the request's child, adds nothing again, with the run's record ${evidence}`, { skip, timeout: 60_000 }, async () => {
    await withLiveQueue(async live => {
      // Worker A's dispatch reads the record, finds no run, builds its children and is suspended at its child check,
      // as a process that misses its lock renewals: its lock expires, and it recovers no stalled job itself.
      const suspended = suspendedAtCheck();
      hooks.nextRunQueue = suspended.suspend;
      const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
      // A retained record is one whose request could not be recorded consumed; a retired one is the tombstone left once it was.
      state.consumeFails = evidence === 'retained';
      assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
      await suspended.reached;
      const childId = await requestChildId();

      // Worker B's stalled check recovers the same parent once A's lock expires; its dispatch adds and records the
      // child, which runs and is removed, and the parent finishes and is removed too.
      live.startWorker({ stalledInterval: 250 });
      if (evidence === 'retained') {
        assertFailedAttempt(await live.settled(), /database is locked/);
        assertCompleted(await live.settled(), alreadyDispatched(false));
      } else {
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      }
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.deepEqual(live.stalls, [JOB_ID], 'B recovered A\'s parent from its stalled check');
      assert.equal(await live.queue.getJob(childId), undefined, 'the child ran and was removed, freeing its ID');
      assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the recovered parent finished and was removed');
      assert.equal((await runRecords()).length, evidence === 'retained' ? 1 : 0);
      assert.equal((await retiredRecords()).length, evidence === 'retained' ? 0 : 1);
      const recovered = live.dispatches.length;

      // A resumes with the children it built before B ran: the record its transaction meets fences their adds.
      suspended.resume();
      await until(async () => live.dispatches.length === recovered + 1, 'the suspended dispatch did not return');
      const stale = live.dispatches.at(-1);
      if (evidence === 'retained') assert.match(stale instanceof Error ? stale.message : '', /database is locked/, 'it only tries to settle the request');
      else assert.deepEqual(stale, alreadyDispatched(false));
      await workerA.close(true);
      await live.drained();
      assert.equal(live.dispatches.length, recovered + 1, 'the parent was dispatched by A, then by B, and by nothing else');
      assert.equal(live.runs.length, 1, 'the accepted instructions ran once');
      assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      assert.deepEqual(live.children.map(child => child.jobId), [childId], 'only B added the child');
      assert.equal(await raw.exists(live.queue.toKey(childId)), 0, 'nothing is left under the child\'s ID');

      state.consumeFails = false;
      await assertNextFollowupRunsOnce(live, 1);
    });
  });
}

test('a submission-backed retry\'s dispatch that resumes after another worker recovered its stalled parent and settled its request, and a genuinely new request consumed a later trigger, keeps the later receipt, and the consumed trigger runs nothing more', { skip, timeout: 60_000 }, async () => {
  await onIssue(true, 'live-stale-settlement', async () => {
    await withFastFailures(async failsWithin => {
      await withLiveQueue(async live => {
        // Worker A's first dispatch accepts R1's run through E1, but cannot record the submission's receipt.
        const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
        state.recordDispatchFails = true;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        const e1 = state.timeline.at(-1)!.id;
        assertFailedAttempt(await live.settled(), /database is locked/);
        state.recordDispatchFails = false;
        const suspended = suspendedAtRunRead();
        assert.equal((await live.childSettled()).event, 'completed');
        assert.deepEqual(await runRecordOf(live, FIRST_COMMENT_ID), { receiptEventId: String(e1) });
        assert.equal(await consumedTrigger(), null);

        // A's retry reads R1's unretired record, and is suspended before acting on it, missing its lock renewals.
        await suspended.reached;
        // Worker B's stalled check recovers the same parent: it records E1, consumes R1, and the parent completes and is removed.
        live.startWorker({ stalledInterval: 250 });
        assertCompleted(await live.settled(), alreadyDispatched(true));
        assert.deepEqual(live.stalls, [JOB_ID]);
        assert.equal(await consumedTrigger(), String(e1));
        assert.deepEqual(await openRequests(), []);
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the recovered parent is removed');

        // A genuinely new follow-up R2 publishes E2; its dispatch accepts its run, records E2 and consumes R2. Its
        // child fails at once, within E2's second.
        live.failChildren(true);
        state.now += 60_000;
        await owned.del(dedupKey);
        const second = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
        assert.equal(second.json.state, 'queued', String(second.json.message ?? second.json.error));
        const e2 = state.timeline.at(-1)!.id;
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
        assert.equal((await live.childSettled()).event, 'failed');
        await failsWithin(e2);
        assert.equal(await consumedTrigger(), String(e2));

        // A resumes with its earlier history, submission and R1's record: its settlement keeps the later receipt.
        const recovered = live.dispatches.length;
        suspended.resume();
        await until(async () => live.dispatches.length === recovered + 1, 'the suspended dispatch did not return');
        assert.deepEqual(live.dispatches.at(-1), alreadyDispatched(true));
        await workerA.close(true);
        assert.equal(await consumedTrigger(), String(e2), 'the stale E1 receipt does not overwrite E2');

        // An ordinary redelivery of the already consumed E2 runs nothing for the submitter.
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        assertCompleted(await live.settled(), alreadyDispatched(true));
        await live.drained();
        assert.deepEqual(live.children.map(child => child.jobId), [await requestChildId(), await requestChildId(FIRST_COMMENT_ID + 1)], 'no ordinary trigger child is added');
        assert.equal(live.runs.length, 2, 'each accepted request ran once');
        assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assertChildRun(live.runs[1], {
          jobId: await requestChildId(FIRST_COMMENT_ID + 1), requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/,
        });
        assert.deepEqual(await openRequests(), []);
        assert.deepEqual(await runRecords(), []);
      });
    });
  });
});

for (const resumes of ['before-retry', 'unrecordable', 'after-newer-request'] as const) {
  const when = {
    'before-retry': 'before that worker\'s retry, records that run\'s receipt before settling the request',
    unrecordable: 'while the receipt cannot be recorded, leaves the request and the record of its run for that worker\'s retry',
    'after-newer-request': 'after that worker settled it and a newer request consumed a later trigger, keeps the later receipt',
  }[resumes];
  test(`a submission-backed retry's dispatch that resumes after another worker recovered its stalled parent and accepted its run past an independent relabel, ${when}`, { skip, timeout: 60_000 }, async () => {
    await onIssue(true, `live-accepted-elsewhere-${resumes}`, async () => {
      await withFastFailures(async failsWithin => {
        // The submission's previous failed retry consumed E0.
        const e0 = String(state.timeline[0].id);
        await database('task_submissions').where({ issue_number: 14 }).update({ retry_event_id: e0 });
        await withLiveQueue(async live => {
          // Worker A's dispatch selects R on its trigger E1, builds its children and is suspended at its child check,
          // missing its lock renewals.
          const suspended = suspendedAtCheck();
          hooks.nextRunQueue = suspended.suspend;
          const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
          assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
          await suspended.reached;

          // Someone relabels the issue, publishing E2, before worker B's stalled check recovers the parent. B selects R
          // through E2, and its transaction accepts R's run and records E2 with it, but the submission's receipt cannot
          // be recorded. Its child fails at once, within E2's second.
          state.now += 2_000;
          applyLabels(['AI'], HUMAN_ACTOR_ID);
          const e2 = state.timeline.at(-1)!.id;
          state.recordDispatchFails = true;
          live.failChildren(true);
          const workerB = live.startWorker({ stalledInterval: 250 });
          assertFailedAttempt(await live.settled(), /database is locked/);
          assert.equal((await live.childSettled()).event, 'failed');
          await failsWithin(e2);
          assert.deepEqual(live.stalls, [JOB_ID]);
          assert.deepEqual(await runRecordOf(live, FIRST_COMMENT_ID), { receiptEventId: String(e2) }, 'the queue records B\'s run through E2');
          assert.equal(await consumedTrigger(), e0);

          let latest = String(e2);
          if (resumes === 'after-newer-request') {
            state.recordDispatchFails = false;
            // B's retry records E2 and settles R.
            assertCompleted(await live.settled(), alreadyDispatched(true));
            assert.equal(await consumedTrigger(), String(e2));
            assert.deepEqual(await openRequests(), []);
            // A newer request R3 runs through E3, and fails at once, within E3's second.
            state.now += 60_000;
            await owned.del(dedupKey);
            const newer = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
            assert.equal(newer.json.state, 'queued', String(newer.json.message ?? newer.json.error));
            const e3 = state.timeline.at(-1)!.id;
            await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
            assert.equal((await live.childSettled()).event, 'failed');
            await failsWithin(e3);
            latest = String(e3);
            assert.equal(await consumedTrigger(), latest);
          } else {
            // B's retry is held back until A has resumed.
            await workerB.pause(true);
            if (resumes === 'before-retry') state.recordDispatchFails = false;
          }

          // A resumes with the children it built for E1: the fence adds none of them.
          const before = live.dispatches.length;
          suspended.resume();
          await until(async () => live.dispatches.length === before + 1, 'the suspended dispatch did not return');
          const stale = live.dispatches.at(-1);
          if (resumes === 'unrecordable') assert.match(stale instanceof Error ? stale.message : '', /database is locked/);
          else assert.deepEqual(stale, { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: 14 });
          if (resumes !== 'after-newer-request') assert.equal(await (await live.queue.getJob(JOB_ID))?.getState(), 'delayed', 'A resumed before B\'s retry');
          await workerA.close(true);

          if (resumes === 'unrecordable') {
            assert.equal(await consumedTrigger(), e0, 'the receipt is unchanged');
            assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID], 'the request stays open');
            assert.equal((await runRecords()).length, 1, 'with the unretired record of its run');
            state.recordDispatchFails = false;
          } else {
            assert.equal(await consumedTrigger(), latest, resumes === 'before-retry' ? 'A records the accepted run\'s E2, not its own E1' : 'A keeps the later receipt');
            assert.deepEqual(await openRequests(), []);
          }
          if (resumes !== 'after-newer-request') {
            workerB.resume();
            assertCompleted(await live.settled(), alreadyDispatched(true));
            assert.equal(await consumedTrigger(), String(e2));
          }

          // An ordinary redelivery of the already consumed trigger runs nothing for the submitter.
          await owned.del(dedupKey);
          assert.equal((await livePoll()).status, 'accepted');
          assertCompleted(await live.settled(), alreadyDispatched(true));
          await live.drained();
          const requested = resumes === 'after-newer-request' ? [await requestChildId(), await requestChildId(FIRST_COMMENT_ID + 1)] : [await requestChildId()];
          assert.deepEqual(live.children.map(child => child.jobId), requested, 'only B, and the newer request\'s dispatch, added a child');
          assert.equal(live.runs.length, requested.length, 'each accepted request ran once');
          assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
          if (resumes === 'after-newer-request') {
            assertChildRun(live.runs[1], {
              jobId: await requestChildId(FIRST_COMMENT_ID + 1), requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/,
            });
          }
          assert.equal(await consumedTrigger(), latest);
          assert.deepEqual(await openRequests(), []);
          assert.deepEqual(await runRecords(), []);
        });
      });
    });
  });
}
