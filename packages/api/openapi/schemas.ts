import { z } from 'zod';
import { INSTANCE_PERMISSIONS, MAX_RUN_COST_CAP_USD } from '@propr/shared';

/**
 * Request and response schemas for the dashboard HTTP API reference.
 *
 * Every schema registered in `apiSchemas` becomes a named component in
 * `docs/static/openapi/propr-api.yaml` and a generated type in
 * `packages/client/src/generated/apiTypes.ts`, so the published spec and the
 * `@propr/client` types come from this one source. Zod is the validation library
 * the API already uses (MCP tool inputs); do not introduce a second one here.
 *
 * Response shapes that grew out of database rows are declared `.loose()`: the
 * listed fields are the stable contract and further fields may appear.
 */
export const apiSchemas = z.registry<{ id: string }>();

function component<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  const described = (description ? schema.describe(description) : schema) as T;
  apiSchemas.add(described, { id });
  return described;
}

const isoDateTime = z.string().meta({ format: 'date-time' });

export const ErrorEnvelope = component('ErrorEnvelope', z.object({
  code: z.string().describe('Stable, machine-readable error code, for example `TASK_NOT_FOUND`.'),
  message: z.string().describe('Human-readable explanation that is safe to show to an operator.'),
  hint: z.string().optional().describe('Optional next step that resolves the error.'),
}), 'The common error envelope. New routes return it for every 4xx and 5xx response.');

export const LegacyError = component('LegacyError', z.object({
  error: z.string().describe('Human-readable error message.'),
  code: z.string().optional().describe('Machine-readable code, present on authentication and some validation errors.'),
  message: z.string().optional().describe('Longer explanation, present on some authentication errors.'),
}).loose(), 'The ad-hoc error shape most existing routes return. Operations that use it carry `x-legacy-error: true`.');

export const Health = component('Health', z.object({
  status: z.literal('ok'),
}), 'Liveness probe result.');

export const DesktopAuthenticationCapabilities = component('DesktopAuthenticationCapabilities', z.object({
  protocolVersion: z.literal(2),
  browserPairing: z.boolean(),
  instanceBearerTokens: z.boolean(),
  socketIoBearerAuthentication: z.boolean(),
}));

export const Compatibility = component('Compatibility', z.object({
  version: z.string().describe('ProPR release version of the API server.'),
  apiCompatibility: z.string().describe('API compatibility date clients negotiate against.'),
  uiCompatibility: z.string().describe('Oldest web UI compatibility date the API accepts.'),
  desktopAuthentication: DesktopAuthenticationCapabilities,
}), 'Version and capability metadata used for client compatibility negotiation.');

export const DesktopDiscovery = component('DesktopDiscovery', z.object({
  schemaVersion: z.number().int(),
  product: z.literal('ProPR'),
  canonicalEndpoint: z.string().nullable(),
  publicInstanceIdentity: z.object({}).loose().nullable(),
  version: z.string(),
  apiCompatibility: z.string(),
  uiCompatibility: z.string(),
  desktopAuthentication: DesktopAuthenticationCapabilities,
}).loose(), 'Public, credential-free discovery metadata for desktop and CLI pairing.');

export const AuthenticatedUser = component('AuthenticatedUser', z.object({
  id: z.string(),
  login: z.string(),
  username: z.string(),
  displayName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  role: z.enum(['admin', 'member']),
  permissions: z.array(z.enum(INSTANCE_PERMISSIONS)),
  authorizationSource: z.enum(['bootstrap', 'local', 'managed', 'implicit', 'demo']),
}), 'The signed-in GitHub user and their instance role.');

export const DemoModeStatus = component('DemoModeStatus', z.object({
  demoMode: z.boolean(),
}));

export const TaskSummary = component('TaskSummary', z.object({
  id: z.string().describe('Task (run) identifier.'),
  issueId: z.string().describe('Same value as `id`; kept for older clients.'),
  repository: z.string().describe('`owner/name` of the repository.'),
  repositoryOwner: z.string().nullable(),
  repositoryName: z.string().nullable(),
  issueNumber: z.number().int().nullable(),
  prNumber: z.number().int().nullable(),
  linkedIssueNumber: z.number().int().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  status: z.string().describe('Worker lifecycle state, for example `processing`, `completed` or `failed`.'),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  processedAt: isoDateTime.nullable(),
  failedReason: z.string().nullable(),
  commitHash: z.string().nullable(),
  progress: z.number().describe('Coarse progress percentage: 0, 50 or 100.'),
  modelName: z.string().nullable(),
  llmProvider: z.string().nullable(),
  planIssueStatus: z.string().nullable(),
  score: z.number().nullable().describe('Final review score of the run, when it was reviewed.'),
}).loose(), 'One task run as listed by `GET /api/tasks`.');

