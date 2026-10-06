import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, closeEventPublisher } from '@propr/core';
import { TASK_UPDATE } from '@propr/shared';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';
import { createNotificationProjectionTestHarness } from './notificationProjectionTestHarness.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;

const iso = (offsetMs = 0): string => new Date(clock + offsetMs).toISOString();

beforeEach(async () => {
  clock = Date.now() - 60_000;
  ({ database, projection } = await createNotificationProjectionTestHarness(() => new Date(clock)));
  await database('task_schedules').insert({ id: 'schedule-1', name: 'Nightly dependency patrol' });
});

afterEach(async () => {
  projection.close();
  await database.destroy();
});

after(async () => {
  await closeConnection();
  await closeEventPublisher();
});

async function projectedEvents(): Promise<Array<{ kind: string; title: string; metadata: Record<string, unknown> | null }>> {
  const rows = await database('notification_events').orderBy('occurred_at').select('kind', 'title', 'metadata_json');
  return rows.map(row => ({
    kind: row.kind,
    title: row.title,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  }));
}

describe('scheduled task notifications', { concurrency: false }, () => {
  test('lead with "Scheduled: <name>" and carry the schedule in metadata', async () => {
    await database('tasks').insert([
      {
        task_id: 'scheduled-issue', repository: 'integry/propr', issue_number: 91, pr_number: null,
        task_type: 'issue', schedule_id: 'schedule-1',
        initial_job_data: JSON.stringify({ title: 'Bump vulnerable dependencies' }),
      },
      {
        task_id: 'scheduled-pr', repository: 'integry/propr', issue_number: 92, pr_number: 93,
        task_type: 'issue', schedule_id: 'schedule-1',
        initial_job_data: JSON.stringify({ title: 'Refresh lockfile' }),
      },
      {
        task_id: 'manual-issue', repository: 'integry/propr', issue_number: 94, pr_number: null,
        task_type: 'issue', initial_job_data: JSON.stringify({ title: 'Manual work' }),
      },
    ]);

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'scheduled-issue', state: 'failed',
      repository: 'integry/propr', issueNumber: 91, timestamp: iso(),
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'scheduled-pr', state: 'completed',
      repository: 'integry/propr', timestamp: iso(),
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'manual-issue', state: 'completed',
      repository: 'integry/propr', issueNumber: 94, timestamp: iso(),
    });

    const events = await projectedEvents();
    assert.deepEqual(events.map(({ kind, title }) => ({ kind, title })), [
      { kind: 'task', title: 'Scheduled: Nightly dependency patrol · Bump vulnerable dependencies' },
      { kind: 'pull_request', title: 'Scheduled: Nightly dependency patrol · Refresh lockfile' },
      { kind: 'task', title: 'Manual work' },
    ]);
    assert.deepEqual(events[0].metadata, { scheduleId: 'schedule-1', scheduleName: 'Nightly dependency patrol' });
    assert.equal(events[1].metadata?.scheduleId, 'schedule-1');
    assert.equal(events[1].metadata?.scheduleName, 'Nightly dependency patrol');
    assert.equal(events[1].metadata?.completedImplementationTaskId, 'scheduled-pr');
    assert.equal(events[2].metadata?.scheduleId, undefined);
  });

  test('still say "Scheduled" once the schedule is deleted', async () => {
    await database('tasks').insert({
      task_id: 'orphaned', repository: 'integry/propr', issue_number: 95, pr_number: null,
      task_type: 'issue', schedule_id: 'deleted-schedule',
      initial_job_data: JSON.stringify({ title: 'Weekly cleanup' }),
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'orphaned', state: 'completed',
      repository: 'integry/propr', issueNumber: 95, timestamp: iso(),
    });

    const [event] = await projectedEvents();
    assert.equal(event.title, 'Scheduled · Weekly cleanup');
    assert.deepEqual(event.metadata, { scheduleId: 'deleted-schedule' });
  });
});
