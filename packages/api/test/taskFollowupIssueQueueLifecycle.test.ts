/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker
 * (see taskFollowupIssueLiveQueue.ts): repeated retries through their actual
 * child runs, children that complete or fail before their dispatch's retry, or
 * while no dispatch attempt can record them, recovered a day later, a run the
 * next follow-up settles past the publication window, and a request whose
 * follow-up passed its checks while another request's child runs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, postFollowup, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, onIssue, dedupKey, requestChildId, postedComments } from './taskFollowupIssueDispatch.js';
import {
  skip, JOB_ID, DAY_MS, raw, owned, ownedKeys, runRecords, retiredRecords, withLiveQueue, routings, assertDispatched, assertChildRun, assertFailedAttempt,
  assertCompleted, alreadyDispatched, assertNextFollowupRunsOnce,
} from './taskFollowupIssueLiveQueue.js';

for (const [routing, backed] of routings) {
  test(`repeated ${routing} retries each run their actual child once for their own requester, through a parent dispatch retry`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-repeated-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        // The first retry's child is held running while its dispatch fails to record the request consumed.
        const release = live.holdChildren();
        state.consumeFails = true;
        const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
        assert.equal(first.json.state, 'queued');
        assert.equal(first.json.jobId, JOB_ID);
        assert.equal(first.json.commentId, FIRST_COMMENT_ID);
        assert.ok(await owned.exists(dedupKey), 'the route\'s claim is in the suite\'s namespace');
        const firstChild = await requestChildId();
        assertFailedAttempt(await live.settled(), /database is locked/);
        state.consumeFails = false;
        await live.reaches(firstChild, 'active');

        // BullMQ retries the dispatch after its backoff, while the child still runs: the queue's record of the
        // request's run shows it was carried, so it is recorded consumed and nothing is added again.
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        assert.deepEqual(live.children.map(child => child.jobId), [firstChild]);
        assert.deepEqual(await runRecords(), [], 'the record is retired once the request is recorded consumed');
        assert.equal((await retiredRecords()).length, 1, 'and kept as its tombstone');
        assert.deepEqual(await openRequests(), []);
        release();
        assert.equal((await live.childSettled()).event, 'completed');
        await live.drained();
        assert.equal(live.runs.length, 1, 'the request\'s child ran once');
        assertChildRun(live.runs[0], { jobId: firstChild, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the completed dispatcher job is removed, freeing its ID');
        if (backed) assert.equal(await (await live.queue.getJob(firstChild))?.getState(), 'completed', 'a submission\'s child is kept as its receipt');
        else assert.equal(await live.queue.getJob(firstChild), undefined, 'an issue-only child is removed');

        // The run failed again; once the claim expires another user retries, on the same dispatcher job ID.
        await assertNextFollowupRunsOnce(live, 1);
        assert.notEqual(live.runs[1].jobId, firstChild, 'each request runs a child of its own');
        const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
      });
    });
  });
}

