import type { Knex } from 'knex';
import { isUltrafixCommandTool } from './ultrafix.js';

export const PICKUP_DEADLINE_MS = 10 * 60 * 1000;

export const COMMAND_NOT_PICKED_UP_FAILURE = {
  code: 'COMMAND_NOT_PICKED_UP',
  stage: 'queue',
  retryable: true,
  status: 503,
  message: 'No worker picked up the command comment. Check that event intake is running (get_setup_status) and that the PR carries a processing label or the author is allowed.',
} as const;

export type UltrafixOutcome = 'goal_reached' | 'cycles_exhausted' | 'stopped' | 'failed';
export type UltrafixPhase = 'review' | 'fix' | 'waiting_for_ci' | 'paused' | 'stopping' | 'done';

export interface CommandPickup {
  task_id: string;
  pr_number: number | null;
  initial_job_data: unknown;
  created_at?: unknown;
}

export interface UltrafixCycleProgress {
  cycle: number;
  reviewTaskId?: string;
  fixTaskId?: string;
  score?: number;
}

export interface UltrafixProgress {
  kind: 'ultrafix';
  goal: number;
  maxCycles: number;
  cycle: number;
  lastScore: number | null;
  phase: UltrafixPhase;
  outcome: UltrafixOutcome | null;
  cycles: UltrafixCycleProgress[];
  latestTaskId?: string;
  failingTaskId?: string;
  /** Why the loop is waiting, e.g. the blocking checks holding the next review. */
  deferral?: UltrafixDeferral;
}

export interface UltrafixDeferral {
  reason: string;
  blockingChecks?: string[];
}

