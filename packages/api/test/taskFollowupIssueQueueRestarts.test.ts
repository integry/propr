/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker
 * (see taskFollowupIssueLiveQueue.ts): a child ID another payload holds,
 * restarts of runs that were never added, a follow-up after the initial
 * dispatch exhausted its attempts without recording its receipt, a delivery
 * while a retry's job waits, a job carrying a confirmation that exhausts its
 * attempts while the database is down, and a run whose reply the queue lost.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, postFollowup, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, onIssue, takeRecordsOffline, dedupKey, requestChildId, postedComments, receiptRecorded } from './taskFollowupIssueDispatch.js';
import {
  type Settled, skip, JOB_ID, ORIGINAL, raw, owned, outcomeKeys, runRecords, hooks, replyLosingQueue, withLiveQueue, livePoll, routings, assertDispatched,
  assertChildRun, assertFailedAttempt, assertCompleted, alreadyDispatched, assertNextFollowupRunsOnce,
} from './taskFollowupIssueLiveQueue.js';

test('a request\'s child ID that another payload holds is not taken for its run: the request stays owed and runs once for its own requester when the ID is free', { skip, timeout: 60_000 }, async () => {
  await withLiveQueue(async live => {
    assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
    const childId = await requestChildId();
    // A job of another request already holds the ID, as after the request records were reset; it waits delayed.
    const foreign = { repoOwner: 'integry', repoName: 'propr', number: 14, isChildJob: true, userId: 'user-9', retryRequesterId: 'user-9', retryCommentId: 1 };
    await live.queue.add('processGitHubIssue', foreign, { jobId: childId, delay: 60 * 60_000 });

    live.startWorker();
    assertFailedAttempt(await live.settled(), /carries another request's run/);
    assert.deepEqual((await live.queue.getJob(childId))?.data.retryRequesterId, 'user-9', 'BullMQ kept the foreign payload');
    assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID], 'the request stays owed');
    assert.deepEqual(await runRecords(), [], 'with no record of a run');
    assert.equal(live.runs.length, 0);

    // Once the ID is free, the dispatch's retry adds the request's own run.
    await (await live.queue.getJob(childId))!.remove();
    await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
    await live.childSettled();
    await live.drained();
    assert.equal(live.runs.length, 1);
    assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
    assert.deepEqual(await openRequests(), []);
  });
});

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run was never added is restarted after its parent exhausts its attempts, and runs once for its own requester`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-never-added-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        state.runEnqueueFails = true;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        for (let attempt = 0; attempt < 3; attempt++) assertFailedAttempt(await live.settled(), /Connection is closed/);
        await live.drained();
        state.runEnqueueFails = false;
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted parent is removed');
        assert.equal(live.runs.length, 0);
        assert.deepEqual(await runRecords(), []);

        // Past the publication window a later follow-up restarts it: nothing shows it ever ran.
        state.now += 11 * 60_000;
        await owned.del(dedupKey);
        const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task', 'user-2');
        assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
        assert.equal(postedComments().length, 1, 'the later request waits for the restarted run');
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        await live.childSettled();
        await live.drained();
        assert.equal(live.runs.length, 1);
        assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.deepEqual(await openRequests(), []);
        assert.deepEqual(await runRecords(), []);
      });
    });
  });
}

test('a submission-backed follow-up by another user, after the initial dispatch ran the submitter\'s actual child but exhausted its attempts without recording its receipt, runs its own actual child once for that user', { skip, timeout: 60_000 }, async () => {
  await onIssue(true, 'live-initial-receipt-unrecorded', async () => {
    await withLiveQueue(async live => {
      live.startWorker();
      // The submission's initial delivery: each attempt adds the submitter's child, which fails fast, but cannot record the receipt.
      live.failChildren(true);
      state.recordDispatchFails = true;
      assert.notEqual((await livePoll()).status, 'ignored');
      for (let attempt = 0; attempt < 3; attempt++) assertFailedAttempt(await live.settled(), /database is locked/);
      assert.equal((await live.childSettled()).event, 'failed');
      await live.drained();
      state.recordDispatchFails = false;
      const initialChild = 'issue-integry-propr-14-claude-claude-opus-5-5-main';
      assert.deepEqual(live.children.map(child => child.jobId), [initialChild, initialChild, initialChild], 'every attempt adds the same ordinary child');
      assert.equal(live.runs.length, 1, 'which BullMQ deduplicates, so it ran once');
      assert.deepEqual([live.runs[0].data.userId, live.runs[0].data.retryRequesterId, live.runs[0].data.retryCommentId], ['submitter', undefined, undefined]);
      assert.equal(await (await live.queue.getJob(initialChild))?.getState(), 'failed', 'the failed child is kept, and blocks nothing');
      assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted parent is removed');
      assert.equal(await receiptRecorded(), false, 'the receipt is still not recorded');

      // The run failed without a PR; another user follows up, and their own child runs for them, once.
      live.failChildren(false);
      state.now += 60_000;
      await owned.del(dedupKey);
      const next = await postFollowup({ body: 'Second user instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
      assert.equal(next.json.restartedRequest, undefined);
      await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID, instructions: /Second user instructions/ });
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.equal(live.runs.length, 2, 'the submitter\'s initial child did not run again');
      assertChildRun(live.runs[1], { jobId: await requestChildId(), requester: 'user-2', commentId: FIRST_COMMENT_ID, instructions: /Second user instructions/ });
      assert.equal(await receiptRecorded(), true, 'the receipt records the request\'s dispatch');
      assert.deepEqual(await openRequests(), []);
      assert.deepEqual(await runRecords(), []);
    });
  }, { receipt: false });
});

test('a delivery while an issue-only retry\'s job waits does not replace it, and the one job runs for the requester', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'queued');
    assert.equal((await live.queue.getJob(JOB_ID))?.data.retryCommentId, FIRST_COMMENT_ID);

    // Past the claim, a poll finds the job waiting; an add that reaches BullMQ with its ID keeps it too.
    await owned.del(dedupKey);
    assert.deepEqual(await livePoll(), { status: 'ignored', reason: 'job_already_queued' });
    await live.queue.add('processGitHubIssue', { repoOwner: 'integry', repoName: 'propr', number: 14, userId: '99', triggeringLabel: 'AI' }, { jobId: JOB_ID });
    const kept = await live.queue.getJob(JOB_ID);
    assert.deepEqual([kept?.data.retryRequesterId, kept?.data.retryCommentId], ['user-1', FIRST_COMMENT_ID]);
    assert.equal(await live.queue.getWaitingCount(), 1);

    live.startWorker();
    await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
    assert.equal(live.children.length, 1);
    await live.childSettled();
    assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
    assert.deepEqual(await openRequests(), []);
  });
});

for (const [routing, backed] of [['a submission-backed', true], ['an issue-only', false]] as const) {
  test(`${routing} job carrying a confirmation that exhausts its attempts while the database is down is removed, and the outcome Redis kept runs the request on the next poll`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-exhausted-${backed}`, async () => {
      await withLiveQueue(async live => {
        // GitHub confirms the write while the request records are offline; the job carrying it is queued.
        let restore: () => Promise<void> = async () => undefined;
        state.onLabelAdd = async () => { restore = await takeRecordsOffline(); };
        const result = await postFollowup({ body: ORIGINAL }, 'failed-issue-task');
        state.onLabelAdd = undefined;
        assert.equal(result.json.state, 'unknown');
        const own = state.timeline.at(-1)!.id;
        const outcomes = await outcomeKeys();
        assert.equal(outcomes.length, 1);
        assert.equal(await raw.get(outcomes[0]), 'possible', 'the confirmed outcome is kept in Redis without expiry');
        assert.equal(await raw.ttl(outcomes[0]), -1);
        // The API process restarts, losing its outcome retry.
        state.outcomeRetries = [];

        live.startWorker();
        const attempts: Settled[] = [];
        for (let attempt = 0; attempt < 3; attempt++) attempts.push(await live.settled());
        assert.deepEqual(attempts.map(settled => settled.event), ['failed', 'failed', 'failed']);
        assert.equal(attempts[2].job.attemptsMade, 3);
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted job is removed');
        assert.equal(live.children.length, 0);
        assert.equal(await raw.get(outcomes[0]), 'possible', 'the outcome outlives the job');

        await restore();
        assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted', 'a fresh job takes the freed ID');
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        assert.equal(live.children[0].jobId, await requestChildId());
        if (backed) assert.equal(live.children[0].data.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
        await live.childSettled();
        assertChildRun(live.runs[0], { jobId: live.children[0].jobId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        assert.deepEqual(await outcomeKeys(), [], 'the outcome is dropped once recorded');
        assert.deepEqual(await openRequests(), []);
      });
    });
  });
}

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run the queue accepted, though the reply was lost, runs once and is settled by its dispatch's retry`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-lost-reply-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        hooks.nextRunQueue = queue => replyLosingQueue(queue, true);
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        assertFailedAttempt(await live.settled(), /Connection lost after the transaction ran/);
        // Redis accepted the child with the record of its run, whatever the dispatch heard: the child runs.
        assert.equal((await live.childSettled()).event, 'completed');
        // The dispatch's retry finds the record, settles the request and adds nothing.
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        await live.drained();
        assert.equal(live.runs.length, 1, 'the accepted run ran once');
        assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.deepEqual(await openRequests(), []);
        assert.deepEqual(await runRecords(), []);
        await assertNextFollowupRunsOnce(live, 1);
      });
    });
  });
}
