import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createLiveActivityRoutes, database, invoke } from './helpers/liveActivityRoutesTestHelpers.js';

test('legacy issue job shares one activity item with its persisted task and exact container', async () => {
  const db = await database();
  const taskId = 'integry-propr-1899-codex-gpt-5-legacy-correlation';
  await db('tasks').insert({
    task_id: taskId,
    job_id: null,
    repository: 'integry/propr',
    created_at: '2026-08-14T11:00:00.000Z',
    initial_job_data: JSON.stringify({ type: 'issue', title: 'Legacy issue execution' }),
  });
  await db('task_history').insert({ task_id: taskId, state: 'processing' });
  const job = {
    id: 'legacy-issue-job',
    name: 'processGitHubIssue',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: {
      isChildJob: true,
      repoOwner: 'integry',
      repoName: 'propr',
      number: 1899,
      agentAlias: 'codex',
      modelName: 'gpt-5',
      correlationId: 'legacy-correlation',
    },
    getState: async () => 'active',
  };
  const inspectContainer = mock.fn(async (task: string) => task === taskId ? 'running' as const : 'not_found' as const);
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJob: async jobId => jobId === job.id ? job : null,
      getJobs: async () => [job],
    } as never,
    inspectContainer,
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.items.map(item => item.id), [taskId]);
  assert.equal(inspectContainer.mock.callCount(), 1);
});
