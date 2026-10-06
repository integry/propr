import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { runCostCapKey } from '@propr/core';
import type { RunCostCapSource } from '@propr/shared';

/** A task's spend against its run spend cap, shown beside its cost. */
export interface TaskBudget {
  /** Estimated spend recorded for the task and the earlier attempts it continues. */
  spentUsd: number;
  capUsd: number | null;
  /** Spend as a share of the cap, 0-100+; null without a cap. */
  percent: number | null;
  source: RunCostCapSource | null;
  /** The run was stopped at its cap. */
  exceeded: boolean;
}

interface StoredCap { capUsd?: unknown; source?: unknown; budgetTaskIds?: unknown }

function readStoredCap(raw: string | null): StoredCap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as StoredCap : null;
  } catch { return null; }
}

function latestBudgetEvent(history: Array<Record<string, unknown>>): StoredCap | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const metadata = history[index].metadata as Record<string, unknown> | undefined;
    if (metadata?.event === 'budget.exceeded' && metadata.budget && typeof metadata.budget === 'object') return metadata.budget as StoredCap;
  }
  return null;
}

function taskIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

const CAP_SOURCES: readonly RunCostCapSource[] = ['override', 'workflow', 'instance_default'];

export async function loadTaskBudget(
  db: Knex,
  redisClient: Pick<RedisClientType, 'get'>,
  taskId: string,
  history: Array<Record<string, unknown>>,
): Promise<TaskBudget | null> {
  try {
    const exceededEvent = latestBudgetEvent(history);
    let stored: StoredCap | null = null;
    try { stored = readStoredCap(await redisClient.get(runCostCapKey(taskId))); } catch { /* Redis is optional for a finished task */ }
    const cap = stored ?? exceededEvent;
    const capUsd = typeof cap?.capUsd === 'number' && Number.isFinite(cap.capUsd) && cap.capUsd > 0 ? cap.capUsd : null;
    const source = CAP_SOURCES.find(candidate => candidate === cap?.source) ?? null;
    // The timeline event keeps the earlier attempts once the Redis record expires.
    const budgetTaskIds = [...new Set([taskId, ...taskIdList(stored?.budgetTaskIds), ...taskIdList(exceededEvent?.budgetTaskIds)])];
    const row = await db('llm_executions').whereIn('task_id', budgetTaskIds).sum({ total: 'cost_usd' }).first() as { total?: number | string | null } | undefined;
    const spentUsd = Number(row?.total ?? 0) || 0;
    if (capUsd === null && spentUsd <= 0) return null;
    return {
      spentUsd: Number(spentUsd.toFixed(4)),
      capUsd,
      percent: capUsd ? Math.round((spentUsd / capUsd) * 1000) / 10 : null,
      source: capUsd ? source : null,
      exceeded: exceededEvent !== null,
    };
  } catch (error) {
    console.error('Error loading task budget:', error);
    return null;
  }
}
