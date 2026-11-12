/**
 * The LLM cost export: recorded agent executions grouped by any of day,
 * repository, agent, model, reasoning level, execution type and outcome.
 *
 * An execution is one `llm_executions` row. Its repository comes from its
 * task; its agent and execution type from the one `llm_logs` call that
 * recorded the same run (see `loggedRuns`). A dimension that was never
 * recorded is null, never a guess, and a group none of whose executions
 * recorded a cost has a null cost rather than $0.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { readAnalyticsWindow, whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { hasColumn, hasTable } from './analyticsSchema.js';
import { csvCell } from './reviewScoreStats.js';
import { validateRepositoryFilter } from './validation.js';

/** Grouping dimensions, in the order their columns appear. */
export const COST_GROUP_KEYS = ['day', 'repository', 'agent', 'model', 'reasoning_level', 'execution_type', 'outcome'] as const;
export type CostGroupKey = typeof COST_GROUP_KEYS[number];
export const DEFAULT_COST_GROUP_BY: readonly CostGroupKey[] = ['day'];

export interface CostFigures {
  executions: number;
  /** Distinct tasks with at least one execution in the row. */
  tasks: number;
  /** Cache-inclusive input tokens, as each execution's cost was priced from. */
  input_tokens: number;
  output_tokens: number;
  /** Of `input_tokens`, prompt-cache writes. */
  cache_creation_input_tokens: number;
  /** Of `input_tokens`, prompt-cache reads. */
  cache_read_input_tokens: number;
  /** Recorded cost; null when no execution in the row recorded one. */
  cost_usd: number | null;
}

export type CostRow = Partial<Record<CostGroupKey, string | null>> & CostFigures;

export interface CostExport {
  period: string | null;
  /** `all` or `owner/repo`; `granted` when scoped to a list of repositories. */
  repository: string;
  group_by: CostGroupKey[];
  rows: CostRow[];
  totals: CostFigures;
}

export interface CostExportScope {
  /** `all`, or one `owner/repo`. */
  repository?: string;
  /** Limits the export to these repositories (MCP grants); an empty list exports nothing. */
  repositories?: string[];
}

/**
 * Reads `group_by` as a comma-separated list, repeated parameters, or both.
 * Returns the keys in column order without duplicates, or the first unknown key.
 */
export function parseCostGroupBy(value: unknown): { keys: CostGroupKey[] } | { invalid: string } {
  if (value === undefined || value === '') return { keys: [...DEFAULT_COST_GROUP_BY] };
  const parts = (Array.isArray(value) ? value : [value]).flatMap(part => String(part).split(','))
    .map(part => part.trim()).filter(Boolean);
  const unknown = parts.find(part => !(COST_GROUP_KEYS as readonly string[]).includes(part));
  if (unknown !== undefined) return { invalid: unknown };
  return { keys: COST_GROUP_KEYS.filter(key => parts.includes(key)) };
}

/**
 * The one `llm_logs` call that recorded each execution in the window: a call of
 * the same task in the same session, or, when neither has a session (both are
 * written from one result), of the same task on the same model; a task-less
 * execution matches only a call of its session. Among matches the same
 * session, then the same model, then the nearest start wins. Both dimensions
 * are read from that one call, so an execution with no matching call has
 * neither.
 */
function loggedRuns(db: Knex, byTask: boolean, window: AnalyticsWindow | null): Knex.Raw {
  const candidates = (match: string) => {
    const query = db('llm_executions as re').join('llm_logs as l', db.raw(match))
      .select('re.execution_id', 'l.agent_alias', 'l.execution_type', db.raw(`row_number() over (
        partition by re.execution_id
        order by (case when l.session_id = re.session_id then 0 else 1 end),
          (case when l.model_name = re.model_name then 0 else 1 end),
          abs(julianday(l.start_time) - julianday(re.start_time)), l.log_id
      ) as rank`));
    return whereCreatedWithin(query, 're.start_time', window);
  };
  const viaSession = candidates(`l.session_id = re.session_id${byTask ? ' and re.task_id is null' : ''}`);
  const viaTask = candidates(`l.task_id = re.task_id and (l.session_id = re.session_id
    or (l.session_id is null and re.session_id is null and l.model_name = re.model_name))`);
  const ranked = byTask ? db.queryBuilder().unionAll([viaTask, viaSession]) : viaSession;
  return db.raw(`(select execution_id, agent_alias, execution_type from (?) where rank = 1) as run`, [ranked]);
}

