import { z } from 'zod';
import type { TaskSubmission } from '@propr/core';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import type { Operation } from './operations.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, idSchema, ok } from './tools.js';

interface SubmissionResult {
  id: string;
  state: TaskSubmission['state'];
  issueNumber: number | null;
  issueUrl: string | null;
  taskId: string | null;
  error: string | null;
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
  tools.push({ name: 'create_task', description: 'Create a GitHub issue and immediately START an ordinary one-off task, without a plan or goal. Uses configured agent/model defaults unless overridden. Keep the idempotencyKey stable; inspect the submission or operation before retrying.', scope: 'execute',
    schema: z.object({ ...mutationShape, repository: shape.repository,
      instruction: z.string().min(1).max(50000).refine(value => !!value.trim(), 'Instruction must not be blank.'),
      agentAlias: idSchema.optional(), model: idSchema.optional(),
    }).strict(), run: async ({ principal, args, operationId }) => {
      const response = await callWorkflow(routes.submit, principal, {
        body: { repository: args.repository, instruction: args.instruction, agentAlias: args.agentAlias, model: args.model },
        // The operation identity isolates submission keys across clients/grants and the UI.
        idempotencyKey: `mcp-${operationId}`,
      });
      return { status: 202, data: submissionResult(response.data as SubmissionResult) };
    } });
  tools.push({ name: 'get_task_submission', description: 'Read your direct task submission, GitHub issue link and exact taskId once execution is associated. Does not retry or start work.', scope: 'read', readOnly: true,
    schema: z.object(shape).strict(), target, run: async ({ principal, args }) => {
      const row = await ownedSubmission(deps, principal, args.repository, args.submissionId);
      return ok(projectSubmission(row));
    } });
  tools.push({ name: 'retry_task_submission', description: 'Recover your existing direct task submission: reconcile uncertain issue creation or retry dispatch of the same issue. Does not create a replacement task for an already queued submission. Use a new mutation idempotencyKey for this retry.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...shape }).strict(), target, run: async ({ principal, args }) => {
      const row = await ownedSubmission(deps, principal, args.repository, args.submissionId);
      const response = await callWorkflow(routes.retry, principal, { params: { key: row.submission_key } });
      return { status: 202, data: submissionResult(response.data as SubmissionResult) };
    } });
}

async function ownedSubmission(deps: ToolDeps, principal: McpPrincipal, repository: string, id: string): Promise<TaskSubmission> {
  const row = await deps.db<TaskSubmission>('task_submissions').where({ id, user_id: principal.user.id, repository }).first();
  if (!row) throw new McpError('NOT_FOUND', 'Task submission not found.', 404);
  return row;
}

function projectSubmission(row: TaskSubmission) {
  return submissionResult({ id: row.id, state: row.state, issueNumber: row.issue_number,
    issueUrl: row.issue_url, taskId: row.task_id, error: row.error });
}

/** Submission acceptance precedes task association; polling must discover the exact task. */
export async function trackTaskSubmission(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!['create_task', 'retry_task_submission'].includes(row.tool) || !row.result) return;
  const result = JSON.parse(row.result);
  if (!result.submissionId || result.executionResolved) return;
  const submission = await ownedSubmission(deps, principal, row.repository!, result.submissionId);
  const current = projectSubmission(submission);
  const taskId = result.continuation?.taskId || submission.task_id;
  if (taskId) { current.taskId = taskId; current.continuation.taskId = taskId; }
  receipt.state = current.state;
  receipt.result = current;
  receipt.targetState = { submissionId: submission.id, state: submission.state, taskId };
  // Feed the newly associated task into ordinary execution tracking in this same poll.
  row.result = JSON.stringify(current);
  row.state = current.state;
  await deps.db('mcp_operations').where({ id: row.id }).update({ state: row.state, result: row.result, updated_at: Date.now() });
}