for (const outcome of ['completes', 'fails'] as const) {
  test(`an issue-only retry whose child ${outcome} before its dispatch's retry, after recording the request consumed failed, runs once even when the retry comes a day later, and the next follow-up runs its own`, { skip, timeout: 60_000 }, async () => {
    await withLiveQueue(async live => {
      live.startWorker();
      // The run ends fast, as on the original agent authentication failure, while its dispatch fails to record the request consumed.
      live.failChildren(outcome === 'fails');
      state.consumeFails = true;
      const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
      assert.equal(first.json.state, 'queued');
      assertFailedAttempt(await live.settled(), /database is locked/);
      const childId = await requestChildId();
      assert.deepEqual(live.children.map(child => child.jobId), [childId]);
      const [record] = await runRecords();
      assert.ok(record, 'the child\'s add wrote the queue\'s record of the request\'s run');
      assert.equal(await raw.pttl(record), -1, 'which has no expiry');
      assert.deepEqual(await ownedKeys('bull:*:de:*'), [], 'no expiring deduplication stands in for it');

      // The child ends and is removed, freeing its ID, before BullMQ retries the dispatch after its backoff.
      assert.equal((await live.childSettled()).event, outcome === 'completes' ? 'completed' : 'failed');
      assert.equal(await live.queue.getJob(childId), undefined, 'the ended child is removed, freeing its ID');
      assert.equal(await (await live.queue.getJob(JOB_ID))?.getState(), 'delayed', 'the dispatch has not retried yet');
      // The retry resumes after the outage, more than a day later by the application's clock.
      state.now += DAY_MS + 60 * 60_000;
      assert.equal(await raw.exists(record), 1, 'the record outlives any day-long expiry');
      state.consumeFails = false;
      assertCompleted(await live.settled(), alreadyDispatched(false));
      assert.deepEqual(live.children.map(child => child.jobId), [childId], 'nothing is added again');
      await live.drained();
      assert.equal(live.runs.length, 1, 'the request\'s child ran once');
      assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      assert.deepEqual(await openRequests(), [], 'the request is recorded consumed');
      assert.deepEqual(await runRecords(), [], 'and its record is retired');

      await assertNextFollowupRunsOnce(live, 1);
      const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
    });
  });

  for (const [routing, backed] of routings) {
    test(`a ${routing} retry whose child ${outcome} while no dispatch attempt can record it is not run again after a day and a worker restart, and the next follow-up runs its own`, { skip, timeout: 60_000 }, async () => {
      await onIssue(backed, `live-exhausted-run-${outcome}-${backed}`, async () => {
        await withLiveQueue(async live => {
          live.startWorker();
          live.failChildren(outcome === 'fails');
          // No attempt can record the request consumed, or the submission's receipt either.
          state.consumeFails = true;
          state.recordDispatchFails = backed;
          const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
          assert.equal(first.json.state, 'queued');
          const [, queuedJob] = [first, await live.queue.getJob(JOB_ID)];
          const original = queuedJob!.data;
          // The first attempt cannot record the request consumed, or the receipt; its retry finds the run's record,
          // cannot settle it either, and adds nothing. The parent is then gone while the request stays open.
          assertFailedAttempt(await live.settled(), /database is locked/);
          assertCompleted(await live.settled(), alreadyDispatched(backed));
          assert.equal((await live.childSettled()).event, outcome === 'completes' ? 'completed' : 'failed');
          await live.drained();
          assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the parent is gone');
          const childId = await requestChildId();
          assert.deepEqual(live.children.map(child => child.jobId), [childId], 'its child was added once');
          assert.equal(live.runs.length, 1);
          assert.equal((await openRequests()).length, 1, 'the request is still open');
          assert.equal((await runRecords()).length, 1, 'with the record of its run');

          // A day later the stores recover and the worker process restarts; the original job is delivered again.
          state.now += DAY_MS + 60 * 60_000;
          state.consumeFails = false;
          state.recordDispatchFails = false;
          await live.restartWorker();
          await live.queue.add('processGitHubIssue', original, { jobId: JOB_ID, removeOnComplete: true, removeOnFail: true });
          assertCompleted(await live.settled(), alreadyDispatched(backed));
          await live.drained();
          assert.deepEqual(live.children.map(child => child.jobId), [childId], 'nothing is added again');
          assert.equal(live.runs.length, 1, 'the accepted instructions ran once');
          assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
          assert.deepEqual(await openRequests(), []);
          assert.deepEqual(await runRecords(), []);

          await assertNextFollowupRunsOnce(live, 1);
        });
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run failed while its dispatch could not record it is settled by the next follow-up after the publication window, which runs its own instead of restarting it`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-settled-by-followup-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        live.failChildren(true);
        state.consumeFails = true;
        state.recordDispatchFails = backed;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        // Its retry finds the run's record, cannot settle it, and adds nothing; the request stays open, and a
        // submission's trigger is never recorded consumed.
        assertFailedAttempt(await live.settled(), /database is locked/);
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        assert.equal((await live.childSettled()).event, 'failed');
        await live.drained();
        state.consumeFails = false;
        state.recordDispatchFails = false;
        if (backed) assert.equal(await (await live.queue.getJob(await requestChildId()))?.getState(), 'failed', 'its failed child is kept, and blocks nothing');
        assert.equal(live.runs.length, 1);
        assert.equal((await openRequests()).length, 1);
        assert.equal((await runRecords()).length, 1);

        // Past the publication window the request would be stranded and restarted; its record shows it ran.
        state.now += 11 * 60_000;
        await live.restartWorker();
        await assertNextFollowupRunsOnce(live, 1);
        assert.equal(postedComments().length, 2, 'the new follow-up is posted, not discarded as the earlier one');
      });
    });
  });
}

for (const [routing, backed] of routings) {
  test(`a ${routing} follow-up that passed its checks while another request's child runs runs its own child once for its own requester`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-concurrent-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        const release = live.holdChildren();
        // The second follow-up passes its checks, then waits on GitHub's issue read.
        let reached = () => {};
        const atIssueRead = new Promise<void>(resolve => { reached = resolve; });
        let resume = () => {};
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        state.onIssueRead = async () => { state.onIssueRead = undefined; reached(); await resumed; };
        const second = postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
        await atIssueRead;

        // Meanwhile the first follow-up is published and dispatched, and its child runs; its request is recorded consumed.
        const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
        assert.equal(first.json.state, 'queued');
        assert.equal(first.json.commentId, FIRST_COMMENT_ID);
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        const firstChild = await requestChildId();
        await live.reaches(firstChild, 'active');
        assert.deepEqual(await openRequests(), []);

        // The first request's claim expires; the second follow-up resumes while the first child still runs.
        state.now += 31_000;
        await owned.del(dedupKey);
        resume();
        const secondResult = await second;
        assert.equal(secondResult.json.state, 'queued', String(secondResult.json.message ?? secondResult.json.error));
        assert.equal(secondResult.json.commentId, FIRST_COMMENT_ID + 1);
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
        const secondChild = await requestChildId(FIRST_COMMENT_ID + 1);
        assert.notEqual(secondChild, firstChild, 'its child is not deduplicated against the running one');
        assert.deepEqual((await live.queue.getJob(secondChild))?.data.retryCommentId, FIRST_COMMENT_ID + 1, 'the queue holds its own payload');
        assert.deepEqual(await openRequests(), []);

        release();
        await live.childSettled();
        await live.childSettled();
        await live.drained();
        assert.equal(live.runs.length, 2, 'each request ran once');
        const byJob = (jobId: string) => live.runs.filter(run => run.jobId === jobId);
        assert.equal(byJob(firstChild).length, 1);
        assert.equal(byJob(secondChild).length, 1);
        assertChildRun(byJob(firstChild)[0], { jobId: firstChild, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assertChildRun(byJob(secondChild)[0], {
          jobId: secondChild, requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/,
        });
      });
    });
  });
}
