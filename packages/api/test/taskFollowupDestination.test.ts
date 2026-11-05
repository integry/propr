import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Response } from 'express';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { postFollowup, database } from './taskFollowupFixture.js';
import { postedComments } from './taskFollowupIssueDispatch.js';

const { createTaskHistoryRoutes } = await import('../routes/taskHistoryRoutes.js');
const { followupDestination } = await import('../routes/followupThread.js');

// An older, failed run of issue 16, grouped with the newer run that created PR 7.
await database('tasks').insert({ task_id: 'older-issue-run', repository: 'integry/propr', issue_number: 16, pr_number: null, task_type: 'issue' });
await database('task_history').insert([
  { task_id: 'older-issue-run', state: 'processing' },
  { task_id: 'older-issue-run', state: 'failed', timestamp: '2026-10-15T09:00:00.000Z' },
]);

/** The follow-up target the task page reads for a task, through the history route's live-state path. */
async function advertisedTarget(taskId: string): Promise<unknown> {
  let payload: Record<string, unknown> = {};
  const response = {
    status() { return response; },
    json(value: Record<string, unknown>) { payload = value; return response; },
    type() { return response; },
    send(value: string) { payload = JSON.parse(value); return response; },
  } as unknown as Response;
  const redisClient = {
    get: async (key: string) => key === `worker:state:${taskId}`
      ? JSON.stringify({ history: [{ state: 'COMPLETED' }], issueRef: { repoOwner: 'integry', repoName: 'propr', number: 99 } })
      : null,
  } as unknown as RedisClientType;
  await createTaskHistoryRoutes({ redisClient, taskQueue: {} as Queue, db: database })
    .getTaskHistory({ params: { taskId } } as unknown as FlatRequest, response);
  return (payload.taskInfo as Record<string, unknown> | null)?.followupTarget;
}

/** The thread the follow-up route posted the comment to for a submission of `taskId`. */
async function postedThread(taskId: string): Promise<number> {
  const before = postedComments().length;
  const result = await postFollowup({ body: 'Please also cover the empty state' }, taskId);
  assert.equal(result.status, 202, JSON.stringify(result.json));
  const posted = postedComments().slice(before);
  assert.equal(posted.length, 1);
  return posted[0].arguments[1].issue_number;
}

for (const { taskId, kind, number, why } of [
  { taskId: 'issue-task-with-pr', kind: 'pull_request', number: 7, why: 'an issue implementation that created a PR names that PR, not its issue' },
  { taskId: 'failed-issue-task', kind: 'issue', number: 14, why: 'a failed issue implementation without a PR names its issue' },
  { taskId: 'pr-comment-task', kind: 'pull_request', number: 7, why: 'a PR-comment task names its PR' },
  { taskId: 'older-issue-run', kind: 'issue', number: 16, why: 'an older run names its own thread, not its newer grouped run\'s PR' },
] as const) {
  test(`the advertised follow-up target is where the submission posts: ${why}`, async () => {
    const advertised = await advertisedTarget(taskId);
    assert.deepEqual(advertised, { taskId, repository: 'integry/propr', kind, number });
    assert.equal(await postedThread(taskId), number);
  });
}

test('a task the follow-up route refuses advertises no target', async () => {
  assert.equal(await advertisedTarget('task-without-pr'), undefined);
  assert.equal((await postFollowup({ body: 'Retry' }, 'task-without-pr')).status, 400);
  assert.equal(await advertisedTarget('unknown-task'), undefined);
});

test('a destination needs a complete repository and a positive thread number', () => {
  const task = { task_id: 't', repository: 'integry/propr', issue_number: 3, pr_number: null, task_type: 'issue' };
  assert.equal(followupDestination({ ...task, repository: 'integry' }), null);
  assert.equal(followupDestination({ ...task, issue_number: 0 }), null);
  assert.equal(followupDestination({ ...task, task_type: 'review', task_id: 'review-1', issue_number: null as unknown as number }), null);
});
