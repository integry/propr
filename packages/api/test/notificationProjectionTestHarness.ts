import knex, { type Knex } from 'knex';
import { NotificationService } from '@propr/core';
import { up as createNotificationSchema } from '../../core/src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addNotificationPreferenceApis } from '../../core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addAdvertisedActions } from '../../core/src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import { up as addSystemFailureState } from '../../core/src/db/migrations/20260829000000_add_notification_system_failure_state.js';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';

export interface NotificationProjectionTestHarness {
  database: Knex;
  projection: NotificationProjectionService;
}

export interface ActiveNotificationReceipt {
  user_id: string;
  occurred_at: string;
}

async function createProjectionTables(database: Knex): Promise<void> {
  await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('repository').notNullable();
    table.integer('issue_number').nullable();
    table.integer('pr_number').nullable();
    table.text('task_type').notNullable();
    table.text('initial_job_data').nullable();
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.text('task_id').notNullable();
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
    table.text('metadata').nullable();
  });
  await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
  });
  await database.schema.createTable('instance_members', table => {
    table.text('github_user_id').primary();
    table.text('role').notNullable();
  });
}

export async function createNotificationProjectionTestHarness(
  now: () => Date,
): Promise<NotificationProjectionTestHarness> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(connection: { pragma(statement: string): void }, done: (error: Error | null, connection: unknown) => void) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
  await createProjectionTables(database);
  await createNotificationSchema(database);
  await addNotificationPreferenceApis(database);
  await addAdvertisedActions(database);
  await addSystemFailureState(database);
  const projection = new NotificationProjectionService({
    database,
    notificationService: new NotificationService({ database, now }),
    now,
    stalledAfterMs: 10_000,
  });
  await database('instance_members').insert([
    { github_user_id: 'admin-user', role: 'admin' },
    { github_user_id: 'member-user', role: 'member' },
  ]);
  return { database, projection };
}

export async function listActiveNotificationReceipts(
  database: Knex,
  kind: string,
): Promise<ActiveNotificationReceipt[]> {
  return database('notification_user_states as receipt')
    .join('notification_events as event', 'event.event_id', 'receipt.event_id')
    .where({ 'event.kind': kind, 'receipt.inbox_enabled': true })
    .whereNull('receipt.dismissed_at')
    .select('receipt.user_id', 'event.occurred_at');
}

export async function countNotificationEvents(database: Knex): Promise<number> {
  return database('notification_events')
    .count('* as count')
    .first()
    .then(row => Number(row?.count ?? 0));
}

export async function countUndismissedNotificationReceipts(
  database: Knex,
  kind: string,
): Promise<number> {
  return database('notification_user_states as receipt')
    .join('notification_events as event', 'event.event_id', 'receipt.event_id')
    .where({ 'event.kind': kind })
    .whereNull('receipt.dismissed_at')
    .count('* as count')
    .first()
    .then(row => Number(row?.count ?? 0));
}
