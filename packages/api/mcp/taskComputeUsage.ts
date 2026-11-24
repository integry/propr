import type { Knex } from 'knex';
import { hasColumn, hasTable } from '../routes/analyticsSchema.js';

/** Compute usage of one task's agent runs, beside their LLM token cost. */
export interface TaskComputeUsage {
  /** Executions whose runtime reported compute usage. */
  runs: number;
  /** Runtimes those runs used, e.g. `["docker"]`. */
  runtimes: string[];
  wallTimeMs: number;
  /** Null when no run measured CPU. */
  cpuSeconds: number | null;
  /** Highest peak memory of any run; null when none measured memory. */
  peakMemoryBytes: number | null;
  /** Compute cost (runtime-reported or rate table); null when no run was priced. */
  costUsd: number | null;
  /** LLM token cost of the same task's executions; null when none recorded one. */
  llmCostUsd: number | null;
}

interface UsageRow {
  runs?: number | string;
  wall?: number | string | null;
  cpu?: number | string | null;
  cpu_measured?: number | string;
  peak?: number | string | null;
  cost?: number | string | null;
  costed?: number | string;
  llm_cost?: number | string | null;
  llm_costed?: number | string;
}

const toNumber = (value: unknown): number => Number(value ?? 0) || 0;

/**
 * The task's compute usage from its `llm_executions` rows; null when the
 * schema predates compute usage or no run of the task reported any, so an
 * unmeasured task never reads as one that used nothing.
 */
export async function taskComputeUsage(db: Knex, taskId: string): Promise<TaskComputeUsage | null> {
  if (!await hasTable(db, 'llm_executions') || !await hasColumn(db, 'llm_executions', 'compute_wall_time_ms')) return null;
  const executions = () => db('llm_executions').where({ task_id: taskId });
  const [row, runtimes] = await Promise.all([
    executions()
      .count('compute_wall_time_ms as runs')
      .sum('compute_wall_time_ms as wall')
      .sum('compute_cpu_seconds as cpu')
      .count('compute_cpu_seconds as cpu_measured')
      .max('compute_peak_memory_bytes as peak')
      .sum('compute_cost_usd as cost')
      .count('compute_cost_usd as costed')
      .sum('cost_usd as llm_cost')
      .count('cost_usd as llm_costed')
      .first() as Promise<UsageRow | undefined>,
    executions().whereNotNull('compute_runtime').distinct('compute_runtime').pluck('compute_runtime') as Promise<string[]>,
  ]);
  if (!row || toNumber(row.runs) === 0) return null;
  return {
    runs: toNumber(row.runs),
    runtimes: [...runtimes].sort(),
    wallTimeMs: toNumber(row.wall),
    cpuSeconds: toNumber(row.cpu_measured) > 0 ? Number(toNumber(row.cpu).toFixed(3)) : null,
    peakMemoryBytes: row.peak === null || row.peak === undefined ? null : toNumber(row.peak),
    costUsd: toNumber(row.costed) > 0 ? Number(toNumber(row.cost).toFixed(6)) : null,
    llmCostUsd: toNumber(row.llm_costed) > 0 ? Number(toNumber(row.llm_cost).toFixed(6)) : null,
  };
}
