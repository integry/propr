import { z } from 'zod';
import type { TaskSubmission } from '@propr/core';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import type { Operation } from './operations.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, idSchema, ok } from './tools.js';
import { reconcileTerminalSubmissionProgress, submissionProgress, type SubmissionProgress, type SubmissionProgressStage } from './submissionProgress.js';

interface SubmissionResult {
  id: string;
  state: TaskSubmission['state'];
  issueNumber: number | null;
  issueUrl: string | null;
  taskId: string | null;
  error: string | null;
  progress: SubmissionProgress;
}

function submissionResult(data: SubmissionResult) {
  return { ...data, submissionId: data.id, submissionState: data.state,
    state: data.state === 'creating' && data.error ? 'unknown'
      : data.state === 'prepared' && data.error ? 'failed'
        : ['queued', 'failed'].includes(data.state) ? data.state : 'accepted',
    continuation: { submissionId: data.id, ...(data.taskId ? { taskId: data.taskId } : {}) },
  };
}

export function addTaskSubmissionTools(tools: McpTool[], deps: ToolDeps): void {
  const routes = createTaskSubmissionRoutes({ db: deps.db, services: deps.taskSubmissionServices });
  const shape = { repository: repositorySchema.toLowerCase(), submissionId: z.uuid() };
  const target = { table: 'task_submissions', column: 'id', arg: 'submissionId', owner: 'user_id' };
  tools.push({ name: 'create_task', description: 'Create a GitHub issue and immediately START an ordinary one-off task, without a plan or goal. Uses configured agent/model defaults unless overridden. Set runUltrafix to run the review/fix loop on the resulting pull request as soon as it opens, and autoMerge to merge it once it is ready; ultrafixGoal and ultrafixMaxCycles apply only when runUltrafix is true and ultrafix is bounded to 10 cycles. Keep the idempotencyKey stable. Follow progress with get_task_submission (task state and pull request) instead of polling list_tasks.', scope: 'execute',
    schema: z.object({ ...mutationShape, repository: shape.repository,
      instruction: z.string().min(1).max(50000).refine(value => !!value.trim(), 'Instruction must not be blank.'),
      agentAlias: idSchema.optional(), model: idSchema.optional(), autoMerge: z.boolean().default(false),
      runUltrafix: z.boolean().default(false), ultrafixGoal: z.number().int().min(1).max(10).default(9),
      ultrafixMaxCycles: z.number().int().min(1).max(10).default(3),
    }).strict(), run: async ({ principal, args, operationId }) => {
      if (args.autoMerge) deps.policy.requireScope(principal, 'merge');
      if (args.runUltrafix) deps.policy.requireScope(principal, 'review');
      const response = await callWorkflow(routes.submit, principal, {
        body: { repository: args.repository, instruction: args.instruction, agentAlias: args.agentAlias, model: args.model,
          autoMerge: args.autoMerge, runUltrafix: args.runUltrafix,
          // Bounds travel only with the opt-in, exactly as implement_plan records them.
          ...(args.runUltrafix ? { ultrafixGoal: args.ultrafixGoal, ultrafixMaxCycles: args.ultrafixMaxCycles } : {}) },
        // The operation identity isolates submission keys across clients/grants and the UI.
        idempotencyKey: `mcp-${operationId}`,
      });
      const data = response.data as SubmissionResult;
      return { status: 202, data: await projectSubmission(deps,
        await ownedSubmission(deps, principal, args.repository, data.id)) };
    } });
  tools.push({ name: 'get_task_submission', description: 'Read your direct task submission with its current issue, latest task state, failure reason and pull request. Does not retry or start work.', scope: 'read', readOnly: true,
    schema: z.object(shape).strict(), target, run: async ({ principal, args }) => {
      const row = await ownedSubmission(deps, principal, args.repository, args.submissionId);
      return ok(await projectSubmission(deps, row));
    } });
  tools.push({ name: 'retry_task_submission', description: 'Recover your existing direct task submission: reconcile uncertain issue creation or retry dispatch of the same issue. Does not create a replacement task for an already queued submission. Use a new mutation idempotencyKey for this retry.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...shape }).strict(), target, run: async ({ principal, args }) => {
      const row = await ownedSubmission(deps, principal, args.repository, args.submissionId);
      const response = await callWorkflow(routes.retry, principal, { params: { key: row.submission_key } });
      const data = response.data as SubmissionResult;
      return { status: 202, data: await projectSubmission(deps,
        await ownedSubmission(deps, principal, args.repository, data.id)) };
    } });
  const stageSchema = z.enum(['active', 'submitted', 'issue_created', 'queued', 'running', 'completed', 'failed', 'cancelled']);
  tools.push({ name: 'list_task_submissions', description: 'List your recent direct task submissions newest first, including task and pull request progress.', scope: 'read', readOnly: true,
    schema: z.object({ repository: shape.repository.optional(), stage: stageSchema.optional(),
      sinceMinutes: z.number().int().min(1).max(10080).default(1440),
      offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20),
    }).strict(), run: async ({ principal, args }) => {
      const query = deps.db<TaskSubmission>('task_submissions').where({ user_id: principal.user.id })
        .whereRaw('created_at >= datetime(?)', [new Date(Date.now() - args.sinceMinutes * 60_000).toISOString()]);
      if (args.repository) query.andWhere({ repository: args.repository });
      else query.whereIn('repository', principal.grant.repositories.map(repository => repository.toLowerCase()));
      const ordered = query.orderBy('created_at', 'desc').orderBy('id', 'desc');
      if (!args.stage) {
        const rows = await ordered.offset(args.offset).limit(args.limit + 1);
        return ok({ submissions: await Promise.all(rows.slice(0, args.limit).map(row => projectSubmission(deps, row))),
          nextOffset: rows.length > args.limit ? args.offset + args.limit : null });
      }
      const matching: Awaited<ReturnType<typeof projectSubmission>>[] = [];
      const wanted = args.offset + args.limit + 1;
      const batchSize = Math.max(50, args.limit);
      let databaseOffset = 0;
      while (matching.length < wanted) {
        const rows = await ordered.clone().offset(databaseOffset).limit(batchSize);
        if (!rows.length) break;
        databaseOffset += rows.length;
        const projected = await Promise.all(rows.map(row => projectSubmission(deps, row)));
        matching.push(...projected.filter(item => stageMatches(item.progress.stage, args.stage)));
        if (rows.length < batchSize) break;
      }
      return ok({ submissions: matching.slice(args.offset, args.offset + args.limit),
        nextOffset: matching.length > args.offset + args.limit ? args.offset + args.limit : null });
    } });
}

