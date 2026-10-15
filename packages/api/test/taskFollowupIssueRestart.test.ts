import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import type { Job } from 'bullmq';
import { state, claims, add, postFollowup, database, applyLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  openRequests, postedComments, dispatchQueued, dispatcherDeps, promptFor, onIssue, takeRecordsOffline, deliverAndDispatch, relabelWebhook, pollDelivery, dedupKey,
  requestChildId, consumedTrigger, routes,
} from './taskFollowupIssueDispatch.js';

const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { selectRetryRun, reserveIssueRetryRequest } = await import('../../core/src/services/issueRetryRequest.js');

// A request still owed once its trigger write can no longer land is stranded
// when nothing will run it: its outcome was lost with the API process that
// learned it, when neither the request records nor Redis could keep it, or
// every delivery came before its trigger was visible. A later
// follow-up restarts it on a fresh trigger of its own, for its own requester
// with its own instructions, instead of posting; until then its trigger is
// deferred, never run without it.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null } | undefined>;
const unreconciled = { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: 14 };
const HOUR_MS = 60 * 60_000;
/** How many trigger adds the route sent GitHub. */
const labelAdds = () => routes().filter(route => route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels').length;
const ORIGINAL = 'Retry with the original instructions';

/** The issue's open request row, with when it was restarted. */
const heldRow = async () => database('issue_retry_request_states').where({ issue_number: 14 }).whereNotNull('owed_issue')
  .first('comment_id', 'requester_id', 'publication', 'published_at', 'resumed_at') as Promise<
    { comment_id: number; requester_id: string; publication: string; published_at: number; resumed_at: number | null } | undefined>;

/**
 * GitHub confirms the request's trigger write while the request records and
 * Redis are unavailable, so the outcome can be neither recorded nor kept, and
 * the queue rejects its job without accepting it; both stores come back, and
 * the API process restarts, losing its outcome retry.
 */
async function strandConfirmedRequest(body = ORIGINAL) {
  let restore: () => Promise<void> = async () => undefined;
  state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
  state.queueFails = true;
  const result = await postFollowup({ body }, 'failed-issue-task');
  await restore();
  state.redisFails = false;
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
  assert.equal(jobId, await requestChildId(), 'it runs under the request\'s own child ID, the same across restarts');
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
  test(`${routing} confirmed request whose outcome neither store could keep and whose job is lost with the API process is restarted by a later follow-up and runs for its requester`, async () => {
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

  test(`${routing} restart whose removal is answered after its publication window closed adds no trigger, and a further follow-up restarts it`, async () => {
    await onIssue(backed, `restart-lapsed-window-${backed}`, async () => {
      await strandConfirmedRequest();
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      const [timeline, adds] = [state.timeline.length, labelAdds()];
      state.onLabelRemove = () => { state.onLabelRemove = undefined; state.now += 11 * 60_000; };
      const lapsed = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(lapsed.json.restartedRequest, { state: 'failed', commentId: FIRST_COMMENT_ID });
      assert.match(String(lapsed.json.message), /restart lapsed before its 'AI' label was added, .* so no label was added/);
      assert.equal(labelAdds(), adds, 'no add is attempted once the restart\'s window closed');
      assert.equal(state.timeline.length, timeline, 'no trigger event is published');
      assert.equal(claims.has(dedupKey), false);
      assert.deepEqual((await openRequests()).map(held => held.publication), ['refused'], 'the request stays owed, stranded for a restart');

      // The trigger the lost write published is still not run without the request.
      applyLabels(['AI'], APP_ACTOR_ID);
      assert.deepEqual((await deliverAndDispatch()).dispatched, unreconciled);
      state.now += 60_000;
      claims.delete(dedupKey);
      const restarted = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(restarted.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
      await assertRestartedRun(backed, 'A later request');
    });
  });

  test(`${routing} restart whose removal is answered after a further restart took its write over adds no trigger`, async () => {
    await onIssue(backed, `restart-lapsed-superseded-${backed}`, async () => {
      await strandConfirmedRequest();
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      const [timeline, adds] = [state.timeline.length, labelAdds()];
      let further: Awaited<ReturnType<typeof postFollowup>> | undefined;
      state.onLabelRemove = async () => {
        state.onLabelRemove = undefined;
        // The first restart is suspended before GitHub's answer arrives, past its window and claim; a further
        // follow-up restarts the request again, whose own add GitHub refuses.
        state.now += 11 * 60_000;
        claims.delete(dedupKey);
        state.labelAdd = 'rejected';
        further = await postFollowup({ body: 'A further request' }, 'failed-issue-task', 'user-2');
        state.labelAdd = 'ok';
      };
      const lapsed = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(further?.json.restartedRequest, { state: 'failed', commentId: FIRST_COMMENT_ID });
      assert.deepEqual(lapsed.json.restartedRequest, { state: 'failed', commentId: FIRST_COMMENT_ID });
      assert.match(String(lapsed.json.message), /so no label was added/);
      assert.equal(labelAdds(), adds + 1, 'only the further restart attempted its add');
      assert.equal(state.timeline.length, timeline, 'no trigger event is published');
      const held = await heldRow();
      assert.deepEqual([held?.publication, held?.resumed_at], ['refused', held?.published_at], 'the further restart\'s refusal is kept, not the lapsed one\'s');

      state.now += 60_000;
      claims.delete(dedupKey);
      const restarted = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      assert.deepEqual(restarted.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
      await assertRestartedRun(backed, 'A later request');
    });
  });

  test(`${routing} stale evidence of the lost write does not confirm a restart whose own outcome is unrecorded`, async () => {
    await onIssue(backed, `restart-stale-evidence-${backed}`, async () => {
      // The first write's job is accepted but never dispatched, and its outcome retry outlives the restart;
      // neither store can keep either write's outcome.
      let restore: () => Promise<void> = async () => undefined;
      state.onLabelAdd = async () => { state.redisFails = true; restore = await takeRecordsOffline(); };
      assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'unknown');
      await restore();
      state.redisFails = false;
      const [staleRetry] = state.outcomeRetries;
      state.outcomeRetries = [];

      // The restart's own write is confirmed, and its record and job are lost too.
      state.now += HOUR_MS;
      claims.delete(dedupKey);
      state.queueFails = true;
      const restarted = await postFollowup({ body: 'A later request' }, 'failed-issue-task');
      await restore();
      state.redisFails = false;
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
      assert.equal(jobId, await requestChildId());
      if (backed) assert.equal(await consumedTrigger(), String(fresh), 'it ran on its own trigger');
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
      assert.equal(jobId, await requestChildId());
      if (backed) assert.equal(await consumedTrigger(), String(own.id), 'it ran on its own trigger');
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

/** Restarts a stranded request an hour later, from another user's follow-up; the restart's job is the last one queued. */
async function restartStranded() {
  await strandConfirmedRequest();
  state.now += HOUR_MS;
  claims.delete(dedupKey);
  const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task', 'user-2');
  assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
  return { index: add.mock.callCount() - 1, fresh: state.timeline.at(-1)!.id };
}

/**
 * Dispatches the restart's job while recording the request's consumption fails: its child is enqueued
 * with the request and its dispatch receipt records the fresh trigger, but the dispatch fails.
 */
async function dispatchWithoutConsumption(index: number, fresh: number) {
  const children: Array<{ jobId: string; data: IssueJobData }> = [];
  const [name, data] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  state.consumeFails = true;
  await assert.rejects(handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data: { ...data } } as Job<IssueJobData>, dispatcherDeps(children)), /database is locked/);
  state.consumeFails = false;
  assert.equal(children.length, 1);
  const [{ jobId, data: child }] = children;
  assert.equal(jobId, await requestChildId());
  assert.deepEqual([child.userId, child.retryRequesterId, child.retryCommentId], ['user-1', 'user-1', FIRST_COMMENT_ID]);
  assert.match(await promptFor(child), new RegExp(ORIGINAL));
  assert.equal((await submissionRow())?.retry_event_id, String(fresh), 'the dispatch receipt is durable');
  assert.deepEqual((await openRequests()).map(held => held.publication), ['possible'], 'the request is still open');
}

/** After the run failed again, a new follow-up is an ordinary request of its own and runs only its own instructions. */
async function assertNewFollowupRuns() {
  state.now += 60_000;
  claims.delete(dedupKey);
  const timeline = state.timeline.length;
  const next = await postFollowup({ body: 'Genuinely new instructions' }, 'failed-issue-task', 'user-2');
  assert.equal(next.json.state, 'queued');
  assert.equal(next.json.posted, true);
  assert.equal(next.json.commentId, FIRST_COMMENT_ID + 1);
  assert.equal(next.json.restartedRequest, undefined, 'the old request is not restarted');
  assert.equal(state.timeline.length, timeline + 1);
  const { dispatched, children: [{ data: child }] } = await dispatchQueued(add.mock.callCount() - 1);
  assert.equal(dispatched.status, 'dispatched');
  assert.deepEqual([child.userId, child.retryRequesterId, child.retryCommentId], ['user-2', 'user-2', FIRST_COMMENT_ID + 1]);
  const prompt = await promptFor(child);
  assert.match(prompt, /Genuinely new instructions/);
  assert.doesNotMatch(prompt, new RegExp(ORIGINAL), 'the old instructions are not replayed');
  assert.deepEqual(await openRequests(), []);
}

/** The first request's row: whether it is still owed, and whether a dispatch recorded it consumed. */
const firstRequest = async () => database('issue_retry_request_states').where({ comment_id: FIRST_COMMENT_ID })
  .first('owed_issue', 'consumed_at') as Promise<{ owed_issue: string | null; consumed_at: number | null }>;

test('a restarted submission-backed request whose run was dispatched but not recorded consumed is settled by the dispatch retry', async () => {
  await onIssue(true, 'restart-consumption-unrecorded-dispatch', async () => {
    const { index, fresh } = await restartStranded();
    await dispatchWithoutConsumption(index, fresh);

    // The queue retries the failed dispatch: the receipt shows the request was carried, so it is recorded
    // consumed and nothing is dispatched again.
    const retried = await dispatchQueued(index);
    assert.deepEqual(retried.dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
    assert.equal(retried.children.length, 0, 'the request is not run again');
    assert.deepEqual(await openRequests(), []);
    assert.deepEqual(await firstRequest(), { owed_issue: null, consumed_at: state.now });

    // Later deliveries are no longer deferred, and run nothing the receipt already consumed.
    for (const deliver of [relabelWebhook, pollDelivery]) {
      assert.deepEqual((await deliverAndDispatch(deliver)).dispatched, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
    }
    await assertNewFollowupRuns();
  });
});

test('a restarted submission-backed request whose run was dispatched but not recorded consumed is released by the next follow-up\'s reservation', async () => {
  await onIssue(true, 'restart-consumption-unrecorded-reservation', async () => {
    const { index, fresh } = await restartStranded();
    await dispatchWithoutConsumption(index, fresh);
    // No delivery or dispatch retry comes before the next follow-up.
    await assertNewFollowupRuns();
    assert.equal((await firstRequest()).owed_issue, null, 'the carried request is released, not restarted');
  });
});

test('a restarted request is settled only by a dispatch receipt at or past its own applied trigger, not by its trigger being inadmissible', async () => {
  await onIssue(true, 'restart-settlement-evidence', async () => {
    const issue = { repoOwner: 'integry', repoName: 'propr', number: 14 };
    const at = (second: number) => `2026-10-15T11:00:${String(second).padStart(2, '0')}Z`;
    const labelled = (id: number, second: number, actor = APP_ACTOR_ID) => ({ id, event: 'labeled', created_at: at(second), label: { name: 'AI' }, actor: { id: actor } });
    // 1: the initial trigger; 2: the lost write's; 3: after the restart's baseline but before its write began;
    // 4: the restart's own; 5: a person's later trigger.
    state.timeline = [labelled(1, 0, HUMAN_ACTOR_ID), labelled(2, 10), labelled(3, 20), labelled(4, 30), labelled(5, 40, HUMAN_ACTOR_ID)];
    const restartAt = Date.parse(at(30)) + 400;
    const insert = async (publication: string, afterEventId = '3') => {
      await database('issue_retry_request_states').delete();
      await database('issue_retry_request_states').insert({
        repo_owner: 'integry', repo_name: 'propr', issue_number: 14, owed_issue: 'integry/propr#14', requester_id: 'user-1',
        comment_id: FIRST_COMMENT_ID, actor_id: APP_ACTOR_ID, requested_at: restartAt - 2 * HOUR_MS, published_at: restartAt,
        after_event_id: afterEventId, publication, resumed_at: restartAt, recorded_at: restartAt,
      });
    };
    const deps = { getOctokit: async () => ({ request: async () => ({ data: state.timeline }) }) as never, processingLabels: async () => ['AI'], database, now: () => restartAt + HOUR_MS };
    // Its own trigger is not admitted however the receipt reads, so only the receipt can show it was carried.
    const select = (consumedEventId: string | null) => selectRetryRun(issue, { admitted: async () => [], consumedEventId }, deps);
    const reserve = (consumedEventId: string | null) => reserveIssueRetryRequest(database, issue,
      { requesterId: 'user-2', requestedAt: restartAt + HOUR_MS, afterEventId: '5' }, { events: state.timeline, now: restartAt + HOUR_MS, consumedEventId });

    for (const [publication, consumedEventId, afterEventId, why] of [
      ['possible', null, '3', 'no receipt'],
      ['possible', '3', '3', 'a receipt before its own trigger'],
      ['possible', '99', '3', 'a receipt the history no longer shows'],
      ['possible', '5', '99', 'a baseline the history no longer shows'],
      ['refused', '5', '3', 'a refused restart'],
      ['pending', '5', '3', 'a restart whose outcome is unknown'],
    ] as const) {
      await insert(publication, afterEventId);
      const run = await select(consumedEventId);
      assert.ok('deferred' in run, `${why}: its trigger is deferred`);
      assert.equal(run.carried, undefined, `${why}: it is not settled`);
      const reservation = await reserve(consumedEventId);
      assert.ok('owed' in reservation, `${why}: it is still owed`);
      assert.equal(reservation.owed.commentId, FIRST_COMMENT_ID);
    }

    for (const consumedEventId of ['4', '5']) {
      await insert('possible');
      const run = await select(consumedEventId);
      assert.deepEqual(run.carried?.map(held => held.commentId), [FIRST_COMMENT_ID], `a receipt of ${consumedEventId} shows the request was carried`);
      assert.ok(!('deferred' in run) && run.request === null, 'and owes this delivery nothing');
      const reservation = await reserve(consumedEventId);
      assert.ok('reserved' in reservation, 'the next follow-up is admitted');
      assert.equal(await database('issue_retry_request_states').where({ comment_id: FIRST_COMMENT_ID }).whereNotNull('owed_issue').first('id'), undefined);
    }
    await database('issue_retry_request_states').delete();
  });
});
