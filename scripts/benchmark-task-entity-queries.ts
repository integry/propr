import { performance } from 'node:perf_hooks';
import os from 'node:os';
import knex, { Knex } from 'knex';
import { getTasksFromDb } from '../packages/api/routes/taskHelpers.js';
import { up as addTaskHistoryLookupIndex } from '../packages/core/src/db/migrations/20260914000000_optimize_task_history_lookup.js';

interface BenchmarkOptions {
  tasks: number;
  historyPerTask: number;
  executionsPerTask: number;
  iterations: number;
  warmups: number;
  pageSize: number;
}

function integerArgument(name: string, fallback: number): number {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  if (!argument) return fallback;
  const parsed = Number(argument.slice(name.length + 3));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

const options: BenchmarkOptions = {
  tasks: integerArgument('tasks', 20_000),
  historyPerTask: integerArgument('history', 12),
  executionsPerTask: integerArgument('executions', 3),
  iterations: integerArgument('iterations', 30),
  warmups: integerArgument('warmups', 5),
  pageSize: integerArgument('page-size', 50),
};

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function measure(operation: () => Promise<unknown>): Promise<{ p50: number; p95: number; timings: number[] }> {
  for (let index = 0; index < options.warmups; index += 1) await operation();
  const timings: number[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const started = performance.now();
    await operation();
    timings.push(performance.now() - started);
  }
  return { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), timings };
}

async function createFixture(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.integer('issue_number');
    table.string('task_type');
    table.string('model_name');
    table.timestamp('created_at');
    table.text('initial_job_data');
    table.text('final_result');
    table.index('created_at');
    table.index('repository');
    table.index('task_type');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id');
    table.string('state');
    table.timestamp('timestamp');
    table.text('reason');
    table.index('task_id');
    table.index('state');
    table.index('timestamp');
  });
  await db.schema.createTable('plan_issues', table => {
    table.increments('id').primary();
    table.string('task_id');
    table.string('status');
    table.index('task_id');
  });
  await db.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id');
    table.text('analysis_report');
    table.index('task_id');
  });

  const taskRows: Record<string, unknown>[] = [];
  const historyRows: Record<string, unknown>[] = [];
  const executionRows: Record<string, unknown>[] = [];
  const planRows: Record<string, unknown>[] = [];
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
  const states = ['pending', 'processing', 'claude_execution', 'post_processing', 'completed'];

  for (let taskIndex = 0; taskIndex < options.tasks; taskIndex += 1) {
    const taskId = `task-${String(taskIndex).padStart(8, '0')}`;
    const taskTime = baseTime + taskIndex * 60_000;
    taskRows.push({
      task_id: taskId,
      repository: taskIndex % 4 === 0 ? 'integry/propr' : `fixture/repo-${taskIndex % 20}`,
      issue_number: taskIndex + 1,
      task_type: taskIndex % 100 === 0 ? 'goal' : 'issue',
      model_name: 'gpt-5.6-sol',
      created_at: new Date(taskTime).toISOString(),
      initial_job_data: JSON.stringify({ title: `Synthetic task ${taskIndex}` }),
    });
    for (let historyIndex = 0; historyIndex < options.historyPerTask; historyIndex += 1) {
      historyRows.push({
        task_id: taskId,
        state: states[Math.min(Math.floor(historyIndex * states.length / options.historyPerTask), states.length - 1)],
        timestamp: new Date(taskTime + historyIndex * 1_000).toISOString(),
      });
    }
    for (let executionIndex = 0; executionIndex < options.executionsPerTask; executionIndex += 1) {
      executionRows.push({
        task_id: taskId,
        analysis_report: executionIndex === options.executionsPerTask - 1 && taskIndex % 10 === 0
          ? '{malformed fixture json'
          : JSON.stringify({ report: `Result\n{\"implementation_critique_score\":${6 + taskIndex % 4}}\n\`\`\`` }),
      });
    }
    if (taskIndex % 5 === 0) planRows.push({ task_id: taskId, status: taskIndex % 25 === 0 ? 'merged' : 'under_review' });
  }

  await db.batchInsert('tasks', taskRows, 200);
  await db.batchInsert('task_history', historyRows, 200);
  await db.batchInsert('llm_executions', executionRows, 200);
  await db.batchInsert('plan_issues', planRows, 200);
  return db;
}

