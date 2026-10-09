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

const opaque43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The instance a pairing is bound to; the client sends it and the server echoes it. */
const desktopPairingBinding = {
  instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).describe('`publicInstanceIdentity.instanceId` from discovery.'),
  origin: z.string().describe('Canonical API origin the client discovered, for example `https://propr.example.com`.'),
  scope: z.literal('desktop-instance'),
  credentialGeneration: z.string().regex(/^[A-Za-z0-9_-]{22}$/).describe('Client-chosen generation that identifies this credential.'),
};

export const DesktopPairingStartRequest = component('DesktopPairingStartRequest', z.object({
  clientName: z.string().min(1).max(80).describe('Shown on the approval page; 1 to 80 printable characters.'),
  ...desktopPairingBinding,
}), 'Starts a pairing for the instance named by the binding fields.');

export const DesktopPairingStart = component('DesktopPairingStart', z.object({
  pairingId: z.string().regex(/^dpr_[A-Za-z0-9_-]{22}$/),
  deviceSecret: opaque43.describe('Secret the client presents on every later pairing request. Never shown to the browser.'),
  approvalUrl: z.string().describe('Same-origin URL the user opens to approve the pairing.'),
  expiresAt: isoDateTime.describe('The pairing expires at this time, at most 30 minutes after it started.'),
  interval: z.number().int().min(1).max(60).describe('Seconds to wait between polls.'),
}), 'A started pairing.');

export const DesktopPairingPollRequest = component('DesktopPairingPollRequest', z.object({
  deviceSecret: opaque43,
}));

export const DesktopPairingPending = component('DesktopPairingPending', z.object({
  status: z.literal('pending'),
  interval: z.number().int().min(1).max(60).describe('Seconds to wait before the next poll.'),
}), 'The pairing is not approved yet (HTTP 202).');

export const DesktopPairingProvisional = component('DesktopPairingProvisional', z.object({
  status: z.literal('provisional'),
  token: z.string().regex(/^propr_it_[A-Za-z0-9_-]{43}$/).describe('Instance token. It works only after the pairing is activated.'),
  tokenType: z.literal('Bearer'),
  activationTicket: opaque43,
  activationExpiresAt: isoDateTime.describe('Activate or cancel before this time.'),
  ...desktopPairingBinding,
}), 'The pairing was approved and a provisional instance token was issued (HTTP 200).');

export const DesktopPairingPoll = component('DesktopPairingPoll',
  z.union([DesktopPairingPending, DesktopPairingProvisional]), 'State of a pairing, by `status`.');

export const DesktopPairingTicket = component('DesktopPairingTicket', z.object({
  deviceSecret: opaque43,
  activationTicket: opaque43.describe('`activationTicket` from the provisional poll response.'),
  ...desktopPairingBinding,
}), 'Proof of a provisional pairing, used to activate or cancel it.');

export const DesktopPairingActivationReceipt = component('DesktopPairingActivationReceipt', z.object({
  status: z.literal('active'),
  receipt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  activatedAt: isoDateTime,
  expiresAt: isoDateTime.nullable().describe('When the instance token expires; `null` when it does not.'),
}), 'The instance token is active.');

export const DesktopPairingCancellation = component('DesktopPairingCancellation', z.object({
  status: z.literal('cancelled'),
  cancelledAt: isoDateTime,
}), 'The provisional instance token was revoked.');

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

export const AttributedUser = component('AttributedUser', z.object({
  id: z.string().describe('Stable GitHub numeric user id.'),
  login: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
}), 'A GitHub user work is assigned or attributed to.');

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
  assignees: z.array(AttributedUser).describe('Assignees of the GitHub issue or pull request, as last synced; empty when nobody is assigned.'),
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
  instruction: z.string().min(1).max(50_000).regex(/\S/).describe('What the agent should do; becomes the GitHub issue body. Must not be only whitespace.'),
  agentAlias: z.string().optional().describe('Agent to route to. Omit to use the instance default.'),
  model: z.string().optional().describe('Model of the agent. Omit to use the agent default.'),
  todoIds: z.array(z.string()).optional().describe('Repository to-dos this submission resolves.'),
  autoMerge: z.boolean().optional(),
  runUltrafix: z.boolean().optional(),
  ultrafixGoal: z.number().int().min(1).max(10).optional().describe('Requires `runUltrafix: true`.'),
  ultrafixMaxCycles: z.number().int().min(1).max(10).optional().describe('Requires `runUltrafix: true`.'),
  maxCostUsd: z.number().min(0).max(MAX_RUN_COST_CAP_USD).optional().describe('Per-task spend cap in USD; 0 or omitted uses the repository or instance cap.'),
}).refine(body => body.runUltrafix === true || (body.ultrafixGoal === undefined && body.ultrafixMaxCycles === undefined), {
  message: 'runUltrafix must be true when ultrafixGoal or ultrafixMaxCycles is set',
}).meta({
  // The refinement above, for JSON Schema consumers.
  dependentSchemas: Object.fromEntries(['ultrafixGoal', 'ultrafixMaxCycles'].map(option => [option, {
    required: ['runUltrafix'],
    properties: { runUltrafix: { const: true } },
  }])),
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

/**
 * Query parameter sets. These are not schema components: each property becomes
 * a parameter. The id names the one generated client type, so routes that share
 * a set (for example an alias path) share the type.
 */
export const apiQuerySets = z.registry<{ id: string }>();

function querySet<T extends z.ZodObject>(id: string, schema: T): T {
  apiQuerySets.add(schema, { id });
  return schema;
}

export const ListTasksQuery = querySet('ListTasksQuery', z.object({
  status: z.string().optional().describe('`all` (default), `active`, `waiting`, `attention`, or a worker state.'),
  repository: z.string().optional().describe('`owner/name`, or `all` (default).'),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1000).optional().describe('Page size; defaults to 50.'),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  forReview: z.enum(['true', 'false']).optional().describe('Only runs whose pull request awaits review.'),
  excludeMerged: z.enum(['true', 'false']).optional(),
  groupBy: z.literal('task').optional().describe('Page by task instead of by run.'),
  task: z.string().optional().describe('With `groupBy=task`: only the task this run belongs to.'),
  assignee: z.string().optional().describe('`all` (default), `me` (the signed-in user), `unassigned`, or comma-separated GitHub logins.'),
  syncAssignees: z.enum(['true', 'false']).optional().describe('With `task`: refresh that run\'s assignees from GitHub first.'),
}));

export const DeleteTaskQuery = querySet('DeleteTaskQuery', z.object({
  force: z.enum(['true', 'false']).optional().describe('Delete even when the task is still active.'),
}));
