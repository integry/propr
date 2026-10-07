import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, closeEventPublisher } from '@propr/core';
import { TASK_UPDATE } from '@propr/shared';
import { up as addReplacementLineage } from '../../core/src/db/migrations/20261006000000_add_task_replacement_lineage.js';
import type { NotificationProjectionService } from '../services/notificationProjectionService.js';
import { createNotificationProjectionTestHarness } from './notificationProjectionTestHarness.js';

let database: Knex;
let projection: NotificationProjectionService;
let clock: number;
const iso = (): string => new Date(clock).toISOString();

beforeEach(async () => {
  clock = Date.now() - 60_000;
  ({ database, projection } = await createNotificationProjectionTestHarness(() => new Date(clock)));
  await addReplacementLineage(database);
  await database('tasks').insert([
    { task_id: 'attempt-1', repository: 'integry/propr', issue_number: 2739, task_type: 'issue', initial_job_data: '{}' },
    {
      task_id: 'attempt-2', repository: 'integry/propr', issue_number: 2739, task_type: 'issue', initial_job_data: '{}',
      replaces_task_id: 'attempt-1', attempt_number: 2, lineage_root_task_id: 'attempt-1', replacement_cause: 'infra_lost',
    },
  ]);
});

afterEach(async () => {
  projection.close();
  await database.destroy();
});

after(async () => {
  await closeConnection();
  await closeEventPublisher();
});

async function activeTaskCards(): Promise<Array<{ title: string; severity: string; taskId: string }>> {
  const rows = await database('notification_user_states as receipt')
    .join('notification_events as event', 'event.event_id', 'receipt.event_id')
    .where({ 'event.kind': 'task' })
    .whereNull('receipt.dismissed_at')
    .distinct('event.title', 'event.severity', 'event.target_json') as Array<{ title: string; severity: string; target_json: string }>;
  return rows.map(row => ({ title: row.title, severity: row.severity, taskId: JSON.parse(row.target_json).taskId }));
}

const update = (taskId: string, state: string) => projection.projectTaskUpdate({
  eventType: TASK_UPDATE, taskId, state, repository: 'integry/propr', issueNumber: 2739, timestamp: iso(),
});

test('a failure superseded by a replacement shows one "replacement started" card instead of two alerts', async () => {
  await database('tasks').where({ task_id: 'attempt-1' }).update({ replacement_state: 'pending', replaced_by_task_id: null });
  await update('attempt-1', 'failed');
  assert.deepEqual(await activeTaskCards(), [], 'the failure alert is held back while a replacement is expected');

  clock += 1_000;
  await update('attempt-2', 'pending');
  await update('attempt-2', 'pending');
  assert.deepEqual(await activeTaskCards(), [{ title: 'Replacement started for issue #2739', severity: 'info', taskId: 'attempt-2' }]);
});

test('a failure card shown before the replacement started is replaced by it', async () => {
  await update('attempt-1', 'failed');
  assert.equal((await activeTaskCards())[0]?.severity, 'error');

  clock += 1_000;
  await update('attempt-2', 'pending');
  assert.deepEqual(await activeTaskCards(), [{ title: 'Replacement started for issue #2739', severity: 'info', taskId: 'attempt-2' }]);
});

test('a skipped replacement publishes the held-back failure normally', async () => {
  await database('tasks').where({ task_id: 'attempt-1' }).update({ replacement_state: 'skipped' });
  await update('attempt-1', 'failed');
  assert.deepEqual(await activeTaskCards(), [{ title: 'Task failed for issue #2739', severity: 'error', taskId: 'attempt-1' }]);
});

test('a replacement announced by recovery after it started running still replaces the held-back failure', async () => {
  await database('tasks').where({ task_id: 'attempt-1' }).update({ replacement_state: 'pending' });
  await update('attempt-1', 'failed');
  clock += 1_000;
  await update('attempt-2', 'claude_execution');
  assert.deepEqual(await activeTaskCards(), [], 'an ordinary progress update announces nothing');

  clock += 1_000;
  await projection.projectTaskUpdate({
    eventType: TASK_UPDATE, taskId: 'attempt-2', state: 'claude_execution', repository: 'integry/propr', issueNumber: 2739, timestamp: iso(),
    metadata: { replacesTaskId: 'attempt-1', attemptNumber: 2, replacementCause: 'infra_lost', replacementStarted: true },
  });
  assert.deepEqual(await activeTaskCards(), [{ title: 'Replacement started for issue #2739', severity: 'info', taskId: 'attempt-2' }]);
});