function legacyBaseQuery(db: Knex): Knex.QueryBuilder {
  const latestHistory = db('task_history')
    .select('task_id', 'state', 'timestamp', 'reason', db.raw(
      'ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY timestamp DESC) as rn'
    ))
    .as('h');
  const planIssues = db('plan_issues')
    .select('task_id', 'status as plan_issue_status')
    .whereNotNull('task_id')
    .as('pi');
  return db('tasks as t')
    .where(function() { this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal'); })
    .join(latestHistory, function() {
      this.on('t.task_id', '=', 'h.task_id').andOn('h.rn', '=', db.raw('?', [1]));
    })
    .leftJoin(planIssues, 'pi.task_id', 't.task_id');
}

async function runLegacyTaskList(db: Knex): Promise<{ total: number; ids: string[] }> {
  const baseQuery = legacyBaseQuery(db);
  const totalRow = await baseQuery.clone().count('* as total').first();
  const processing = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as processing_start_timestamp'))
    .whereIn('state', ['processing', 'claude_execution', 'post_processing'])
    .groupBy('task_id')
    .as('ps');
  const completion = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as completion_timestamp'))
    .whereIn('state', ['completed', 'failed', 'cancelled'])
    .groupBy('task_id')
    .as('cs');
  const rows = await baseQuery
    .leftJoin(processing, 'ps.task_id', 't.task_id')
    .leftJoin(completion, 'cs.task_id', 't.task_id')
    .joinRaw(`LEFT JOIN (
      SELECT le1.task_id,
        CASE WHEN INSTR(json_extract(le1.analysis_report, '$.report'), '{') > 0
          THEN json_extract(
            RTRIM(SUBSTR(json_extract(le1.analysis_report, '$.report'),
              INSTR(json_extract(le1.analysis_report, '$.report'), '{')), CHAR(10) || CHAR(13) || ' ' || '\`'),
            '$.implementation_critique_score')
          ELSE NULL END AS critique_score
      FROM llm_executions AS le1
      WHERE json_valid(le1.analysis_report) = 1
        AND json_extract(le1.analysis_report, '$.report') IS NOT NULL
        AND le1.execution_id = (
          SELECT MAX(le2.execution_id) FROM llm_executions AS le2
          WHERE le2.task_id = le1.task_id AND json_valid(le2.analysis_report) = 1
        )
    ) AS score ON score.task_id = t.task_id`)
    .select('t.task_id')
    .orderBy('t.created_at', 'desc')
    .limit(options.pageSize);
  return {
    total: Number(totalRow?.total ?? 0),
    ids: (rows as Array<{ task_id: unknown }>).map(row => String(row.task_id)),
  };
}

async function explain(db: Knex, query: Knex.QueryBuilder): Promise<string[]> {
  const compiled = query.toSQL().toNative();
  const rows = await db.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, compiled.bindings) as Array<{ detail: string }>;
  return rows.map(row => row.detail);
}

const db = await createFixture();
try {
  const sqliteVersion = await db.raw('SELECT sqlite_version() AS version') as Array<{ version: string }>;
  const legacyPlan = await explain(db, legacyBaseQuery(db).select('t.task_id').orderBy('t.created_at', 'desc').limit(options.pageSize));
  const legacy = await measure(() => runLegacyTaskList(db));
  const legacyResult = await runLegacyTaskList(db);

  await addTaskHistoryLookupIndex(db);
  const optimizedPlan = await db.raw(`EXPLAIN QUERY PLAN
    SELECT t.task_id
    FROM tasks AS t
    JOIN task_history AS h ON h.history_id = (
      SELECT latest_h.history_id FROM task_history AS latest_h
      WHERE latest_h.task_id = t.task_id ORDER BY latest_h.timestamp DESC LIMIT 1
    )
    WHERE t.task_type <> 'goal'
    ORDER BY t.created_at DESC LIMIT ?`, [options.pageSize]) as Array<{ detail: string }>;
  const optimized = await measure(() => getTasksFromDb({
    db, status: 'all', repository: 'all', limit: options.pageSize, offset: 0,
  }));
  const optimizedResult = await getTasksFromDb({
    db, status: 'all', repository: 'all', limit: options.pageSize, offset: 0,
  });
  const optimizedIds = (optimizedResult.tasks as Array<{ id: string }>).map(task => task.id);
  assertEquivalent(legacyResult, { total: optimizedResult.total, ids: optimizedIds });

  console.log(JSON.stringify({
    conditions: {
      ...options,
      sqlite: sqliteVersion[0].version,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      storage: 'in-memory disposable SQLite; warm connection/cache',
      query: 'all non-goal tasks, newest created_at page',
    },
    legacyMs: { p50: round(legacy.p50), p95: round(legacy.p95) },
    optimizedMs: { p50: round(optimized.p50), p95: round(optimized.p95) },
    speedup: { p50: round(legacy.p50 / optimized.p50), p95: round(legacy.p95 / optimized.p95) },
    legacyPlan,
    optimizedPlan: optimizedPlan.map(row => row.detail),
  }, null, 2));
} finally {
  await db.destroy();
}

function assertEquivalent(legacy: { total: number; ids: string[] }, optimized: { total: number; ids: string[] }): void {
  if (legacy.total !== optimized.total || legacy.ids.join('\0') !== optimized.ids.join('\0')) {
    throw new Error('Legacy and optimized benchmark queries returned different task identities');
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
