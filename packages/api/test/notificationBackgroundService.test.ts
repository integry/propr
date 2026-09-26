import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createNotificationSchema } from '../../core/src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addNotificationPreferenceApis } from '../../core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addAdvertisedActions } from '../../core/src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import { up as addSystemFailureState } from '../../core/src/db/migrations/20260829000000_add_notification_system_failure_state.js';
import { up as addPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { startNotificationBackgroundService } from '../services/notificationBackgroundService.js';
import { createProjectionTables } from './notificationProjectionTestHarness.js';

after(async () => closeConnection());

function createDatabase(filename: string, busyTimeoutMs: number): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: { pragma(statement: string): void },
        done: (error: Error | null, connection?: unknown) => void,
      ): void {
        try {
          connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
          connection.pragma('journal_mode = WAL');
          connection.pragma('foreign_keys = ON');
          connection.pragma('recursive_triggers = ON');
          done(null, connection);
        } catch (error) {
          done(error as Error);
        }
      },
    },
  });
}

async function createSchema(database: Knex): Promise<void> {
  await createProjectionTables(database);
  await createNotificationSchema(database);
  await addNotificationPreferenceApis(database);
  await addAdvertisedActions(database);
  await addSystemFailureState(database);
  await addPullRequestState(database);
}

test('task projection contention stays off the API event loop and drains on shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-notification-worker-'));
  // Core's test configuration deliberately normalizes DB_FILENAME to this
  // basename so accidental test runs cannot open a production-style file.
  const filename = path.join(directory, 'propr.test.sqlite');
  const foreground = createDatabase(filename, 30_000);
  const locking = createDatabase(filename, 0);
  let background: Awaited<ReturnType<typeof startNotificationBackgroundService>> | undefined;
  let lockHeld = false;

  try {
    await createSchema(foreground);
    await foreground('instance_members').insert([
      { github_user_id: 'account-a', role: 'admin' },
      { github_user_id: 'account-b', role: 'member' },
    ]);
    await foreground('tasks').insert({
      task_id: 'task-contention-fixture',
      repository: 'example/project',
      issue_number: 2385,
      pr_number: null,
      task_type: 'implementation',
      initial_job_data: JSON.stringify({ title: 'Sanitized performance fixture' }),
    });
    background = await startNotificationBackgroundService(foreground);

    await locking.raw('BEGIN IMMEDIATE');
    lockHeld = true;
    const timestamp = new Date().toISOString();
    let projectionSettled = false;
    const projected = background.projectTaskUpdate({
      eventType: 'task:update',
      taskId: 'task-contention-fixture',
      state: 'failed',
      repository: 'example/project',
      issueNumber: 2385,
      timestamp,
    }).finally(() => { projectionSettled = true; });

    // Every better-sqlite3 statement, including a failed lock acquisition, is
    // synchronous within its owning thread. The worker boundary keeps the
    // projection/retry path from consuming this API event-loop turn.
    await Promise.race([
      new Promise<void>(resolve => setImmediate(resolve)),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('task projection blocked the API event loop')),
        250,
      )),
    ]);
    assert.equal(
      await foreground('tasks').where({ task_id: 'task-contention-fixture' }).first('repository')
        .then(row => row?.repository),
      'example/project',
      'foreground data remains fresh while projection waits to write',
    );
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    assert.equal(
      projectionSettled,
      false,
      'the fixture must exercise projection while the writer lock is held',
    );

    // close() must drain the already accepted task update instead of discarding
    // its notification or terminating the worker underneath it.
    const closed = background.close();
    await locking.raw('ROLLBACK');
    lockHeld = false;
    await Promise.all([projected, closed]);

    const recipients = await foreground('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .where({ 'event.kind': 'task' })
      .orderBy('receipt.user_id')
      .pluck('receipt.user_id');
    assert.deepEqual(recipients, ['account-a', 'account-b']);
  } finally {
    if (lockHeld) await locking.raw('ROLLBACK').catch(() => undefined);
    await background?.close().catch(() => undefined);
    await Promise.allSettled([locking.destroy(), foreground.destroy()]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
