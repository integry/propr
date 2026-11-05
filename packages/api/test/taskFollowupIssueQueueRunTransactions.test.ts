/**
 * A requested run's transaction against a real Redis server and a real BullMQ
 * queue (see taskFollowupIssueLiveQueue.ts): replies lost after or before
 * Redis ran it, adds that fail inside it, adds that write a job but never
 * queue it, a partly accepted matrix, foreign payloads, reused request IDs and
 * children that cannot be built.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Queue } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import {
  type RetryRunChild, skip, raw, runRecords, replyLosingQueue, withLiveQueue, enqueueIssueRetryRun, queueRetryRunEvidence,
} from './taskFollowupIssueLiveQueue.js';

/** A requested retry, as a dispatch selects it, numbered `id`. */
function requestOf(id: number) {
  return { id: 990_000 + id, commentId: FIRST_COMMENT_ID + 100 + id, requesterId: 'user-1' };
}
const childIdOf = (held: ReturnType<typeof requestOf>, model: string) => `issue-integry-propr-14-claude-${model}-main-request-${held.id}-${held.commentId}`;
/** A child of the request's run on `model`, as its dispatch builds it. */
function childOf(held: ReturnType<typeof requestOf>, model: string): RetryRunChild {
  return {
    name: 'processGitHubIssue',
    data: { repoOwner: 'integry', repoName: 'propr', number: 14, isChildJob: true, modelName: model, userId: held.requesterId,
      retryRequesterId: held.requesterId, retryCommentId: held.commentId } as IssueJobData,
    opts: { jobId: childIdOf(held, model), removeOnComplete: true, removeOnFail: true },
  };
}

/** The queue seen through a connection that runs `around` each transaction's execution. */
function aroundTransactions(queue: Queue, around: (exec: () => Promise<unknown>) => Promise<unknown>): Queue {
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const hooked = (client: object) => new Proxy(client, { get: (target, prop) => prop !== 'multi' ? bind(target, prop) : () => {
    const transaction = (target as { multi(): { exec(): Promise<unknown> } }).multi();
    const exec = transaction.exec.bind(transaction);
    transaction.exec = () => around(exec);
    return transaction;
  } });
  return new Proxy(queue, { get: (target, prop) => prop === 'client' ? target.client.then(hooked) : bind(target, prop) });
}

test('a requested run whose transaction never reached Redis leaves no child and no record, and its retry adds and records it', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(1);
    await assert.rejects(enqueueIssueRetryRun(replyLosingQueue(live.queue, false), held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /before the transaction was sent/);
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined);
    assert.equal(await runs.read(held), null, 'nothing records a run');
    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() });
    assert.equal((await live.queue.getJob(childIdOf(held, 'a')))?.data.retryCommentId, held.commentId);
    assert.deepEqual(await runs.read(held), { receiptEventId: null });
  });
});

test('a requested run whose add fails inside the transaction is not recorded, and a partly accepted matrix adds only its missing children again', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(2);
    // The second child names a parent that does not exist: its add returns BullMQ's error code, and Redis still runs
    // every other command of the transaction, the first child's add and the record's write among them.
    const orphan = { ...childOf(held, 'b'), opts: { ...childOf(held, 'b').opts, parent: { id: 'missing', queue: live.queue.qualifiedName } } };
    await assert.rejects(enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), orphan], { receiptEventId: 'event-1', use: run => run() }), /accepted 1 of 2 children.*code -5/);
    assert.equal(await runs.read(held), null, 'the run is not recorded while one of its children was not accepted');
    assert.equal(await live.queue.getJob(childIdOf(held, 'b')), undefined);
    // The accepted child runs and is removed before the dispatch's retry.
    await (await live.queue.getJob(childIdOf(held, 'a')))!.remove();

    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), childOf(held, 'b')], { receiptEventId: 'event-1', use: run => run() });
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined, 'the child already accepted is not added again');
    assert.equal((await live.queue.getJob(childIdOf(held, 'b')))?.data.retryCommentId, held.commentId);
    assert.deepEqual(await runs.read(held), { receiptEventId: 'event-1' });
    // A later dispatch of the recorded run adds nothing.
    await (await live.queue.getJob(childIdOf(held, 'b')))!.remove();
    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), childOf(held, 'b')], { receiptEventId: 'event-1', use: run => run() });
    assert.equal(await live.queue.count(), 0);
  });
});