/** Deferral details recorded in task history metadata, if any. */
export function deferralFrom(metadata: Record<string, unknown>): UltrafixDeferral | undefined {
  if (metadata.ultrafixDeferred !== true) return undefined;
  const checks = Array.isArray(metadata.ultrafixBlockingChecks)
    ? metadata.ultrafixBlockingChecks.filter((name): name is string => typeof name === 'string').slice(0, 20) : [];
  const reason = typeof metadata.ultrafixDeferralReason === 'string' ? metadata.ultrafixDeferralReason : 'waiting for readiness';
  return { reason, ...(checks.length ? { blockingChecks: checks } : {}) };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function positiveInteger(value: unknown): number | undefined {
  const number = numericMetadata(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = numericMetadata(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function finiteScore(value: unknown): number | undefined {
  const number = numericMetadata(value);
  return number !== undefined && Number.isFinite(number) && number >= 0 && number <= 10 ? number : undefined;
}

function numericMetadata(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return Number(value);
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Find the task which selected this exact command comment for execution. */
export async function detectPickup(db: Knex, input: {
  repository: string;
  pullRequest: number;
  commentId: number;
  tool: string;
}): Promise<CommandPickup | undefined> {
  const data = `CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END`;
  const query = db('tasks').where({ repository: input.repository, issue_number: input.pullRequest }).whereNot('task_type', 'goal')
    .whereRaw(`CASE
      WHEN json_extract(${data}, '$.commandCommentId') IS NOT NULL THEN
        json_extract(${data}, '$.commandCommentId') = ?
        AND COALESCE(json_extract(${data}, '$.commandCommentType'), 'issue') = 'issue'
      WHEN json_type(${data}, '$.comments') = 'array' THEN EXISTS (
        SELECT 1 FROM json_each(${data}, '$.comments')
        WHERE json_extract(json_each.value, '$.id') = ?
          AND COALESCE(json_extract(json_each.value, '$.type'), 'issue') = 'issue'
      )
      ELSE json_extract(${data}, '$.commentId') = ?
    END`, [input.commentId, input.commentId, input.commentId]);

  if (isUltrafixCommandTool(input.tool)) {
    query.whereRaw(`json_type(${data}, '$.ultrafixMeta.workEpoch') = 'integer'`);
  } else {
    const mode = input.tool === 'review_pull_request' ? 'review'
      : input.tool === 'fix_review_findings' ? 'fix' : 'default';
    query.whereRaw(`COALESCE(json_extract(${data}, '$.commandMode'), 'default') = ?`, [mode]);
  }
  return query.orderBy('created_at', 'desc').first('task_id', 'pr_number', 'initial_job_data', 'created_at');
}

function taskMode(data: Record<string, unknown>): 'review' | 'fix' | undefined {
  return data.commandMode === 'review' || data.commandMode === 'fix' ? data.commandMode : undefined;
}

function outcomeFrom(value: unknown): UltrafixOutcome | null {
  return ['goal_reached', 'cycles_exhausted', 'stopped', 'failed'].includes(String(value))
    ? value as UltrafixOutcome : null;
}

/** Reconstruct one ultrafix epoch exclusively from durable task and history rows. */
// eslint-disable-next-line complexity -- history normalization keeps all epoch and legacy fallbacks in one deterministic pass
export async function ultrafixProgress(db: Knex, input: {
  repository: string;
  pullRequest: number;
  sinceMs: number;
  goal: number;
  maxCycles: number;
  workEpoch?: number;
}): Promise<UltrafixProgress> {
  const data = `CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END`;
  let inferredEpoch = nonNegativeInteger(input.workEpoch);
  if (inferredEpoch === undefined) {
    const candidates = await db('tasks').where({ repository: input.repository, issue_number: input.pullRequest })
      .whereNot('task_type', 'goal')
      .whereRaw(`json_type(${data}, '$.ultrafixMeta.workEpoch') = 'integer'`)
      .orderBy('created_at', 'asc').select('initial_job_data', 'created_at');
    const first = candidates.find(row => {
      const taskData = jsonRecord(row.initial_job_data);
      const created = timestamp(row.created_at);
      return (created === undefined || created >= input.sinceMs)
        && nonNegativeInteger(jsonRecord(taskData.ultrafixMeta).workEpoch) !== undefined;
    });
    inferredEpoch = nonNegativeInteger(jsonRecord(jsonRecord(first?.initial_job_data).ultrafixMeta).workEpoch);
  }
  const query = db('tasks').where({ repository: input.repository, issue_number: input.pullRequest })
    .whereNot('task_type', 'goal');
  if (inferredEpoch !== undefined) {
    query.whereRaw(`json_type(${data}, '$.ultrafixMeta.workEpoch') = 'integer'`)
      .whereRaw(`json_extract(${data}, '$.ultrafixMeta.workEpoch') = ?`, [inferredEpoch]);
  } else {
    query.whereRaw(`json_type(${data}, '$.ultrafixMeta') = 'object'`);
  }
  // Bound only after epoch selection, newest first, so current and terminal
  // evidence survive even if an epoch itself exceeds the reconstruction cap.
  const rows = await query.orderBy('created_at', 'desc').orderBy('task_id', 'desc').limit(200)
    .select('task_id', 'initial_job_data', 'created_at');
  const tasks = rows.reverse().map(row => ({ ...row, data: jsonRecord(row.initial_job_data) })).filter(row => {
    if (inferredEpoch !== undefined) return true;
    const created = timestamp(row.created_at);
    return created === undefined || created >= input.sinceMs;
  });
  const ids = tasks.map(task => task.task_id);
  const histories = ids.length ? await db('task_history').whereIn('task_id', ids)
    .orderBy('history_id', 'asc').select('history_id', 'task_id', 'state', 'timestamp', 'metadata') : [];
  const historiesByTask = new Map<string, typeof histories>();
  for (const history of histories) {
    const list = historiesByTask.get(history.task_id) ?? [];
    list.push(history);
    historiesByTask.set(history.task_id, list);
  }

  let outcome: UltrafixOutcome | null = null;
  let lastScore: number | null = null;
  let failingTaskId: string | undefined;
  let terminalCycle: number | undefined;
  for (const history of histories) {
    const metadata = jsonRecord(history.metadata);
    const score = finiteScore(metadata.ultrafixScore);
    if (score !== undefined) lastScore = score;
    const durableOutcome = outcomeFrom(metadata.ultrafixOutcome);
    if (durableOutcome) {
      outcome = durableOutcome;
      terminalCycle = positiveInteger(metadata.ultrafixCycle) ?? positiveInteger(metadata.ultrafixCycleCount);
      if (durableOutcome === 'failed') failingTaskId = history.task_id;
    }
  }

  const cycles = new Map<number, UltrafixCycleProgress>();
  const actionCycles = { review: 0, fix: 0 };
  for (const task of tasks) {
    const mode = taskMode(task.data);
    if (!mode) continue;
    const taskHistories = historiesByTask.get(task.task_id) ?? [];
    const metadata = taskHistories.map(history => jsonRecord(history.metadata));
    const recordedCycle = metadata.map(item => positiveInteger(item.ultrafixCycle)).find((value): value is number => value !== undefined);
    if (recordedCycle) actionCycles[mode] = Math.max(actionCycles[mode], recordedCycle);
    else actionCycles[mode]++;
    const cycleNumber = recordedCycle ?? actionCycles[mode];
    const cycle = cycles.get(cycleNumber) ?? { cycle: cycleNumber };
    if (mode === 'review') cycle.reviewTaskId = task.task_id;
    else cycle.fixTaskId = task.task_id;
    const score = metadata.map(item => finiteScore(item.ultrafixScore)).find((value): value is number => value !== undefined);
    if (score !== undefined) cycle.score = score;
    cycles.set(cycleNumber, cycle);
  }

  const latestTask = tasks.at(-1);
  const latestHistories = latestTask ? historiesByTask.get(latestTask.task_id) ?? [] : [];
  const latest = latestHistories.at(-1);
  const latestMetadata = jsonRecord(latest?.metadata);
  let phase: UltrafixPhase;
  if (outcome) phase = 'done';
  else if (latest && ['cancelled', 'failed'].includes(String(latest.state))) phase = 'paused';
  else if (latest && !['completed'].includes(String(latest.state))) phase = taskMode(latestTask!.data) ?? 'waiting_for_ci';
  else if (latestMetadata.ultrafixDeferred === true || latestMetadata.ultrafixNextAction) phase = 'waiting_for_ci';
  else phase = taskMode(latestTask?.data ?? {}) ?? 'waiting_for_ci';

  const boundedCycles = [...cycles.values()].sort((a, b) => a.cycle - b.cycle).slice(-10);
  const deferral = phase === 'waiting_for_ci' ? deferralFrom(latestMetadata) : undefined;
  return {
    kind: 'ultrafix', goal: input.goal, maxCycles: input.maxCycles,
    cycle: terminalCycle ?? boundedCycles.at(-1)?.cycle ?? 0,
    lastScore, phase, outcome, cycles: boundedCycles,
    ...(latestTask ? { latestTaskId: latestTask.task_id } : {}),
    ...(failingTaskId ? { failingTaskId } : {}),
    ...(deferral ? { deferral } : {}),
  };
}

/** Render a compact sentence from persisted lifecycle data (safe for list_operations). */
// eslint-disable-next-line complexity -- each explicit phase/outcome has deliberately distinct user-facing wording
export function summarizeLifecycle(tool: string, lifecycle: Record<string, unknown>): string {
  const state = String(lifecycle.state ?? 'accepted');
  const progress = jsonRecord(lifecycle.progress);
  if (isUltrafixCommandTool(tool) && progress.kind === 'ultrafix') {
    const cycle = nonNegativeInteger(progress.cycle) ?? 0;
    const maxCycles = positiveInteger(progress.maxCycles) ?? 0;
    const goal = finiteScore(progress.goal) ?? 0;
    const score = finiteScore(progress.lastScore);
    const scoreText = score === undefined ? 'no review score yet' : `last score ${score}/10`;
    // Lifecycle termination is authoritative even for receipts written before
    // terminal ultrafix progress was normalized.
    if (state === 'failed') return `Ultrafix failed during cycle ${cycle || 1}; ${scoreText}.`;
    if (state === 'cancelled') return `Ultrafix was stopped after ${cycle} cycle${cycle === 1 ? '' : 's'}; ${scoreText}.`;
    if (progress.outcome === 'goal_reached') return `Ultrafix reached goal ${goal} after ${cycle} cycle${cycle === 1 ? '' : 's'}; ${scoreText}.`;
    if (progress.outcome === 'cycles_exhausted') return `Ultrafix stopped after exhausting ${cycle || maxCycles} cycles; ${scoreText} did not reach goal ${goal}.`;
    if (progress.outcome === 'stopped') return `Ultrafix was stopped after ${cycle} cycle${cycle === 1 ? '' : 's'}; ${scoreText}.`;
    if (progress.outcome === 'failed') return `Ultrafix failed during cycle ${cycle || 1}; ${scoreText}.`;
    if (state === 'completed') return `Ultrafix completed after ${cycle} cycle${cycle === 1 ? '' : 's'}; ${scoreText}.`;
    if (progress.phase === 'stopping') return `Ultrafix is stopping after cycle ${cycle}; the circuit-breaker label was removed.`;
    const phase = progress.phase === 'waiting_for_ci' ? 'waiting for CI'
      : progress.phase === 'paused' ? 'paused' : `${String(progress.phase)}ing`;
    const deferral = jsonRecord(progress.deferral);
    const blocking = progress.phase === 'waiting_for_ci' && Array.isArray(deferral.blockingChecks) && deferral.blockingChecks.length
      ? ` Blocking checks: ${deferral.blockingChecks.map(String).join(', ')}.` : '';
    return `Ultrafix cycle ${Math.max(1, cycle)} of ${maxCycles} is ${phase}; ${scoreText}${score === undefined ? '' : ` (goal ${goal})`}.${blocking}`;
  }
  const names: Record<string, string> = {
    review_pull_request: 'Pull request review', fix_review_findings: 'Review fix',
    comment_on_pull_request: 'Pull request comment', resolve_merge_conflicts: 'Merge conflict resolution',
  };
  const subject = names[tool] ?? 'Operation';
  if (state === 'accepted') return `${subject} was accepted and is waiting to start.`;
  if (state === 'running') return `${subject} was picked up by a worker and is running.`;
  if (state === 'completed') return `${subject} completed successfully.`;
  if (state === 'cancelled') return `${subject} was cancelled.`;
  if (state === 'failed') return `${subject} failed.`;
  return `${subject} has not been confirmed; it may still be picked up.`;
}