interface ExecutionSchema { hasLogs: boolean; logsHaveTask: boolean; hasReasoning: boolean; hasCache: boolean }

async function probeExecutionSchema(db: Knex): Promise<ExecutionSchema> {
  const [hasLogs, logsHaveTask, hasReasoning, hasCache] = await Promise.all([
    hasTable(db, 'llm_logs'),
    hasColumn(db, 'llm_logs', 'task_id'),
    hasColumn(db, 'llm_executions', 'reasoning_level'),
    hasColumn(db, 'llm_executions', 'cache_read_input_tokens'),
  ]);
  return { hasLogs, logsHaveTask, hasReasoning, hasCache };
}

/**
 * One row per execution in the window and scope, with every requested dimension.
 * Synchronous on purpose: a query builder is a thenable, so returning one from
 * an async function would run it.
 */
function executionRows(
  db: Knex, schema: ExecutionSchema, groupBy: CostGroupKey[], { window, ...scope }: CostExportScope & { window: AnalyticsWindow | null },
): Knex.QueryBuilder {
  const { hasLogs, logsHaveTask, hasReasoning, hasCache } = schema;
  const detailSum = (executionColumn: string, detailColumn: string) => db.raw(`coalesce(e.${executionColumn}, (
    select sum(d.${detailColumn}) from llm_execution_details d where d.execution_id = e.execution_id
  ), 0) as ${executionColumn}`);
  const dimensions: Record<CostGroupKey, string> = {
    day: 'date(e.start_time)',
    repository: 't.repository',
    agent: hasLogs ? 'run.agent_alias' : 'NULL',
    model: `NULLIF(e.model_name, '')`,
    reasoning_level: hasReasoning ? `NULLIF(e.reasoning_level, '')` : 'NULL',
    execution_type: hasLogs ? 'run.execution_type' : 'NULL',
    outcome: `CASE WHEN e.success = ? THEN 'failed' ELSE 'success' END`,
  };
  const query = db('llm_executions as e')
    .leftJoin('tasks as t', 't.task_id', 'e.task_id')
    .select('e.task_id', 'e.cost_usd', detailSum('input_tokens', 'token_count_input'), detailSum('output_tokens', 'token_count_output'))
    .select(db.raw(hasCache
      ? 'coalesce(e.cache_creation_input_tokens, 0) as cache_creation_input_tokens, coalesce(e.cache_read_input_tokens, 0) as cache_read_input_tokens'
      : '0 as cache_creation_input_tokens, 0 as cache_read_input_tokens'));
  if (hasLogs && (groupBy.includes('agent') || groupBy.includes('execution_type'))) {
    query.leftJoin(loggedRuns(db, logsHaveTask, window), 'run.execution_id', 'e.execution_id');
  }
  for (const key of groupBy) {
    query.select(db.raw(`${dimensions[key]} as ${key}`, key === 'outcome' ? [false] : []));
  }
  whereCreatedWithin(query, 'e.start_time', window);
  if (scope.repositories) query.whereIn('t.repository', scope.repositories);
  if (scope.repository && scope.repository !== 'all') query.where('t.repository', scope.repository);
  return query;
}

interface AggregateRow {
  executions?: number | string;
  tasks?: number | string;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  cache_creation_input_tokens?: number | string | null;
  cache_read_input_tokens?: number | string | null;
  cost_usd?: number | string | null;
  costed?: number | string;
  [key: string]: unknown;
}

function aggregate(db: Knex, rows: Knex.QueryBuilder): Knex.QueryBuilder {
  return db.from(rows.as('x'))
    .count('* as executions')
    .countDistinct('x.task_id as tasks')
    .sum('x.input_tokens as input_tokens')
    .sum('x.output_tokens as output_tokens')
    .sum('x.cache_creation_input_tokens as cache_creation_input_tokens')
    .sum('x.cache_read_input_tokens as cache_read_input_tokens')
    .sum('x.cost_usd as cost_usd')
    .count('x.cost_usd as costed');
}

