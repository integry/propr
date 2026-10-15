/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker
 * (see taskFollowupIssueLiveQueue.ts): a fresh poll after the request's run,
 * also once another issue's follow-up discarded closed requests past their
 * retention, and a follow-up suspended after its claim that reserves and runs
 * only after a later follow-up ran.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, postFollowup, applyLabels, database, FIRST_COMMENT_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { openRequests, onIssue, dedupKey, requestChildId } from './taskFollowupIssueDispatch.js';
import {
  skip, JOB_ID, DAY_MS, owned, runRecords, retiredRecords, until, hooks, withLiveQueue, livePoll, assertDispatched, assertChildRun, assertFailedAttempt,
  assertCompleted, alreadyDispatched, assertNextFollowupRunsOnce, runRecordOf, reserveIssueRetryRequest,
} from './taskFollowupIssueLiveQueue.js';

for (const [routing, backed, later] of [['issue-only', false, false], ['issue-only', false, true], ['submission-backed', true, false]] as const) {
  test(`a fresh poll after a ${routing} retry's child failed fast and its dispatch could not record it ${later ? 'still runs a later, independent trigger as usual' : 'only settles the request, running nothing more'}`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-fresh-poll-${backed}-${later}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        live.failChildren(true);
        state.consumeFails = true;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        // The child fails at once; the dispatch's retry recognizes its run but cannot settle it, and the parent
        // carrying the request's metadata completes and is removed.
        assertFailedAttempt(await live.settled(), /database is locked/);
        assert.equal((await live.childSettled()).event, 'failed');
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        await live.drained();
        const childId = await requestChildId();
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the original parent is gone');
        assert.equal((await openRequests()).length, 1, 'the request is still open');
        assert.equal((await runRecords()).length, 1, 'with the record of its run');

        // Storage recovers; past the claim, an ordinary poll queues a fresh parent, after someone relabelled the issue or not.
        state.consumeFails = false;
        live.failChildren(false);
        state.now += 60_000;
        if (later) applyLabels(['AI'], HUMAN_ACTOR_ID);
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        const polled = await live.settled();
        assert.deepEqual([polled.job.data.retryCommentId, polled.job.data.retryRequesterId, polled.job.data.userId], [undefined, undefined, '99'],
          'the poll carries no retry metadata');
        if (later) {
          assert.equal(polled.event === 'completed' && polled.result.status, 'dispatched');
          assert.equal((await live.childSettled()).event, 'completed');
        } else {
          assertCompleted(polled, alreadyDispatched(backed));
        }
        await live.drained();
        assert.equal(live.runs.length, later ? 2 : 1, later ? 'the later trigger ran once' : 'nothing more ran on the accepted trigger');
        assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        if (later) {
          const ordinary = live.runs[1];
          assert.equal(ordinary.jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main', 'an ordinary run of the issue');
          assert.deepEqual([ordinary.data.userId, ordinary.data.retryRequesterId, ordinary.data.retryCommentId], ['99', undefined, undefined]);
        }
        assert.deepEqual(live.children.map(child => child.jobId).slice(0, 1), [childId]);
        assert.equal(live.children.length, later ? 2 : 1);
        assert.deepEqual(await openRequests(), [], 'the request is settled either way');
        assert.deepEqual(await runRecords(), []);

        await assertNextFollowupRunsOnce(live, live.runs.length);
      });
    });
  });
}