test('a requested child ID another payload takes after the check is not recorded as the request\'s run', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(3);
    const foreign = { ...childOf(held, 'a').data, userId: 'user-9', retryRequesterId: 'user-9', retryCommentId: 1 };
    await live.queue.add('processGitHubIssue', foreign, { jobId: childIdOf(held, 'a'), delay: 60 * 60_000 });
    // The foreign job is added after the request's check read the ID free, so the add reaches BullMQ, which keeps it.
    const unchecked = new Proxy(live.queue, { get: (target, prop) => prop === 'getJob' ? async () => undefined
      : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, prop, target) as unknown) });
    await assert.rejects(enqueueIssueRetryRun(unchecked, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /accepted 0 of 1/);
    assert.equal((await live.queue.getJob(childIdOf(held, 'a')))?.data.retryRequesterId, 'user-9', 'BullMQ kept the foreign payload');
    assert.equal(await runs.read(held), null, 'the request stays owed');
    // The same comment under another requester is not this request either.
    await (await live.queue.getJob(childIdOf(held, 'a')))!.remove();
    await live.queue.add('processGitHubIssue', { ...childOf(held, 'a').data, retryRequesterId: 'user-9' }, { jobId: childIdOf(held, 'a'), delay: 60 * 60_000 });
    await assert.rejects(enqueueIssueRetryRun(unchecked, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /accepted 0 of 1/);
    assert.equal(await runs.read(held), null);
  });
});

test('a record another request left under a reused request ID is not taken for the new request\'s run', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const earlier = requestOf(4);
    await enqueueIssueRetryRun(live.queue, earlier, [childOf(earlier, 'a')], { receiptEventId: null, use: run => run() });
    await (await live.queue.getJob(childIdOf(earlier, 'a')))!.remove();
    // The request records are reset; a new request takes the same ID, with its own comment.
    const reused = { ...earlier, commentId: earlier.commentId + 1, requesterId: 'user-2' };
    assert.equal(await runs.read(reused), null, 'the earlier request\'s record is not the new one\'s');
    await enqueueIssueRetryRun(live.queue, reused, [childOf(reused, 'a')], { receiptEventId: null, use: run => run() });
    assert.equal((await live.queue.getJob(childIdOf(reused, 'a')))?.data.retryRequesterId, 'user-2', 'the new request runs a child of its own');
    assert.deepEqual(await runs.read(reused), { receiptEventId: null });
    assert.equal(await runs.read(earlier), null, 'and the earlier request no longer reads as carried by it');
  });
});

test('a requested run with a child that cannot be built sends nothing to Redis', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(5);
    const oversized = { ...childOf(held, 'b'), opts: { ...childOf(held, 'b').opts, sizeLimit: 1 } };
    await assert.rejects(enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), oversized], { receiptEventId: null, use: run => run() }), /exceeds the limit/);
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined, 'the child built before it is not added');
    assert.equal(await runs.read(held), null);
    assert.deepEqual(await runRecords(), []);
  });
});

test('requested children an add wrote but never queued are not taken for the run: the request stays owed, and its retry replaces and runs them once, even when its reply is lost', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(6);
    const matrix = [childOf(held, 'a'), childOf(held, 'b')];
    const enqueue = (queue: Queue) => enqueueIssueRetryRun(queue, held, matrix, { receiptEventId: null, use: run => run() });
    // Deliberately injected: while the transaction runs, the queue's event stream is a string, so each add's script
    // fails at its first event, after writing its job and before queueing it, as any script error after that write would.
    const events = live.queue.toKey('events');
    const failing = aroundTransactions(live.queue, async exec => {
      const existed = await raw.exists(events) === 1;
      if (existed) await raw.rename(events, `${events}:held`);
      await raw.set(events, 'blocked');
      try {
        return await exec();
      } finally {
        await raw.del(events);
        if (existed) await raw.rename(`${events}:held`, events);
      }
    });
    await assert.rejects(enqueue(failing), /accepted 0 of 2 children.*WRONGTYPE/);
    for (const child of matrix) {
      const job = await live.queue.getJob(child.opts.jobId);
      assert.equal(job?.data.retryCommentId, held.commentId, 'the add wrote the job');
      assert.equal(await job?.getState(), 'unknown', 'but the queue holds it in no state, so it can never run');
    }
    assert.equal(await runs.read(held), null, 'jobs alone are not taken for the run');

    // The retry replaces them and the queue accepts the run, though the reply is lost; a later dispatch adds nothing.
    await assert.rejects(enqueue(replyLosingQueue(live.queue, true)), /after the transaction ran/);
    assert.deepEqual(await runs.read(held), { receiptEventId: null });
    for (const child of matrix) assert.equal(await (await live.queue.getJob(child.opts.jobId))?.getState(), 'waiting');
    assert.equal(await enqueue(live.queue), false);
    live.startWorker();
    await live.childSettled();
    await live.childSettled();
    await live.drained();
    assert.deepEqual(live.runs.map(run => run.jobId).sort(), matrix.map(child => child.opts.jobId).sort(), 'each child ran once');
  });
});
