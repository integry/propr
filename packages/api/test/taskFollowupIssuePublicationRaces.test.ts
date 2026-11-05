import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, postFollowup, database, applyLabels, landDelayedLabels, APP_ACTOR_ID, HUMAN_ACTOR_ID, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, routes, dispatchQueued, promptFor, onIssue, deliverAndDispatch, relabelWebhook, pollDelivery, dedupKey, requestChildId } from './taskFollowupIssueDispatch.js';

// A request's publication touches the issue only while the issue is still
// its own: one whose reservation or window lapsed leaves a later request's
// trigger and claim alone. Its trigger is the first its identity labels from
// the second its write began, not one labelled while its comment posted, and
// a label add GitHub answers without an event of its own is no publication.

const routings = [['a submission-backed', true], ['an issue-only', false]] as const;
const submissionRow = async () => database('task_submissions').where({ issue_number: 14 }).first('retry_event_id') as Promise<{ retry_event_id: string | null } | undefined>;
const ELEVEN_MINUTES = 11 * 60_000;
const LABEL_ADD = 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels';
const LABEL_REMOVE = 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}';
const count = (route: string) => routes().filter(called => called === route).length;
const duplicate = { status: 'ignored', reason: 'duplicate_delivery' };

/** The dispatched run carries `requester`'s request on trigger `own`, with its instructions and none of `foreign`. */
async function assertRunFor(backed: boolean, { dispatched, children }: Awaited<ReturnType<typeof dispatchQueued>>,
  { own, requester, commentId, instructions, foreign }: { own: number; requester: string; commentId: number; instructions: RegExp; foreign?: RegExp }) {
  assert.equal(dispatched.status, 'dispatched');
  const [{ jobId, data: child }] = children as Array<{ jobId: string; data: IssueJobData }>;
  assert.equal(jobId, await requestChildId(commentId));
  if (backed) assert.equal(child.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
  assert.equal(child.userId, requester);
  assert.equal(child.retryRequesterId, requester);
  assert.equal(child.retryCommentId, commentId);
  const prompt = await promptFor(child);
  assert.match(prompt, instructions);
  if (foreign) assert.doesNotMatch(prompt, foreign);
  if (backed) assert.equal((await submissionRow())?.retry_event_id, String(own));
  assert.deepEqual(await openRequests(), [], 'the request is released once its run carries it');
}

test('a request owns the first trigger its identity labels from the second its write began, not one labelled earlier', async () => {
  const { retryRequestTrigger } = await import('../../core/src/services/issueRetryRequest.js');
  const labelled = (id: number, time: string, actor = APP_ACTOR_ID) => ({ id, event: 'labeled', created_at: `2026-10-15T${time}Z`, label: { name: 'AI' }, actor: { id: actor } });
  const request = { id: 1, requesterId: 'user-1', commentId: FIRST_COMMENT_ID, requestedAt: Date.parse('2026-10-15T10:00:00.000Z'),
    publishedAt: Date.parse('2026-10-15T10:00:05.700Z'), afterEventId: '1', actorId: APP_ACTOR_ID, publication: 'possible' as const, resumedAt: null };
  const baseline = labelled(1, '09:59:00', HUMAN_ACTOR_ID);
  const events = [baseline, labelled(2, '10:00:04'), labelled(3, '10:00:05', HUMAN_ACTOR_ID), labelled(4, '10:00:05'), labelled(5, '10:00:06')];
  assert.equal(retryRequestTrigger(request, events), '4', 'GitHub stamps its write to the second it began in');
  assert.equal(retryRequestTrigger(request, events.slice(0, 3)), null, 'an app trigger stamped before that second is another\'s');
  assert.equal(retryRequestTrigger(request, [baseline, labelled(2, '10:00:04'), labelled(6, '10:10:06')]), null, 'and so is one after its window');
});

for (const [routing, backed] of routings) {
  test(`${routing} request whose reservation expired while its comment posted leaves the later request's trigger and claim alone`, async () => {
    await onIssue(backed, `expired-reservation-${backed}`, async () => {
      let successor: Awaited<ReturnType<typeof postFollowup>> | undefined;
      let successorClaim: string | undefined;
      let successorTrigger = 0;
      state.onCommentPost = async () => {
        state.onCommentPost = undefined;
        // The first request's comment POST outlasts its reservation and its claim; a later request takes the issue,
        // publishes its trigger and records it, but its job is not queued.
        state.now += ELEVEN_MINUTES;
        claims.delete(dedupKey);
        state.queueFails = true;
        successor = await postFollowup({ body: 'Successor instructions' }, 'failed-issue-task', 'user-2');
        state.queueFails = false;
        successorClaim = claims.get(dedupKey);
        successorTrigger = state.timeline.at(-1)!.id;
      };
      const expired = await postFollowup({ body: 'Expired instructions' }, 'failed-issue-task');
      assert.equal(successor?.json.state, 'unknown', 'the later request\'s trigger is applied but its job is not queued');
      assert.equal(expired.status, 202);
      assert.equal(expired.json.success, false);
      assert.equal(expired.json.state, 'failed', 'the expired request is not started');
      assert.notEqual(expired.json.commentId, successor?.json.commentId);

      assert.ok(state.issueLabels.includes('AI'), 'the later request\'s trigger is not removed');
      assert.equal(count(LABEL_REMOVE), 1, 'only the later request\'s own write removed the label');
      assert.equal(count(LABEL_ADD), 1);
      assert.equal(state.timeline.at(-1)!.id, successorTrigger);
      assert.ok(successorClaim);
      assert.equal(claims.get(dedupKey), successorClaim, 'the later request\'s claim is kept');
      assert.deepEqual((await openRequests()).map(held => [held.comment_id, held.requester_id, held.publication]),
        [[successor?.json.commentId, 'user-2', 'possible']]);

      // The later request's own relabel is still suppressed by its claim; once that expires, polling runs it.
      assert.deepEqual(await relabelWebhook(), duplicate);
      await assertRunFor(backed, await deliverAndDispatch(pollDelivery), {
        own: successorTrigger, requester: 'user-2', commentId: Number(successor?.json.commentId), instructions: /Successor instructions/, foreign: /Expired instructions/,
      });
    });
  });

  test(`${routing} request whose trigger write outlasts its publication window stops once a later request took the issue over`, async () => {
    await onIssue(backed, `superseded-write-${backed}`, async () => {
      let successor: Awaited<ReturnType<typeof postFollowup>> | undefined;
      let successorClaim: string | undefined;
      let successorTrigger = 0;
      state.onLabelAdd = async () => {
        state.onLabelAdd = undefined;
        // GitHub holds the first request's add past its window; a later request takes the issue and is queued.
        state.now += ELEVEN_MINUTES;
        claims.delete(dedupKey);
        successor = await postFollowup({ body: 'Successor instructions' }, 'failed-issue-task', 'user-2');
        successorClaim = claims.get(dedupKey);
        successorTrigger = state.timeline.at(-1)!.id;
      };
      const late = await postFollowup({ body: 'Late instructions' }, 'failed-issue-task');
      assert.equal(successor?.json.state, 'queued');
      assert.equal(late.json.success, false, 'no queued receipt for a write the later request superseded');
      assert.equal(late.json.state, 'unknown');
      assert.match(String(late.json.message), /later retry .* took the issue over/);
      assert.equal(add.mock.callCount(), 1, 'only the later request\'s job is queued');
      assert.equal(count(LABEL_REMOVE), 2, 'each request removed the label once, before its own add');
      assert.ok(state.issueLabels.includes('AI'));
      assert.equal(state.timeline.at(-1)!.id, successorTrigger, 'the late add, a no-op, is not written again');
      assert.equal(claims.get(dedupKey), successorClaim);

      await assertRunFor(backed, await dispatchQueued(0), {
        own: successorTrigger, requester: 'user-2', commentId: Number(successor?.json.commentId), instructions: /Successor instructions/, foreign: /Late instructions/,
      });
    });
  });

  test(`${routing} request whose comment posts while an independent app trigger runs keeps its requester and instructions on its own later trigger`, async () => {
    await onIssue(backed, `independent-app-trigger-${backed}`, async () => {
      let independent = 0;
      state.onCommentPost = async () => {
        state.onCommentPost = undefined;
        // Past the shared window, another flow with the app's identity relabels the issue, and recovery
        // dispatches it while the request is still reserved; that run fails before the comment is posted.
        state.now += 31_000;
        applyLabels(['AI'], APP_ACTOR_ID);
        independent = state.timeline.at(-1)!.id;
        const { dispatched, children: [{ data: child }] } = await deliverAndDispatch();
        assert.equal(dispatched.status, 'dispatched');
        assert.equal(child.retryCommentId, undefined, 'the independent trigger runs without the request');
        if (backed) assert.equal((await submissionRow())?.retry_event_id, String(independent));
        state.now += 5000;
      };
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      const own = state.timeline.at(-1)!.id;
      assert.ok(own > independent);
      await assertRunFor(backed, await dispatchQueued(add.mock.callCount() - 1), {
        own, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /Retry with my instructions/,
      });
    });
  });

  test(`${routing} request whose comment completes in the second of an independent app trigger already dispatched keeps its requester and instructions`, async () => {
    await onIssue(backed, `same-second-app-trigger-${backed}`, async () => {
      let independent: (typeof state.timeline)[number] | undefined;
      state.onCommentPost = async () => {
        state.onCommentPost = undefined;
        // Past the shared window, another flow with the app's identity relabels the issue, and recovery
        // dispatches it while the request is still reserved; the comment completes within that same second.
        state.now += 31_000;
        applyLabels(['AI'], APP_ACTOR_ID);
        independent = state.timeline.at(-1)!;
        const { dispatched, children: [{ data: child }] } = await deliverAndDispatch();
        assert.equal(dispatched.status, 'dispatched');
        assert.equal(child.retryCommentId, undefined, 'the independent trigger runs without the request');
        if (backed) assert.equal((await submissionRow())?.retry_event_id, String(independent.id), 'the independent trigger is consumed');
        state.now += 200;
      };
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      const own = state.timeline.at(-1)!;
      assert.ok(independent && own.id > independent.id);
      assert.equal(own.created_at, independent.created_at, 'GitHub stamps both triggers in the same second');
      const [held] = await openRequests();
      assert.equal(Math.floor(Number(held.published_at) / 1000) * 1000, Date.parse(independent.created_at), 'the write began in that second');
      await assertRunFor(backed, await dispatchQueued(add.mock.callCount() - 1), {
        own: own.id, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /Retry with my instructions/,
      });
    });
  });

  test(`${routing} request whose trigger history cannot be read once its comment posted is not published`, async () => {
    await onIssue(backed, `unreadable-history-after-comment-${backed}`, async () => {
      state.onCommentPost = () => { state.onCommentPost = undefined; state.timelineReadFails = true; };
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      state.timelineReadFails = false;
      assert.equal(result.status, 202);
      assert.equal(result.json.success, false);
      assert.equal(result.json.state, 'failed');
      assert.equal(result.json.commentId, FIRST_COMMENT_ID);
      assert.match(String(result.json.message), /label history could not be read/);
      assert.equal(count(LABEL_REMOVE) + count(LABEL_ADD), 0, 'nothing on the issue is changed');
      assert.equal(add.mock.callCount(), 0);
      assert.deepEqual(await openRequests(), [], 'the reservation is released');
      assert.equal(claims.has(dedupKey), false, 'and so is the claim');
    });
  });

  test(`${routing} timed-out trigger write is not confirmed by an app trigger labelled while its comment posted`, async () => {
    await onIssue(backed, `independent-app-trigger-readback-${backed}`, async () => {
      state.onCommentPost = () => {
        state.onCommentPost = undefined;
        state.now += 31_000;
        applyLabels(['AI'], APP_ACTOR_ID);
        state.now += 5000;
      };
      state.labelAdd = 'delayed';
      const result = await postFollowup({ body: 'Retry after the timeout' }, 'failed-issue-task');
      state.labelAdd = 'ok';
      assert.equal(result.json.state, 'unknown', 'the earlier app trigger is not the request\'s write');
      assert.equal(add.mock.callCount(), 0);

      state.now += 5000;
      landDelayedLabels();
      await assertRunFor(backed, await deliverAndDispatch(), {
        own: state.timeline.at(-1)!.id, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /Retry after the timeout/,
      });
    });
  });

  test(`${routing} trigger a person applies while the comment posts is removed and written again, so the request runs on its own event`, async () => {
    await onIssue(backed, `person-label-during-comment-${backed}`, async () => {
      // The issue lacks its trigger when the route reads it.
      state.issueLabels = state.issueLabels.filter(name => name !== 'AI');
      let suppressed: unknown;
      state.onCommentPost = async () => {
        state.onCommentPost = undefined;
        applyLabels(['AI'], HUMAN_ACTOR_ID);
        suppressed = await relabelWebhook();
      };
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      assert.deepEqual(suppressed, duplicate, 'the person\'s delivery falls within the route\'s claim');
      assert.equal(result.json.state, 'queued');
      assert.equal(count(LABEL_REMOVE), 1, 'the trigger is removed as the issue has it when the write begins');
      const own = state.timeline.at(-1)!;
      assert.equal(own.actor.id, APP_ACTOR_ID, 'the add published an event of the request\'s own');
      await assertRunFor(backed, await dispatchQueued(0), {
        own: own.id, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /Retry with my instructions/,
      });
    });
  });

  test(`${routing} add a person's label made a no-op between the removal and the add is written again`, async () => {
    await onIssue(backed, `person-label-before-add-${backed}`, async () => {
      let raced = false;
      state.onLabelAdd = () => {
        if (!raced) applyLabels(['AI'], HUMAN_ACTOR_ID);
        raced = true;
      };
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      assert.equal(count(LABEL_ADD), 2, 'the add GitHub answered without an event is written again');
      const own = state.timeline.at(-1)!;
      assert.equal(own.actor.id, APP_ACTOR_ID);
      await assertRunFor(backed, await dispatchQueued(0), {
        own: own.id, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /Retry with my instructions/,
      });
    });
  });

  test(`${routing} add that stays a no-op is not reported queued, and once its window passes the issue is free for a new request`, async () => {
    await onIssue(backed, `person-label-every-add-${backed}`, async () => {
      state.onLabelAdd = () => applyLabels(['AI'], HUMAN_ACTOR_ID);
      const result = await postFollowup({ body: 'Retry with my instructions' }, 'failed-issue-task');
      state.onLabelAdd = undefined;
      assert.equal(result.json.success, false);
      assert.equal(result.json.state, 'unknown');
      assert.match(String(result.json.message), /may still start/);
      assert.equal(count(LABEL_ADD), 2);
      assert.equal(add.mock.callCount(), 0, 'no job is queued for a publication without an event of its own');
      assert.deepEqual((await openRequests()).map(held => held.publication), ['possible']);

      // The person's trigger runs without the request once the request's write can no longer land.
      state.now += ELEVEN_MINUTES;
      const { dispatched, children: [{ data: child }] } = await deliverAndDispatch();
      assert.equal(dispatched.status, 'dispatched');
      assert.equal(child.retryCommentId, undefined);

      state.now += 60_000;
      claims.delete(dedupKey);
      const next = await postFollowup({ body: 'Another retry' }, 'failed-issue-task');
      assert.equal(next.json.state, 'queued');
      assert.equal(next.json.commentId, FIRST_COMMENT_ID + 1);
    });
  });

  test(`${routing} request whose first removal is answered after a later request took the issue over and abandoned it adds no trigger and reports that none was added`, async () => {
    await onIssue(backed, `lapsed-superseded-first-add-${backed}`, async () => {
      const timeline = state.timeline.length;
      let successor: Awaited<ReturnType<typeof postFollowup>> | undefined;
      state.onLabelRemove = async () => {
        state.onLabelRemove = undefined;
        // GitHub removed the first request's trigger, but its answer arrives only after the request's window and
        // claim passed, and a later request reserved the issue, releasing it, then abandoned the issue when GitHub
        // rejected its comment.
        state.now += ELEVEN_MINUTES;
        claims.delete(dedupKey);
        state.commentPostError = Object.assign(new Error('GitHub rejected comment creation'), { status: 422 });
        successor = await postFollowup({ body: 'Successor instructions' }, 'failed-issue-task', 'user-2');
        state.commentPostError = undefined;
        assert.equal(await database('issue_retry_request_states').where({ issue_number: 14 }).whereNotNull('owed_issue').count({ count: '*' })
          .first().then(row => Number(row?.count)), 0, 'the later request released the first one and then its own reservation');
      };
      const lapsed = await postFollowup({ body: 'Lapsed instructions' }, 'failed-issue-task');
      assert.notEqual(successor?.json.state, 'queued', 'the later request posted nothing and queued nothing');

      assert.equal(lapsed.status, 202);
      assert.equal(lapsed.json.success, false);
      assert.equal(lapsed.json.state, 'failed', 'no trigger of the request exists');
      assert.match(String(lapsed.json.message), /publication lapsed before the 'AI' label was added, .* so no label was added/);
      assert.equal(count(LABEL_REMOVE), 1);
      assert.equal(count(LABEL_ADD), 0, 'no add is attempted once the request no longer holds the issue');
      assert.equal(state.timeline.length, timeline, 'no trigger event is published');
      assert.ok(!state.issueLabels.includes('AI'), 'no trigger is left on the issue for polling to find');
      assert.equal(add.mock.callCount(), 0, 'no job is queued');
      assert.deepEqual(await openRequests(), [], 'neither request is held');
      assert.equal(claims.get(dedupKey), undefined, 'no claim is left behind');

      // The issue is free for a new request, which runs on its own trigger for its own requester.
      state.now += 60_000;
      const next = await postFollowup({ body: 'Next instructions' }, 'failed-issue-task', 'user-3');
      assert.equal(next.json.state, 'queued');
      await assertRunFor(backed, await dispatchQueued(0), {
        own: state.timeline.at(-1)!.id, requester: 'user-3', commentId: Number(next.json.commentId), instructions: /Next instructions/, foreign: /Lapsed instructions/,
      });
    });
  });

  test(`${routing} request whose first removal is answered after its publication window closed adds no trigger, and is released`, async () => {
    await onIssue(backed, `lapsed-window-first-add-${backed}`, async () => {
      const timeline = state.timeline.length;
      state.onLabelRemove = () => { state.onLabelRemove = undefined; state.now += ELEVEN_MINUTES; };
      const lapsed = await postFollowup({ body: 'Lapsed instructions' }, 'failed-issue-task');
      assert.equal(lapsed.json.state, 'failed');
      assert.match(String(lapsed.json.message), /so no label was added/);
      assert.equal(count(LABEL_ADD), 0, 'a trigger added now could not be told apart as the request\'s own');
      assert.equal(state.timeline.length, timeline);
      assert.equal(add.mock.callCount(), 0);
      assert.deepEqual(await openRequests(), [], 'the request, which published nothing, is released');
      assert.equal(state.outcomeRetries.length, 0, 'its outcome is recorded');
    });
  });

  test(`${routing} request whose first removal is answered within its window still adds its trigger and runs`, async () => {
    await onIssue(backed, `prompt-first-add-${backed}`, async () => {
      state.onLabelRemove = () => { state.onLabelRemove = undefined; state.now += 9 * 60_000; };
      const result = await postFollowup({ body: 'Slow instructions' }, 'failed-issue-task');
      assert.equal(result.json.state, 'queued');
      assert.equal(count(LABEL_ADD), 1);
      await assertRunFor(backed, await dispatchQueued(0), {
        own: state.timeline.at(-1)!.id, requester: 'user-1', commentId: Number(result.json.commentId), instructions: /Slow instructions/,
      });
    });
  });
}
