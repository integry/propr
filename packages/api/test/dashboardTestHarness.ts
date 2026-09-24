import type { Request, Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';

export const NOW = new Date('2026-09-23T12:00:00.000Z');
export const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
export const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();

/** An in-memory database shaped like the tables the dashboard and stats routes read. */
export async function createDashboardTestDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository').notNullable();
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('task_type');
    table.string('model_name');
    table.timestamp('created_at');
    table.text('initial_job_data');
    table.text('final_result');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp').notNullable();
    table.text('reason');
    table.text('metadata');
  });
  await database.schema.createTable('plan_issues', table => {
    table.increments('id').primary();
    table.string('draft_id');
    table.string('repository').notNullable();
    table.integer('issue_number').notNullable();
    table.integer('pr_number');
    table.string('status').notNullable();
    table.string('task_id');
    table.timestamp('created_at');
    table.timestamp('updated_at');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id');
    table.timestamp('start_time');
    table.decimal('cost_usd', 10, 6);
    table.text('analysis_report');
  });
  // Inbox state, shaped like the real notification schema. The dashboard must
  // never read either table: attention is derived from work state alone.
  await database.schema.createTable('notification_events', table => {
    table.string('event_id').primary();
    table.string('deduplication_key').notNullable();
    table.string('kind').notNullable();
    table.text('target_json').notNullable();
    table.string('title').notNullable();
    table.text('body').notNullable();
    table.timestamp('occurred_at');
  });
  await database.schema.createTable('notification_user_states', table => {
    table.increments('id').primary();
    table.string('event_id').notNullable();
    table.string('user_id').notNullable();
    table.timestamp('read_at');
    table.timestamp('dismissed_at');
  });
  return database;
}

export async function clearDashboardTestDatabase(database: Knex): Promise<void> {
  await database('task_history').del();
  await database('tasks').del();
  await database('plan_issues').del();
  await database('llm_executions').del();
  await database('notification_user_states').del();
  await database('notification_events').del();
}

export interface TaskSeed {
  taskId: string;
  repository?: string;
  issueNumber?: number | null;
  prNumber?: number | null;
  taskType?: string;
  title?: string;
  createdAt?: string;
  states: Array<{ state: string; timestamp: string; reason?: string }>;
}

export async function seedTask(database: Knex, seed: TaskSeed): Promise<void> {
  const repository = seed.repository ?? 'integry/propr';
  await database('tasks').insert({
    task_id: seed.taskId,
    repository,
    issue_number: seed.issueNumber === undefined ? 1 : seed.issueNumber,
    pr_number: seed.prNumber ?? null,
    task_type: seed.taskType ?? 'issue',
    model_name: 'claude-opus-5',
    created_at: seed.createdAt ?? seed.states[0].timestamp,
    initial_job_data: JSON.stringify({ title: seed.title ?? `Task ${seed.taskId}` }),
    final_result: null,
  });
  await database('task_history').insert(seed.states.map(entry => ({
    task_id: seed.taskId,
    state: entry.state,
    timestamp: entry.timestamp,
    reason: entry.reason ?? null,
    metadata: '{}',
  })));
}

function jsonResponse(): {
  response: ExpressResponse;
  status: () => number;
  body: () => Record<string, never> & Record<string, unknown>;
} {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  const response = {
    status(code: number) { statusCode = code; return response; },
    json(body: Record<string, unknown>) { payload = body; return response; },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload as never };
}

const request = (query: Record<string, string> = {}): Request => ({ query } as unknown as Request);

export async function call(
  handler: (req: Request, res: ExpressResponse) => Promise<void>,
  query: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recorder = jsonResponse();
  await handler(request(query), recorder.response);
  return { status: recorder.status(), body: recorder.body() };
}
