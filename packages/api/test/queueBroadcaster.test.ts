import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_STATS_UPDATE } from '@propr/shared';
import { QueueBroadcaster } from '../services/queueBroadcaster.js';

test('queue broadcasts active goal jobs separately from the aggregate active count', async () => {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
    }),
  };
  const queue = {
    getWaitingCount: async () => 2,
    getJobs: async (states: string[]) => {
      assert.deepEqual(states, ['active']);
      return [
        { name: 'processGitHubIssue' },
        { name: 'processGoal' },
        { name: 'processGoal' },
      ];
    },
    getCompletedCount: async () => 5,
    getFailedCount: async () => 1,
    getDelayedCount: async () => 3,
  };

  await new QueueBroadcaster(io as never, queue as never).broadcastQueueStats();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, 'queue:stats');
  assert.equal(emitted[0].event, QUEUE_STATS_UPDATE);
  assert.deepEqual((emitted[0].payload as { stats: unknown }).stats, {
    waiting: 2,
    active: 3,
    activeGoals: 2,
    completed: 5,
    failed: 1,
    delayed: 3,
    total: 14,
  });
});

test('queue periodic snapshots emit only when the aggregate changes', async () => {
  const emitted: unknown[] = [];
  const io = {
    to: () => ({ emit: (_event: string, payload: unknown) => emitted.push(payload) }),
  };
  let active = 1;
  const queue = {
    getWaitingCount: async () => 0,
    getJobs: async () => Array.from({ length: active }, () => ({ name: 'processGitHubIssue' })),
    getCompletedCount: async () => 2,
    getFailedCount: async () => 0,
    getDelayedCount: async () => 0,
  };
  const broadcaster = new QueueBroadcaster(io as never, queue as never);

  await broadcaster.broadcastQueueStats();
  await broadcaster.broadcastQueueStats();
  assert.equal(emitted.length, 1, 'an unchanged fallback snapshot must not create client churn');

  active = 0;
  await broadcaster.broadcastQueueStats();
  assert.equal(emitted.length, 2, 'a real queue transition must remain fresh');

  await broadcaster.broadcastQueueStats(true);
  assert.equal(emitted.length, 3, 'a new subscriber can request an immediate snapshot');
});
