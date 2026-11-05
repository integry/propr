import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, claims, add, postFollowup, database, applyLabels, APP_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, dispatchQueued, promptFor, onIssue, takeRecordsOffline, deliverAndDispatch, pollDelivery, relabelWebhook, dedupKey, requestChildId } from './taskFollowupIssueDispatch.js';

// A trigger write's outcome the route learned but could not record with its
// request is kept in Redis as durable evidence of that write. It survives the
// API process that learned it and any job carrying it, so the next delivery's
// dispatch, or a later follow-up, records it: an applied write runs the
// request for its requester, and a refusal releases it rather than leaving
// its trigger, or the issue, deferred for good.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null } | undefined>;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const ORIGINAL = 'Retry with the original instructions';

/** The outcomes kept in Redis because the route could not record them. */
const keptOutcomes = () => [...claims].filter(([key]) => key.startsWith('issue:retry-outcome:')).map(([, publication]) => publication);

/**
 * Posts a request whose trigger write GitHub answers while the request records
 * are unavailable, then brings them back; returns the receipt.
 */
async function publishWhileRecordsOffline(body = ORIGINAL) {
  let restore: () => Promise<void> = async () => undefined;
  state.onLabelAdd = async () => { restore = await takeRecordsOffline(); };
  const result = await postFollowup({ body }, 'failed-issue-task');
  state.onLabelAdd = undefined;
  return { result, restore: async () => { await restore(); } };
}

/** The dispatched run carries the first request, for its requester and with its instructions, on its own trigger. */
async function assertRequestRun(backed: boolean, own: number, { dispatched, children }: Awaited<ReturnType<typeof dispatchQueued>>) {
  assert.equal(dispatched.status, 'dispatched');
  const [{ jobId, data: child }] = children;
  assert.equal(jobId, await requestChildId());
  if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
  assert.equal(child.userId, 'user-1');
  assert.equal(child.retryRequesterId, 'user-1');
  assert.equal(child.retryCommentId, FIRST_COMMENT_ID);
  assert.match(await promptFor(child), new RegExp(ORIGINAL));
  if (backed) assert.equal((await submissionRow())?.retry_event_id, String(own));
  assert.deepEqual(await openRequests(), [], 'the request is released once its run carries it');
  assert.deepEqual(keptOutcomes(), [], 'its kept outcome is dropped once recorded');
}

