import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import {
  parseGoalArtifacts,
  validateGoalArtifacts,
  type GoalArtifactStats,
  type GoalLaunchStrategy,
} from '@propr/core';
import { parseRedisOutput } from './redisOutputParser.js';

export interface GoalProjectionRow {
  goal_id: string;
  owner_id: string;
  owner_login: string;
  repository: string;
  objective: string;
  launch_strategy: GoalLaunchStrategy;
  initial_prompt: string;
  base_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  agent_id: string;
  agent_alias: string;
  agent_type: string;
  requested_model: string;
  effective_model: string | null;
  max_parallel_tasks: number | null;
  ultrafix: number | boolean | null;
  desired_state: 'running' | 'paused' | 'cancelled';
  result_state: 'completed' | 'failed' | 'cancelled' | null;
  current_task_id: string;
  session_id: string | null;
  conversation_id: string | null;
  run_generation: number;
  run_claim: string | null;
  claimed_at: string | null;
  active_turn_id: string | null;
  pause_confirmed_at: string | null;
  resume_requested: number | boolean;
  final_pr_number: number | null;
  final_pr_url: string | null;
  artifact_refs: string | unknown[] | null;
  artifact_stats: string | GoalArtifactStats | null;
  artifacts_checked_at: string | null;
  failure_reason: string | null;
  create_idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  paused_at: string | null;
  paused_ms: number;
  completed_at: string | null;
}

function parseStats(value: GoalProjectionRow['artifact_stats']): GoalArtifactStats {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as GoalArtifactStats; } catch { /* use zero projection */ }
  }
  return { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 };
}

async function refreshArtifacts(
  db: Knex,
  row: GoalProjectionRow,
  output: string,
): Promise<GoalProjectionRow> {
  if (row.result_state) return row;
  const checkedAt = row.artifacts_checked_at ? new Date(row.artifacts_checked_at).getTime() : 0;
  if (Date.now() - checkedAt < 15_000) return row;
  try {
    const validated = await validateGoalArtifacts({
      context: { repository: row.repository, branchName: row.branch_name, baseBranch: row.base_branch },
      existing: parseGoalArtifacts(row.artifact_refs as string | null),
      output,
    });
    await db('goals').where({
      goal_id: row.goal_id,
      run_generation: row.run_generation,
      run_claim: row.run_claim,
    }).whereNull('result_state').update({
      artifact_refs: JSON.stringify(validated.artifacts),
      artifact_stats: JSON.stringify(validated.stats),
      artifacts_checked_at: db.fn.now(),
      ...(validated.finalPr ? {
        final_pr_number: validated.finalPr.number,
        final_pr_url: validated.finalPr.url,
      } : {}),
    });
    return {
      ...row,
      artifact_refs: validated.artifacts,
      artifact_stats: validated.stats,
      artifacts_checked_at: new Date().toISOString(),
      ...(validated.finalPr ? {
        final_pr_number: validated.finalPr.number,
        final_pr_url: validated.finalPr.url,
      } : {}),
    };
  } catch {
    return row;
  }
}

function goalTiming(row: GoalProjectionRow): { elapsedMs: number; pausedMs: number; activeMs: number } {
  const endMs = row.completed_at ? new Date(row.completed_at).getTime() : Date.now();
  const startMs = row.started_at ? new Date(row.started_at).getTime() : new Date(row.created_at).getTime();
  const currentPauseMs = row.desired_state === 'paused' && row.paused_at
    ? Math.max(0, Date.now() - new Date(row.paused_at).getTime())
    : 0;
  const pausedMs = Number(row.paused_ms || 0) + currentPauseMs;
  const elapsedMs = Math.max(0, endMs - startMs);
  return { elapsedMs, pausedMs, activeMs: Math.max(0, elapsedMs - pausedMs) };
}

export async function serializeGoal(
  db: Knex,
  redis: RedisClientType,
  source: GoalProjectionRow,
) {
  const output = await redis.get(`agent:output:${source.current_task_id}`) ?? '';
  const row = await refreshArtifacts(db, source, output);
  const live = output.trim() ? parseRedisOutput(output.split('\n').filter(Boolean)) : null;
  const latestHistory = await db('task_history')
    .where({ task_id: row.current_task_id })
    .orderBy('timestamp', 'desc')
    .first();
  const timing = goalTiming(row);
  return {
    id: row.goal_id,
    owner: row.owner_login,
    repository: row.repository,
    objective: row.objective,
    launchStrategy: row.launch_strategy,
    initialPrompt: row.initial_prompt,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    agent: { id: row.agent_id, alias: row.agent_alias, type: row.agent_type },
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    maxParallelTasks: row.max_parallel_tasks,
    ultrafix: row.ultrafix == null ? null : Boolean(row.ultrafix),
    desiredState: row.desired_state,
    resultState: row.result_state,
    failureReason: row.failure_reason,
    pausePending: row.desired_state === 'paused' && !row.pause_confirmed_at,
    taskId: row.current_task_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    finalPr: row.final_pr_url ? { number: row.final_pr_number, url: row.final_pr_url } : null,
    artifacts: parseGoalArtifacts(row.artifact_refs as string | null),
    artifactStats: parseStats(row.artifact_stats),
    liveSummary: {
      currentTask: live?.currentTask ?? null,
      todos: live?.todos ?? [],
      tokenUsage: live?.tokenUsage ?? null,
      nativeGoal: live?.nativeGoal ?? null,
    },
    taskState: latestHistory?.state ?? 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
    ...timing,
  };
}