test('an issue-only retry\'s consumed trigger stays settled for fresh polls after another issue\'s follow-up discards closed requests past their retention, and a later trigger still runs once', { skip, timeout: 60_000 }, async () => {
  await onIssue(false, 'live-retention', async () => {
    await withLiveQueue(async live => {
      live.startWorker();
      // An older consumed request of the issue, reserved and run before this follow-up, and a released request of
      // another issue, both closed a day ago: past their retention once the clock moves on a week.
      const old = { repo_owner: 'integry', repo_name: 'propr', requester_id: 'user-0', publication: 'possible', recorded_at: state.now - DAY_MS };
      await database('issue_retry_request_states').insert([
        { ...old, issue_number: 14, comment_id: 4_000_001, requested_at: state.now - 2 * DAY_MS, consumed_at: state.now - DAY_MS },
        { ...old, issue_number: 16, comment_id: 4_000_002, requested_at: state.now - 2 * DAY_MS },
      ]);
      assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
      await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      const childId = await requestChildId();
      assert.equal(await live.queue.getJob(childId), undefined, 'the finished child is removed');
      assert.deepEqual(await openRequests(), [], 'the request is recorded consumed');
      assert.equal((await retiredRecords()).length, 1, 'its run\'s record is retired as its tombstone');

      // Ordinary polls, carrying no request, keep finding the issue's unchanged trigger.
      const poll = async () => {
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        const polled = await live.settled();
        assert.deepEqual([polled.job.data.retryCommentId, polled.job.data.retryRequesterId], [undefined, undefined], 'the poll carries no retry metadata');
        return polled;
      };
      state.now += 60_000;
      assertCompleted(await poll(), alreadyDispatched(false));

      // Eight days later, a follow-up on another issue reserves it, discarding closed requests past their retention:
      // the older consumed request too, as the request this follow-up reserved after it is the issue's latest.
      state.now += 8 * DAY_MS;
      const reservation = await reserveIssueRetryRequest(database, { repoOwner: 'integry', repoName: 'propr', number: 15 },
        { requesterId: 'user-3', requestedAt: state.now, afterEventId: null }, { events: [], now: state.now });
      assert.ok('reserved' in reservation);
      const kept = await database('issue_retry_request_states').whereNot({ issue_number: 15 }).orderBy('id').select('issue_number', 'comment_id');
      assert.deepEqual(kept.map(row => [row.issue_number, Number(row.comment_id)]), [[14, FIRST_COMMENT_ID]],
        'only the issue\'s latest consumed request outlives its retention');
      assert.equal((await retiredRecords()).length, 1, 'the run\'s tombstone is still there');

      // A poll after the cleanup still finds the trigger consumed, and runs nothing for anyone.
      assertCompleted(await poll(), alreadyDispatched(false));
      await live.drained();
      assert.equal(live.runs.length, 1, 'the consumed trigger did not run again');
      assert.deepEqual(live.children.map(child => child.jobId), [childId]);

      // A genuinely later trigger still runs once, as an ordinary run of the issue.
      state.now += 60_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const later = await poll();
      assert.equal(later.event === 'completed' && later.result.status, 'dispatched');
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.equal(live.runs.length, 2);
      assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      const ordinary = live.runs[1];
      assert.equal(ordinary.jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main', 'an ordinary run of the issue');
      assert.deepEqual([ordinary.data.userId, ordinary.data.retryRequesterId, ordinary.data.retryCommentId], ['99', undefined, undefined]);
      assert.doesNotMatch(ordinary.prompt, /First instructions/);
    });
  });
});

/**
 * A follow-up suspended once Redis accepted its claim of the issue's label-event window, before it continues from
 * that await to reconcile and reserve the issue, until `resume` runs: a process paused there, or one that slow.
 */
function suspendedAtClaim(): { reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  hooks.afterClaimSet = async () => { reach(); await resumed; };
  return { reached, resume };
}

test('an issue-only follow-up suspended after its claim, which reserves and runs after a later follow-up ran once the claim expired, leaves its own run the latest consumed: fresh polls before and after retention cleanup add no ordinary child, and a later trigger still runs once', { skip, timeout: 60_000 }, async () => {
  await onIssue(false, 'live-delayed-reservation', async () => {
    await withLiveQueue(async live => {
      live.startWorker();
      // Follow-up A passes its checks, reads its clock and baseline, and Redis accepts its 30-second claim; it is then
      // suspended before it reconciles or reserves anything, as a paused process is, and its claim is left to expire.
      const suspended = suspendedAtClaim();
      const requestedA = state.now;
      const followupA = postFollowup({ body: 'First instructions' }, 'failed-issue-task', 'user-1');
      await suspended.reached;
      assert.deepEqual(await openRequests(), [], 'A has reserved nothing yet');
      assert.equal(await owned.exists(dedupKey), 1, 'A holds the claim');
      // The claim's remaining life is cut to a millisecond, so Redis expires it as it would after the thirty seconds,
      // while the application clock moves on past that expiry; the route itself is given no sign of either.
      await owned.pexpire(dedupKey, 1);
      await until(async () => await owned.exists(dedupKey) === 0, 'the claim did not expire');
      state.now += 60_000;

      // Follow-up B, requested later, reserves the issue, publishes E2 and runs; its request is recorded consumed,
      // and its child and parent finish and are removed.
      const followupB = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(followupB.json.state, 'queued', String(followupB.json.message ?? followupB.json.error));
      const commentB = FIRST_COMMENT_ID;
      const e2 = state.timeline.at(-1)!.id;
      await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: commentB, instructions: /Second instructions/ });
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.deepEqual(await openRequests(), [], 'B is recorded consumed');
      assert.equal(await live.queue.getJob(JOB_ID), undefined, 'B\'s parent is removed');
      assert.equal(await live.queue.getJob(await requestChildId(commentB)), undefined, 'and so is its child');
      assert.deepEqual(await runRecordOf(live, commentB), { receiptEventId: String(e2) }, 'B\'s retired record names E2');

      // A resumes from its accepted claim. No request is owed, so it reserves the issue after B, with the earlier
      // requestedAt it read before its claim, posts its comment, publishes E3 after a baseline that shows E2, and runs.
      suspended.resume();
      const resultA = await followupA;
      assert.equal(resultA.json.state, 'queued', String(resultA.json.message ?? resultA.json.error));
      const commentA = FIRST_COMMENT_ID + 1;
      assert.equal(resultA.json.commentId, commentA);
      const e3 = state.timeline.at(-1)!.id;
      assert.ok(e3 > e2, 'A published its own trigger after B\'s');
      await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: commentA, instructions: /First instructions/ });
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      const requests = await database('issue_retry_request_states').where({ issue_number: 14 }).orderBy('id')
        .select('comment_id', 'requested_at', 'consumed_at') as Array<{ comment_id: number; requested_at: number; consumed_at: number | null }>;
      assert.deepEqual(requests.map(row => Number(row.comment_id)), [commentB, commentA], 'A was reserved after B');
      assert.equal(Number(requests[1].requested_at), requestedA, 'with the requestedAt it read, kept as it was');
      assert.ok(Number(requests[1].requested_at) < Number(requests[0].requested_at), 'which is earlier than B\'s');
      assert.ok(requests.every(row => row.consumed_at !== null), 'and both are recorded consumed');
      assert.deepEqual(await runRecordOf(live, commentA), { receiptEventId: String(e3) }, 'A\'s retired record names E3');
      assert.equal(live.runs.length, 2);
      assertChildRun(live.runs[0], { jobId: await requestChildId(commentB), requester: 'user-2', commentId: commentB, instructions: /Second instructions/, foreign: /First instructions/ });
      assertChildRun(live.runs[1], { jobId: await requestChildId(commentA), requester: 'user-1', commentId: commentA, instructions: /First instructions/, foreign: /Second instructions/ });
      const requestedChildren = [await requestChildId(commentB), await requestChildId(commentA)];

      // Ordinary polls, carrying no request, find the issue's latest trigger, E3: A's run consumed it, as the latest
      // reserved request's retired record shows, whatever B's later requestedAt says.
      const poll = async () => {
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        const polled = await live.settled();
        assert.deepEqual([polled.job.data.retryCommentId, polled.job.data.retryRequesterId], [undefined, undefined], 'the poll carries no retry metadata');
        return polled;
      };
      state.now += 60_000;
      assertCompleted(await poll(), alreadyDispatched(false));
      await live.drained();
      assert.equal(live.runs.length, 2, 'E3 did not run again as an ordinary trigger');
      assert.deepEqual(live.children.map(child => child.jobId), requestedChildren, 'no ordinary child was added');

      // Eight days later, a follow-up on another issue discards closed requests past their retention: the latest
      // reserved request, A's, is the one kept, with its mapping to E3.
      state.now += 8 * DAY_MS;
      const reservation = await reserveIssueRetryRequest(database, { repoOwner: 'integry', repoName: 'propr', number: 15 },
        { requesterId: 'user-3', requestedAt: state.now, afterEventId: null }, { events: [], now: state.now });
      assert.ok('reserved' in reservation);
      const kept = await database('issue_retry_request_states').where({ issue_number: 14 }).select('comment_id') as Array<{ comment_id: number }>;
      assert.deepEqual(kept.map(row => Number(row.comment_id)), [commentA], 'A\'s mapping to E3 outlives its retention; B\'s older receipt does not');
      assert.equal((await retiredRecords()).length, 2, 'the queue\'s tombstones are untouched');
      assertCompleted(await poll(), alreadyDispatched(false));
      await live.drained();
      assert.equal(live.runs.length, 2, 'E3 did not run again after the cleanup either');
      assert.deepEqual(live.children.map(child => child.jobId), requestedChildren, 'still no ordinary child');

      // A genuinely later trigger still runs once, as an ordinary run of the issue, for no one's request.
      state.now += 60_000;
      applyLabels(['AI'], HUMAN_ACTOR_ID);
      const later = await poll();
      assert.equal(later.event === 'completed' && later.result.status, 'dispatched');
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.equal(live.runs.length, 3, 'the later trigger ran once');
      const ordinary = live.runs[2];
      assert.equal(ordinary.jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main', 'an ordinary run of the issue');
      assert.deepEqual([ordinary.data.userId, ordinary.data.retryRequesterId, ordinary.data.retryCommentId], ['99', undefined, undefined]);
      assert.doesNotMatch(ordinary.prompt, /First instructions|Second instructions/);
      assert.equal(live.children.length, 3);
    });
  });
});
