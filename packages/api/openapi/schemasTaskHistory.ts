import { z } from 'zod';
import { component } from './schemas.js';

/** Schemas of the task history read (`GET /api/task/{taskId}/history`), including replacement lineage. */

export const TaskEvent = component('TaskEvent', z.object({
  state: z.string().describe('Lifecycle state entered at this point.'),
  timestamp: z.string().describe('When the state was entered (ISO 8601).'),
  reason: z.string().nullable().optional(),
  message: z.string().optional(),
  metadata: z.object({}).loose().nullable().optional(),
}).loose(), 'One entry of a task\'s lifecycle history.');

const nullableText = z.string().nullable().optional();

export const TaskAttempt = component('TaskAttempt', z.object({
  taskId: z.string(),
  attemptNumber: z.number().int().min(1).describe('1 for the original run, then 2, 3, … for each automatic replacement.'),
  replacementCause: z.string().nullable().describe('Why this attempt was created: `infra_lost` or `provider_transient`. Null for the original run.'),
  state: z.string().nullable().describe('Latest lifecycle state of the attempt.'),
  createdAt: z.string().nullable(),
}), 'One attempt of an automatic-replacement lineage.');

export const TaskInfo = component('TaskInfo', z.object({
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  number: z.number().int().nullable().optional().describe('Pull request number for follow-up tasks, otherwise the issue number.'),
  type: z.string().optional().describe('`issue`, `pr-comment`, `goal`, `agent-run` and other task types.'),
  issueNumber: z.number().int().optional().describe('The issue a pull request follow-up task belongs to.'),
  correlationId: nullableText,
  title: nullableText,
  subtitle: nullableText,
  modelName: nullableText,
  agentAlias: nullableText,
  taskKind: z.string().optional().describe('Automation task kind, for automation report and action tasks.'),
  commandMode: z.string().optional(),
  ultrafixCycle: z.literal(true).optional(),
  comments: z.array(z.unknown()).optional().describe('Comments a live or queued follow-up task carries.'),
  followupTarget: z.object({
    taskId: z.string(), repository: z.string(), kind: z.enum(['issue', 'pull_request']), number: z.number().int(),
  }).optional().describe('Where `POST /api/task/{taskId}/followup` posts.'),
  attemptNumber: z.number().int().min(1).optional().describe('Automatic-replacement attempt number; 1 for an original run. Present for every stored task.'),
  replacesTaskId: z.string().nullable().optional().describe('The earlier attempt this task replaced, or null. Present for every stored task.'),
  replacedByTaskId: z.string().nullable().optional().describe('The newer attempt that replaced this task, or null. Present for every stored task.'),
  attemptLineage: z.array(TaskAttempt).optional().describe('Every attempt of the lineage, oldest first; only when the task was replaced or is a replacement.'),
}), 'Repository, issue, pull request, agent and replacement-lineage details of a task. Live and queued tasks without a stored row omit the lineage fields.');

export const TaskHistory = component('TaskHistory', z.object({
  taskId: z.string(),
  history: z.array(TaskEvent).describe('Lifecycle events, oldest first.'),
  taskInfo: TaskInfo.nullable(),
  budget: z.object({}).loose().optional().describe('Spend so far against the task\'s cost cap, when a cap applies.'),
}).loose(), 'A task together with its lifecycle events.');
