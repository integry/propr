import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, claims, add, postFollowup, database, applyLabels, landDelayedLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { retryRequestKey, routes, postedComments, relabelWebhook, dispatchQueued, promptFor } from './taskFollowupIssueDispatch.js';

const { insertTaskSubmission } = await import('../../core/src/services/taskSubmissionService.js');

// A held retry request belongs only to the trigger it published: a later,
// independent trigger must not adopt it when releasing it failed, and a
// trigger write that may still land keeps it for that write.

const dedupKey = 'issue:dedup:integry:propr:14';
const heldRequests = () => JSON.parse(claims.get(retryRequestKey) ?? '[]') as Array<{ commentId: number; requestedAt: number; publication: string }>;
const routings = [['a submission-backed', true], ['an issue-only', false]] as const;

/** Runs `body` on issue 14 with or without a submission whose initial run was dispatched and failed. */
async function onIssue(backed: boolean, key: string, body: () => Promise<void>) {
  const row = backed ? await insertTaskSubmission(database, { user_id: 'submitter', submission_key: key,
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' }) : null;
  try {
    if (row) await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    await body();
  } finally {
    if (row) await database('task_submissions').where({ id: row.id }).delete();
  }
}

/** A later trigger is delivered after the shared window and dispatched; it must not carry the earlier request. */
async function assertIndependentRun(backed: boolean, index: number) {
  claims.delete(dedupKey);
  assert.notEqual((await relabelWebhook()).status, 'ignored');
  const { dispatched, children } = await dispatchQueued(index);
  assert.equal(dispatched.status, 'dispatched');
  const [{ data: child }] = children;
  assert.equal(child.retryCommentId, undefined, 'the old instructions are not exempted into the new run');
  assert.equal(child.retryRequesterId, undefined);
  if (backed) assert.equal(child.userId, 'submitter', 'the new run belongs to the submitter');
  else assert.notEqual(child.userId, 'user-1', 'the new run does not belong to the earlier requester');
}

for (const [routing, backed] of routings) {
  test(`${routing} trigger write that times out and lands after a negative read-back stays unconfirmed and runs for the requester`, async () => {
    await onIssue(backed, `delayed-trigger-${backed}`, async () => {
      state.labelAdd = 'delayed';
      const result = await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task');
      assert.equal(result.status, 202);
      assert.equal(result.json.success, false);
      assert.equal(result.json.state, 'unknown', 'a negative read-back does not prove a timed-out write was refused');
      assert.match(String(result.json.message), /may still start/);
      assert.ok(routes().includes('GET /repos/{owner}/{repo}/issues/{issue_number}/labels'), 'the read-back saw no trigger');
      assert.equal(add.mock.callCount(), 0);
      assert.ok(claims.has(retryRequestKey), 'the request is held for the write that may still land');
      assert.ok(claims.has(dedupKey));

      // GitHub finishes the accepted write; its relabel is delivered after the shared window.
      state.now += 5000;
      landDelayedLabels();
      claims.delete(dedupKey);
      assert.notEqual((await relabelWebhook()).status, 'ignored');
      const { dispatched, children } = await dispatchQueued(0);
      assert.equal(dispatched.status, 'dispatched');
      const [{ data: child }] = children;
      assert.equal(child.userId, 'user-1', 'the late trigger runs for the requester');
      assert.equal(child.retryCommentId, 6157569382);
      assert.match(await promptFor(child), /Retry after the timeout/);
      assert.equal(claims.has(retryRequestKey), false);
    });
  });

  test(`${routing} retry whose release fails after dispatch does not hand a later trigger to its requester`, async () => {
    await onIssue(backed, `dispatched-release-fails-${backed}`, async () => {
      const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      state.settleFails = true;
      const { children: [requested] } = await dispatchQueued(0);
      assert.equal(requested.data.userId, 'user-1');
      assert.equal(requested.data.retryCommentId, 6157569382);
      assert.ok(claims.has(retryRequestKey), 'the release failed, leaving the dispatched request held');
      state.settleFails = false;

      // Within the request's lifetime the app's own identity triggers the issue again.
      state.now += 60_000;
      applyLabels(['AI'], APP_ACTOR_ID);
      await assertIndependentRun(backed, 1);
    });
  });

  for (const [who, actorId, delay] of [
    ['another actor', HUMAN_ACTOR_ID, 60_000],
    ['the app within the publication window', APP_ACTOR_ID, 60_000],
    ['the app after the publication window', APP_ACTOR_ID, 11 * 60_000],
  ] as const) {
    test(`${routing} trigger GitHub refused whose release fails is not adopted by a later trigger from ${who}`, async () => {
      await onIssue(backed, `refused-release-fails-${backed}-${actorId}-${delay}`, async () => {
        state.labelAdd = 'rejected';
        // Redis fails from the trigger write on, so neither an outcome nor a release can be written.
        state.onLabelAdd = () => { state.settleFails = true; };
        const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
        assert.equal(result.json.state, 'failed', 'a write GitHub refused is still reported as not started');
        assert.equal(add.mock.callCount(), 0);
        assert.ok(claims.has(retryRequestKey), 'the release failed, leaving the refused request held');
        assert.equal(heldRequests()[0].publication, 'pending', 'no recovery adopts a request whose write was not reported');
        assert.equal(claims.has(dedupKey), false);
        state.labelAdd = 'ok';
        state.settleFails = false;
        state.onLabelAdd = undefined;

        state.now += delay;
        applyLabels(['AI'], actorId);
        await assertIndependentRun(backed, 0);
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`${routing} request made while an earlier trigger write may still land is refused, and the earlier request still runs for its requester`, async () => {
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
      assert.deepEqual(heldRequests().map(held => held.publication), ['possible'], 'the earlier request is kept as it was');

      // The first request's write lands late and its relabel is delivered.
      state.now += 5000;
      landDelayedLabels();
      assert.notEqual((await relabelWebhook()).status, 'ignored');
      const { dispatched, children } = await dispatchQueued(0);
      assert.equal(dispatched.status, 'dispatched');
      const [{ data: child }] = children;
      assert.equal(child.userId, 'user-1', 'the late trigger runs for the earlier requester');
      assert.equal(child.retryCommentId, 6157569382);
      assert.match(await promptFor(child), /Retry after the timeout/);
      assert.equal(claims.has(retryRequestKey), false);
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
      assert.deepEqual(heldRequests().map(held => [held.requestedAt, held.publication]), [[state.now, 'possible']], 'only the second request is held');
    });
  });

  test(`${routing} trigger write whose outcome cannot be reported is not adopted by its late relabel`, async () => {
    await onIssue(backed, `unreported-trigger-${backed}`, async () => {
      state.labelAdd = 'delayed';
      state.onLabelAdd = () => { state.settleFails = true; };
      const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
      assert.equal(result.json.state, 'unknown');
      assert.equal(heldRequests()[0].publication, 'pending');
      state.settleFails = false;

      // Without the reported outcome the late trigger cannot be told from an independent one.
      state.now += 5000;
      landDelayedLabels();
      await assertIndependentRun(backed, 0);
    });
  });
}

test('a queued retry whose trigger a later, independent relabel supersedes runs that trigger without the request, which stays held', async () => {
  await onIssue(true, 'superseded-queued-retry', async () => {
    const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
    assert.equal(result.json.state, 'queued');
    const [, queued] = add.mock.calls[0].arguments as unknown as [string, { retryCommentId?: number }];
    assert.equal(queued.retryCommentId, 6157569382);

    // Before the queued job runs, a person removes and re-applies the trigger.
    state.now += 60_000;
    applyLabels(['AI'], HUMAN_ACTOR_ID);
    const independent = state.timeline.at(-1)!.id;

    const { dispatched, children } = await dispatchQueued(0);
    assert.equal(dispatched.status, 'dispatched');
    const [{ jobId, data: child }] = children;
    assert.equal(jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${independent}`);
    assert.equal(child.userId, 'submitter', 'the independent trigger runs for the submitter');
    assert.equal(child.retryRequesterId, undefined);
    assert.equal(child.retryCommentId, undefined, 'the request\'s instructions are not exempted into it');
    const submission = await database('task_submissions').where({ issue_number: 14 }).first('retry_event_id');
    assert.equal(submission.retry_event_id, String(independent));
    assert.equal(heldRequests().length, 1, 'the request stays held for its own trigger');
  });
});
