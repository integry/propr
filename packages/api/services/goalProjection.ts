import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import {
  parseGoalArtifacts,
  type GoalArtifactStats,
  type GoalLaunchStrategy,
} from '@propr/core';
import { projectTaskLiveDetails } from '../routes/liveDetailsRoutes.js';

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
  create_idempotency_operation: string | null;
  create_payload_hash: string | null;
  control_generation: number;
  control_ack_generation: number;
  task_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  paused_at: string | null;
  paused_ms: number;
  completed_at: string | null;
  checkpoint_interval_minutes: number | null;
  last_checkpoint_at: string | null;
  last_checkpoint_commit_sha: string | null;
  checkpoint_count: number;
  checkpoint_error: string | null;
}

function parseStats(value: GoalProjectionRow['artifact_stats']): GoalArtifactStats {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as GoalArtifactStats; } catch { /* use zero projection */ }
  }
  return { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 };
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

function checkpointProjection(
  row: GoalProjectionRow,
  latestCheckpoint: Record<string, unknown> | undefined,
  pendingCheckpoint: Record<string, unknown> | undefined,
) {
  if (row.launch_strategy !== 'direct') return null;
  return {
    intervalMinutes: row.checkpoint_interval_minutes,
    count: Number(row.checkpoint_count || 0),
    lastAt: row.last_checkpoint_at,
    lastCommitSha: row.last_checkpoint_commit_sha,
    error: row.checkpoint_error,
    pending: Boolean(pendingCheckpoint),
    latest: latestCheckpoint ? {
      kind: latestCheckpoint.kind,
      state: latestCheckpoint.state,
      commitSha: latestCheckpoint.commit_sha,
      error: latestCheckpoint.error,
      createdAt: latestCheckpoint.created_at,
      completedAt: latestCheckpoint.completed_at,
    } : null,
  };
}

function liveSummary(live: Awaited<ReturnType<typeof projectTaskLiveDetails>>) {
  return {
    currentTask: live?.currentTask ?? null,
    todos: live?.todos ?? [],
    tokenUsage: live?.tokenUsage ?? null,
    nativeGoal: live?.nativeGoal ?? null,
  };
}

export async function serializeGoal(
  db: Knex,
  redis: RedisClientType,
  source: GoalProjectionRow,
) {
  const row = source;
  const live = await projectTaskLiveDetails(redis, db, row.current_task_id, row.session_id);
  const latestHistory = await db('task_history')
    .where({ task_id: row.current_task_id })
    .orderBy('timestamp', 'desc')
    .first();
  const latestCheckpoint = row.launch_strategy === 'direct'
    ? await db('goal_checkpoints').where({ goal_id: row.goal_id, owner_id: row.owner_id })
      .orderBy('created_at', 'desc').first()
    : null;
  const pendingCheckpoint = row.launch_strategy === 'direct'
    ? await db('goal_checkpoints').where({ goal_id: row.goal_id, owner_id: row.owner_id })
      .whereIn('state', ['pending', 'processing']).first('checkpoint_id')
    : null;
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
    control: {
      requestGeneration: Number(row.control_generation || 0),
      acknowledgedGeneration: Number(row.control_ack_generation || 0),
      pending: Number(row.control_ack_generation || 0) < Number(row.control_generation || 0),
    },
    taskId: row.current_task_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    finalPr: row.final_pr_url ? { number: row.final_pr_number, url: row.final_pr_url } : null,
    checkpoint: checkpointProjection(row, latestCheckpoint, pendingCheckpoint),
    artifacts: parseGoalArtifacts(row.artifact_refs as string | null),
    artifactStats: parseStats(row.artifact_stats),
    liveSummary: liveSummary(live),
    taskState: latestHistory?.state ?? 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
    ...timing,
  };
}
