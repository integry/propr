import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state, claims, add, postFollowup, database, applyLabels, landDelayedLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { retryRequestKey, routes, relabelWebhook, dispatchQueued, promptFor } from './taskFollowupIssueDispatch.js';

const { insertTaskSubmission } = await import('../../core/src/services/taskSubmissionService.js');

// A held retry request belongs only to the trigger it published: a later,
// independent trigger must not adopt it when releasing it failed, and a
// trigger write that may still land keeps it for that write.

const dedupKey = 'issue:dedup:integry:propr:14';
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

  for (const [who, actorId, delay] of [['another actor', HUMAN_ACTOR_ID, 60_000], ['the app after the publication window', APP_ACTOR_ID, 11 * 60_000]] as const) {
    test(`${routing} trigger GitHub refused whose release fails is not adopted by a later trigger from ${who}`, async () => {
      await onIssue(backed, `refused-release-fails-${backed}-${actorId}`, async () => {
        state.labelAdd = 'rejected';
        state.settleFails = true;
        const result = await postFollowup({ body: 'Retry' }, 'failed-issue-task');
        assert.equal(result.json.state, 'failed', 'a write GitHub refused is still reported as not started');
        assert.equal(add.mock.callCount(), 0);
        assert.ok(claims.has(retryRequestKey), 'the release failed, leaving the refused request held');
        assert.equal(claims.has(dedupKey), false);
        state.labelAdd = 'ok';
        state.settleFails = false;

        state.now += delay;
        applyLabels(['AI'], actorId);
        await assertIndependentRun(backed, 0);
      });
    });
  }
}