function figures(row: AggregateRow | undefined): CostFigures {
  const count = (value: unknown) => Number(value ?? 0) || 0;
  return {
    executions: count(row?.executions),
    tasks: count(row?.tasks),
    input_tokens: count(row?.input_tokens),
    output_tokens: count(row?.output_tokens),
    cache_creation_input_tokens: count(row?.cache_creation_input_tokens),
    cache_read_input_tokens: count(row?.cache_read_input_tokens),
    cost_usd: count(row?.costed) > 0 ? Number(Number(row?.cost_usd ?? 0).toFixed(6)) : null,
  };
}

const dimensionValue = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value);

/** Ascending by each dimension in column order; unknown values last. */
function compareRows(groupBy: CostGroupKey[]) {
  return (left: CostRow, right: CostRow): number => {
    for (const key of groupBy) {
      const [a, b] = [left[key] ?? null, right[key] ?? null];
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      return a < b ? -1 : 1;
    }
    return 0;
  };
}

/** Recorded executions in the window, grouped by `groupBy`, with totals over every row. */
export async function loadCostExport(
  db: Knex, window: AnalyticsWindow | null, groupBy: CostGroupKey[], scope: CostExportScope = {},
): Promise<CostExport> {
  const keys = COST_GROUP_KEYS.filter(key => groupBy.includes(key));
  const schema = await probeExecutionSchema(db);
  const grouped = aggregate(db, executionRows(db, schema, keys, { ...scope, window })).select(keys.map(key => `x.${key}`));
  if (keys.length) grouped.groupBy(keys.map(key => `x.${key}`));
  const [groups, total] = await Promise.all([
    grouped as unknown as Promise<AggregateRow[]>,
    aggregate(db, executionRows(db, schema, [], { ...scope, window })).first() as unknown as Promise<AggregateRow | undefined>,
  ]);
  const rows = groups
    .map(row => ({ ...Object.fromEntries(keys.map(key => [key, dimensionValue(row[key])])), ...figures(row) }) as CostRow)
    .filter(row => row.executions > 0)
    .sort(compareRows(keys));
  return {
    period: window?.timeframe ?? null,
    repository: scope.repositories ? 'granted' : scope.repository || 'all',
    group_by: keys,
    rows,
    totals: figures(total),
  };
}

const FIGURE_COLUMNS: Array<keyof CostFigures> = [
  'executions', 'tasks', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cost_usd',
];

/** Header row, then one row per group: the grouped dimensions in column order, then the figures. */
export function costExportCsv(costExport: CostExport): string {
  const columns: Array<keyof CostRow> = [...costExport.group_by, ...FIGURE_COLUMNS];
  const lines = [columns.join(',')];
  for (const row of costExport.rows) lines.push(columns.map(column => csvCell(row[column] ?? null)).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function createCostExportRoutes({ db, now = () => new Date() }: { db: Knex; now?: () => Date }) {
  async function readExport(req: Request, res: Response): Promise<CostExport | null> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return null;
    const repository = typeof req.query.repository === 'string' && req.query.repository ? req.query.repository : 'all';
    const validation = validateRepositoryFilter(repository);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return null;
    }
    const groupBy = parseCostGroupBy(req.query.group_by);
    if ('invalid' in groupBy) {
      res.status(400).json({ error: `group_by must be a comma-separated list of: ${COST_GROUP_KEYS.join(', ')}` });
      return null;
    }
    return await loadCostExport(db, analyticsWindow, groupBy.keys, { repository: repository === 'all' ? 'all' : repository.trim() });
  }

  async function getCost(req: Request, res: Response): Promise<void> {
    try {
      const costExport = await readExport(req, res);
      if (costExport) res.json(costExport);
    } catch (error) {
      console.error('Error in /api/stats/cost:', error);
      res.status(500).json({ error: 'Failed to fetch cost statistics' });
    }
  }

  async function getCostCsv(req: Request, res: Response): Promise<void> {
    try {
      const costExport = await readExport(req, res);
      if (!costExport) return;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cost-${costExport.period ?? 'all'}.csv"`);
      res.send(costExportCsv(costExport));
    } catch (error) {
      console.error('Error in /api/stats/cost.csv:', error);
      res.status(500).json({ error: 'Failed to export cost statistics' });
    }
  }

  return { getCost, getCostCsv };
}