export const TaskPage = component('TaskPage', z.object({
  tasks: z.array(TaskSummary),
  total: z.number().int().describe('Matching runs, or matching tasks with `groupBy=task`.'),
  offset: z.number().int(),
  limit: z.number().int(),
  totalRuns: z.number().int().optional().describe('With `groupBy=task`: matching runs across all tasks.'),
}), 'A page of task runs.');

export const TaskEvent = component('TaskEvent', z.object({
  state: z.string().describe('Lifecycle state entered at this point.'),
  timestamp: z.string().describe('When the state was entered (ISO 8601).'),
  reason: z.string().nullable().optional(),
  message: z.string().optional(),
  metadata: z.object({}).loose().nullable().optional(),
}).loose(), 'One entry of a task\'s lifecycle history.');

export const TaskHistory = component('TaskHistory', z.object({
  taskId: z.string(),
  history: z.array(TaskEvent).describe('Lifecycle events, oldest first.'),
  taskInfo: z.object({}).loose().nullable().describe('Repository, issue, pull request and agent details of the task.'),
  budget: z.object({}).loose().optional().describe('Spend so far against the task\'s cost cap, when a cap applies.'),
}).loose(), 'A task together with its lifecycle events.');

export const TaskSubmissionRequest = component('TaskSubmissionRequest', z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('`owner/name` of an enabled repository you can push to.'),
  instruction: z.string().min(1).max(50_000).describe('What the agent should do; becomes the GitHub issue body.'),
  agentAlias: z.string().optional().describe('Agent to route to. Omit to use the instance default.'),
  model: z.string().optional().describe('Model of the agent. Omit to use the agent default.'),
  todoIds: z.array(z.string()).optional().describe('Repository to-dos this submission resolves.'),
  autoMerge: z.boolean().optional(),
  runUltrafix: z.boolean().optional(),
  ultrafixGoal: z.number().int().min(1).max(10).optional().describe('Requires `runUltrafix: true`.'),
  ultrafixMaxCycles: z.number().int().min(1).max(10).optional().describe('Requires `runUltrafix: true`.'),
  maxCostUsd: z.number().min(0).max(MAX_RUN_COST_CAP_USD).optional().describe('Per-task spend cap in USD; 0 or omitted uses the repository or instance cap.'),
}), 'A request to open a GitHub issue and start an implementation run for it.');

export const TaskSubmission = component('TaskSubmission', z.object({
  id: z.string(),
  state: z.enum(['prepared', 'creating', 'issue_created', 'queued', 'failed']),
  issueNumber: z.number().int().nullable(),
  issueUrl: z.string().nullable(),
  taskId: z.string().nullable(),
  error: z.string().nullable(),
}), 'Progress of a task submission. `queued` means the run was enqueued.');

export const TaskFollowupRequest = component('TaskFollowupRequest', z.object({
  body: z.string().min(1).max(65_536).describe('Comment text posted on the task\'s pull request or issue.'),
  target: z.literal('pull_request').optional().describe('Force the comment onto the pull request.'),
}));

export const TaskFollowupResult = component('TaskFollowupResult', z.object({
  success: z.boolean(),
  state: z.enum(['queued', 'unknown']),
  posted: z.boolean(),
  commentId: z.number().int(),
  jobId: z.string(),
  sourceTaskId: z.string(),
  message: z.string().optional().describe('Present when the queue submission could not be confirmed.'),
}), 'Result of posting a follow-up comment. `state: unknown` means inspect the job before retrying.');

export const NotificationUnreadCount = component('NotificationUnreadCount', z.object({
  unreadCount: z.number().int().min(0),
}));

/** Generic JSON object for documented routes whose body is not modelled yet. */
export const JsonObject = component('JsonObject', z.object({}).loose(), 'A JSON object whose fields are not documented yet.');

/* Query parameter sets. These are not components; each property becomes a parameter. */

export const ListTasksQuery = z.object({
  status: z.string().optional().describe('`all` (default), `active`, `waiting`, `attention`, or a worker state.'),
  repository: z.string().optional().describe('`owner/name`, or `all` (default).'),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1000).optional().describe('Page size; defaults to 50.'),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  forReview: z.enum(['true', 'false']).optional().describe('Only runs whose pull request awaits review.'),
  excludeMerged: z.enum(['true', 'false']).optional(),
  groupBy: z.literal('task').optional().describe('Page by task instead of by run.'),
  task: z.string().optional().describe('With `groupBy=task`: only the task this run belongs to.'),
});

export const DeleteTaskQuery = z.object({
  force: z.enum(['true', 'false']).optional().describe('Delete even when the task is still active.'),
});