function stageMatches(stage: SubmissionProgressStage, filter: SubmissionProgressStage | 'active'): boolean {
  return filter === 'active' ? ['submitted', 'issue_created', 'queued', 'running'].includes(stage) : stage === filter;
}

async function ownedSubmission(deps: ToolDeps, principal: McpPrincipal, repository: string, id: string): Promise<TaskSubmission> {
  const row = await deps.db<TaskSubmission>('task_submissions').where({ id, user_id: principal.user.id, repository }).first();
  if (!row) throw new McpError('NOT_FOUND', 'Task submission not found.', 404);
  return row;
}

async function projectSubmission(deps: ToolDeps, row: TaskSubmission) {
  const progress = await submissionProgress(deps.db, row);
  const taskId = progress.task?.id ?? row.latest_task_id ?? row.task_id;
  return submissionResult({ id: row.id, state: row.state, issueNumber: row.issue_number,
    issueUrl: row.issue_url, taskId, error: row.error, progress });
}

function resolvedTaskId(result: Record<string, unknown>): string | undefined {
  const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const target = object(result.targetState);
  const continuation = object(result.continuation);
  const task = object(object(result.progress)?.task);
  return [target?.taskId, target?.task_id, continuation?.taskId, result.taskId, task?.id]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
}

async function projectOperationSubmission(deps: ToolDeps, submission: TaskSubmission, result: Record<string, unknown>) {
  // Submission reads follow the latest retry, but a mutation receipt keeps the
  // execution it already discovered (or the submission's first execution).
  const boundTaskId = resolvedTaskId(result) ?? submission.task_id ?? undefined;
  const current = await projectSubmission(deps, boundTaskId
    ? { ...submission, task_id: boundTaskId, latest_task_id: boundTaskId }
    : submission);
  return { current, taskId: boundTaskId ?? current.progress.task?.id ?? current.taskId ?? undefined };
}

/** Submission acceptance precedes task association; polling must discover the exact task. */
export async function trackTaskSubmission(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!['create_task', 'retry_task_submission'].includes(row.tool) || !row.result) return;
  const result = JSON.parse(row.result);
  if (!result.submissionId) return;
  const submission = await ownedSubmission(deps, principal, row.repository!, result.submissionId);
  if (result.executionResolved) {
    // A terminal receipt belongs to one execution even when the submission's
    // latest task advances to a retry. Refresh only late issue/PR information
    // projected from that resolved task, retaining its terminal progress.
    const taskId = resolvedTaskId(result);
    const resolved = taskId
      ? await projectSubmission(deps, { ...submission, task_id: taskId, latest_task_id: taskId })
      : undefined;
    const projectedProgress = result.progress && resolved
      ? { ...result.progress, issue: resolved.progress.issue ?? result.progress.issue,
        pullRequest: resolved.progress.pullRequest ?? result.progress.pullRequest }
      : result.progress ?? resolved?.progress;
    const targetState = result.targetState && typeof result.targetState === 'object' && !Array.isArray(result.targetState)
      ? result.targetState as Record<string, unknown> : undefined;
    const progress = reconcileTerminalSubmissionProgress(projectedProgress, targetState, row.state);
    const refreshed = { ...result, ...(progress ? { progress } : {}), executionResolved: true, targetState: result.targetState };
    receipt.result = refreshed;
    receipt.targetState = result.targetState;
    await deps.db('mcp_operations').where({ id: row.id }).update({ result: JSON.stringify(refreshed), updated_at: Date.now() });
    return;
  }
  const { current, taskId } = await projectOperationSubmission(deps, submission, result);
  if (taskId) { current.taskId = taskId; current.continuation.taskId = taskId; }
  receipt.state = current.state;
  receipt.result = current;
  receipt.targetState = { submissionId: submission.id, state: current.progress.stage, taskId,
    pullRequest: current.progress.pullRequest?.number };
  // Feed the newly associated task into ordinary execution tracking in this same poll.
  row.result = JSON.stringify(current);
  row.state = current.state;
  await deps.db('mcp_operations').where({ id: row.id }).whereNotIn('state', ['completed', 'failed', 'cancelled'])
    .update({ state: row.state, result: row.result, updated_at: Date.now() });
}
