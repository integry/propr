import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createLiveActivityRoutes, database, invoke } from './helpers/liveActivityRoutesTestHelpers.js';

test('omits a persisted task whose queued job completes during the database scan', async () => {
  const db = await database();
  const taskId = 'persisted-late-success';
  const jobId = 'persisted-late-success-job';
  await db('tasks').insert({
    task_id: taskId,
    job_id: jobId,
    repository: 'integry/propr',
    created_at: '2026-08-14T12:00:00.000Z',
    initial_job_data: JSON.stringify({ type: 'issue', title: 'Persisted late success' }),
  });
  await db('task_history').insert({ task_id: taskId, state: 'processing' });

  const activeJob = {
    id: jobId,
    name: 'processGitHubIssue',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: { isChildJob: true, taskId },
    getState: async () => 'active',
  };
  const completedJob = {
    ...activeJob,
    getState: async () => 'completed',
  };
  let refreshCount = 0;
  const inspectContainer = mock.fn(async () => 'not_found' as const);
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJobs: async () => [activeJob],
      getJob: async () => {
        refreshCount += 1;
        return refreshCount === 1 ? activeJob : completedJob;
      },
    } as never,
    inspectContainer,
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 0);
  assert.deepEqual(result.body.items, []);
  assert.equal(inspectContainer.mock.callCount(), 1);
  assert.deepEqual(inspectContainer.mock.calls[0].arguments, [taskId]);
});
