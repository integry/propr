import { afterEach, mock } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';

process.env.PROPR_DEMO_MODE = 'true';
await mock.module('@propr/core', {
  namedExports: {
    inspectExactTaskContainerLivenessForTask: async () => 'not_found',
    logger: { warn: mock.fn(), error: mock.fn() },
  },
});

export const { createLiveActivityRoutes } = await import('../../routes/liveActivityRoutes.js');

const databases: Knex[] = [];

export async function database(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  databases.push(db);
  await db.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('job_id');
    table.text('correlation_id');
    table.text('repository');
    table.text('created_at');
    table.text('initial_job_data');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.text('task_id');
    table.text('state');
  });
  await db.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id');
    table.text('name');
    table.text('initial_prompt');
    table.text('repository');
    table.text('status');
    table.text('created_at');
  });
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(db => db.destroy()));
});

export async function invoke(handler: (req: Request, res: Response) => Promise<void>, limit = 50) {
  let body: unknown;
  let status = 200;
  const req = { query: { limit: String(limit) }, user: { id: 'user-1' } } as unknown as Request;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  await handler(req, res);
  return { status, body: body as { items: Array<{ id: string; type: string; label: string; repository: string; status: string; createdAt: string }>; total: number; remaining: number } };
}