for (const [routing, backed] of routings) {
  test(`${routing} confirmed request whose outcome record and job are lost with the API process runs for its requester on the next delivery`, async () => {
    await onIssue(backed, `kept-confirmed-${backed}`, async () => {
      // GitHub confirms the write; the records are offline and the queue rejects its job without accepting it.
      state.queueFails = true;
      const { result, restore } = await publishWhileRecordsOffline();
      state.queueFails = false;
      await restore();
      assert.equal(result.json.state, 'unknown');
      assert.equal(add.mock.callCount(), 1);
      assert.deepEqual(keptOutcomes(), ['possible'], 'the confirmed outcome is kept beyond the process');
      // The API process restarts, losing its outcome retry.
      state.outcomeRetries = [];
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
      const own = state.timeline.at(-1)!.id;

      // An hour later, a fresh delivery records the kept outcome and runs the request.
      state.now += HOUR_MS;
      await assertRequestRun(backed, own, await deliverAndDispatch(pollDelivery));

      // A later follow-up is an ordinary request of its own, not a restart.
      state.now += 60_000;
      claims.delete(dedupKey);
      const next = await postFollowup({ body: 'Next instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(next.json.state, 'queued');
      assert.equal(next.json.posted, true);
      assert.equal(next.json.commentId, FIRST_COMMENT_ID + 1);
      assert.equal(next.json.restartedRequest, undefined);
    });
  });

  test(`${routing} confirmed request whose queued job exhausts its attempts in a database outage longer than the route's retries runs once the database recovers`, async () => {
    await onIssue(backed, `kept-exhausted-${backed}`, async () => {
      const { result, restore } = await publishWhileRecordsOffline();
      assert.equal(result.json.state, 'unknown');
      assert.match(String(result.json.message), /could not be recorded yet/);
      assert.equal(add.mock.callCount(), 1, 'the job carrying the confirmation is queued');
      const own = state.timeline.at(-1)!.id;

      // Every attempt of that job fails while the database is down, and the queue drops it.
      for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(dispatchQueued(0), /no such table/);
      // The route's retries run out after a day, the database still down.
      state.now += DAY_MS + HOUR_MS;
      for (const retry of state.outcomeRetries) assert.equal(await retry(), false);
      state.outcomeRetries = [];
      await restore();
      assert.deepEqual(keptOutcomes(), ['possible']);

      // A delivery whose record fails leaves the outcome kept for the next.
      state.confirmFails = true;
      claims.delete(dedupKey);
      assert.notEqual((await relabelWebhook()).status, 'ignored');
      await assert.rejects(dispatchQueued(add.mock.callCount() - 1), /database is locked/);
      state.confirmFails = false;
      assert.deepEqual(keptOutcomes(), ['possible']);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);

      await assertRequestRun(backed, own, await deliverAndDispatch(pollDelivery));
    });
  });

  test(`${routing} refusal only Redis kept releases its request, so the app's later trigger runs without it`, async () => {
    await onIssue(backed, `kept-refused-delivery-${backed}`, async () => {
      state.labelAdd = 'rejected';
      const { result, restore } = await publishWhileRecordsOffline('Retry');
      state.labelAdd = 'ok';
      await restore();
      state.outcomeRetries = [];
      assert.equal(result.json.state, 'failed');
      assert.deepEqual(keptOutcomes(), ['refused']);

      // Within the request's window the app's own identity triggers the issue; the kept refusal tells it is not the request's.
      state.now += 60_000;
      applyLabels(['AI'], APP_ACTOR_ID);
      const { dispatched, children: [{ data: child }] } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      assert.equal(child.retryCommentId, undefined, 'the refused request\'s instructions are not run');
      assert.equal(child.retryRequesterId, undefined);
      if (backed) assert.equal(child.userId, 'submitter');
      assert.deepEqual(await openRequests(), []);
      assert.deepEqual(keptOutcomes(), []);
    });
  });

  test(`${routing} refusal only Redis kept is recorded by a later follow-up, which is posted as a request of its own rather than restarting the refused one`, async () => {
    await onIssue(backed, `kept-refused-followup-${backed}`, async () => {
      state.labelAdd = 'rejected';
      const { result, restore } = await publishWhileRecordsOffline('Refused instructions');
      state.labelAdd = 'ok';
      await restore();
      state.outcomeRetries = [];
      assert.equal(result.json.state, 'failed');

      // The app's identity labels the issue within the request's window, but no delivery comes.
      state.now += 60_000;
      applyLabels(['AI'], APP_ACTOR_ID);
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      const later = await postFollowup({ body: 'Later instructions' }, 'failed-issue-task', 'user-2');
      assert.equal(later.json.state, 'queued');
      assert.equal(later.json.posted, true);
      assert.equal(later.json.restartedRequest, undefined, 'a request GitHub refused is never restarted');
      assert.equal(later.json.commentId, FIRST_COMMENT_ID + 1);
      assert.deepEqual(keptOutcomes(), []);

      const { dispatched, children: [{ data: child }] } = await dispatchQueued(add.mock.callCount() - 1);
      assert.equal(dispatched.status, 'dispatched');
      assert.equal(child.userId, 'user-2');
      assert.equal(child.retryCommentId, FIRST_COMMENT_ID + 1);
      const prompt = await promptFor(child);
      assert.match(prompt, /Later instructions/);
      assert.doesNotMatch(prompt, /Refused instructions/);
    });
  });
}
