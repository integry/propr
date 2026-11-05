import { z } from 'zod';
import { extensionProfileInputSchema, extensionSelectionSchema, INSTANCE_PERMISSIONS, MAX_RUN_COST_CAP_USD, MAX_TASK_ASSIGNEES } from '@propr/shared';

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
  prState: z.literal('merged').optional().describe('`merged` once the run\'s pull request has been merged; absent otherwise.'),
  score: z.number().nullable().describe('Final review score of the run, when it was reviewed.'),
  reviewOutcome: z.enum(['clean', 'findings', 'reviewer_failed']).nullable().describe('What the review that recorded `score` came to: `clean` when every reviewer succeeded and none reported an actionable finding. Null when the run was not a review or its outcome is unknown.'),
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

export const ExtensionProfileInput = component('ExtensionProfileInput', extensionProfileInputSchema as unknown as z.ZodType, 'Strict shared v1 contract. Operator catalog descriptors accept only immutable catalogId/digest and selected tools/capability; customer commands, arguments, environment and mount paths are rejected.');
export const ExtensionSelection = component('ExtensionSelection', extensionSelectionSchema as unknown as z.ZodType);
export const ExtensionProfileSave = component('ExtensionProfileSave', z.strictObject({ input: ExtensionProfileInput, expected: ExtensionSelection.optional(), secrets: z.record(z.string(), z.string().nullable()).optional() }));

export const TaskSubmissionRequest = component('TaskSubmissionRequest', z.object({
  extensionProfile: ExtensionSelection.nullable().optional(),
  extensionAllowWrite: z.boolean().optional().describe('Explicit write grant for this exact authenticated coding submission and initial run; omitted is false. Requires an extension selection. Never inherited by label retries.'),
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
  state: z.enum(['queued', 'batched', 'handled', 'refused', 'failed', 'unknown']),
  posted: z.boolean(),
  commentId: z.number().int(),
  jobId: z.string().optional(),
  sourceTaskId: z.string(),
  intent: z.literal('issue').optional().describe('Present when a failed implementation without a pull request was retried on its issue.'),
  issueNumber: z.number().int().optional().describe('The issue a retry was queued on.'),
  restartedRequest: z.object({
    state: z.enum(['queued', 'failed', 'unknown']),
    commentId: z.number().int().describe('The earlier request\'s comment, whose instructions the restarted run carries.'),
  }).optional().describe('Present when, instead of posting this follow-up, an earlier issue retry whose start was never confirmed was restarted for its own requester.'),
  message: z.string().optional().describe('Explains a refusal, failure, or uncertain submission.'),
}), 'Result of posting a follow-up comment. `state: unknown` means inspect the job before retrying.');

export const TaskFollowupRuns = component('TaskFollowupRuns', z.object({
  sourceTaskId: z.string(),
  commentId: z.number().int(),
  runs: z.array(z.object({
    taskId: z.string(),
    status: z.string().describe('The run\'s latest state, lowercased; `queued` until it records one.'),
  })).describe('Empty until the run the follow-up requested has started.'),
}), 'The runs an issue follow-up started, for the signed-in user who posted it.');

export const TaskReviewResult = component('TaskReviewResult', TaskFollowupResult.extend({
  commandMode: z.literal('review'),
  posted: z.boolean().optional(),
  commentId: z.number().int().optional(),
}), 'Idempotent review receipt. Only queued or batched confirms acceptance; unknown requires inspection.');

export const TaskSubject = component('TaskSubject', z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().describe('Issue or pull request number.'),
  kind: z.enum(['issue', 'pull_request']),
}), 'The GitHub issue or pull request a task is assigned through.');

export const TaskAssignees = component('TaskAssignees', z.object({
  subject: TaskSubject,
  assignees: z.array(AttributedUser),
  synced: z.boolean().describe('True when `assignees` was just read from GitHub; false when it is the stored set.'),
}), 'The assignees of a task\'s GitHub issue or pull request.');

export const TaskAssigneesUpdate = component('TaskAssigneesUpdate', z.object({
  logins: z.array(z.string()).max(MAX_TASK_ASSIGNEES).describe('GitHub logins to assign. With `replace`, an empty list clears the assignment.'),
  mode: z.enum(['add', 'replace']).optional().describe('`replace` (default) makes `logins` the whole set; `add` keeps current assignees.'),
}), 'A change to a task\'s assignees.');

export const TaskAssigneesResult = component('TaskAssigneesResult', z.object({
  subject: TaskSubject,
  assignees: z.array(AttributedUser).describe('The assignees GitHub confirmed.'),
  rejected: z.array(AttributedUser).describe('Requested users GitHub did not assign; empty on success.'),
}), 'The assignment GitHub confirmed after a change.');

export const AssignableUsers = component('AssignableUsers', z.object({
  users: z.array(AttributedUser),
  truncated: z.boolean().describe('True when the repository has more assignable users than were listed.'),
}), 'Users that can be assigned to issues and pull requests of a repository.');

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

export const TaskAssigneesQuery = querySet('TaskAssigneesQuery', z.object({
  refresh: z.enum(['true', 'false']).optional().describe('`false` serves the stored set without calling GitHub.'),
}));

export const DeleteTaskQuery = querySet('DeleteTaskQuery', z.object({
  force: z.enum(['true', 'false']).optional().describe('Delete even when the task is still active.'),
}));

export const TaskFollowupRunsQuery = querySet('TaskFollowupRunsQuery', z.object({
  commentId: z.string().regex(/^[1-9]\d{0,15}$/).describe('The `commentId` the follow-up\'s receipt returned.'),
}));

const storageCategory = z.enum(['database_config', 'repository_caches', 'worktrees', 'salvage', 'logs_artifacts', 'provider_credentials', 'task_history']);
const storageState = z.enum(['complete', 'partial', 'unknown', 'unsupported']);
const storageProtection = z.enum(['partial_generated_cleanup', 'busy', 'unknown_use', 'recent_use', 'unknown_ownership', 'unsafe_path', 'private_work', 'worktrees', 'local_history', 'salvage', 'remote_unavailable', 'unknown_git_state', 'changed', 'unsupported']);
const storagePolicy = z.object({ enabled: z.boolean(), idleHours: z.number().int().min(1).max(8760) });
export const InstanceStorageUsage = component('InstanceStorageUsage', z.object({
  version: z.literal(1), instanceId: z.string(), observedAt: isoDateTime.nullable(), state: storageState,
  scanning: z.boolean(), ownedBytes: z.number().nonnegative().nullable(),
  generatedPayloads: z.object({
    observedAt: isoDateTime.nullable(), reclaimableBytes: z.number().nonnegative().nullable(), coverage: z.string(),
    candidates: z.array(z.object({ id: z.string(), category: storageCategory, estimatedBytes: z.number().nonnegative().nullable(), protectedReasons: z.array(storageProtection) })).optional(),
    lastCleanup: z.record(z.string(), z.unknown()).nullable(),
  }).optional().describe('Last bounded generated-payload proof, protected reasons and durable result. Observations may be stale or partial; unregistered worktrees remain protected.'),
  categories: z.array(z.object({ category: storageCategory, bytes: z.number().nonnegative().nullable(), state: storageState })),
  filesystems: z.array(z.object({ id: z.string(), totalBytes: z.number().nonnegative(), availableBytes: z.number().nonnegative() })),
}));
export const InstanceStoragePolicy = component('InstanceStoragePolicy', z.object({ version: z.literal(1), instanceId: z.string(), policy: storagePolicy }));
export const InstanceStoragePolicyRequest = component('InstanceStoragePolicyRequest', storagePolicy.extend({ instanceId: z.string() }).strict());
export const InstanceStoragePreviewRequest = component('InstanceStoragePreviewRequest', z.object({ instanceId: z.string(), categories: z.array(storageCategory).min(1).max(7), taskIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/)).max(10).optional() }).strict());
export const InstanceStorageExecuteRequest = component('InstanceStorageExecuteRequest', z.object({ instanceId: z.string(), confirmation: z.uuid() }).strict());
export const InstanceStoragePreview = component('InstanceStoragePreview', z.object({
  version: z.literal(1), instanceId: z.string(), confirmation: z.uuid(), expiresAt: isoDateTime,
  categories: z.array(storageCategory), impact: z.string(),
  candidates: z.array(z.object({ id: z.string(), name: z.string().optional(), category: storageCategory, estimatedBytes: z.number().nonnegative().nullable(), protectedReasons: z.array(storageProtection) })),
}));
export const InstanceStorageResult = component('InstanceStorageResult', z.object({
  version: z.literal(1), instanceId: z.string(), operationId: z.uuid(), state: z.enum(['completed', 'interrupted']),
  deleted: z.array(z.string()), retained: z.array(z.object({ id: z.string(), reasons: z.array(storageProtection) })),
}));
export const InstanceStorageResultQuery = querySet('InstanceStorageResultQuery', z.object({ instanceId: z.string() }));
export const InstanceStorageCapabilities = component('InstanceStorageCapabilities', z.object({
  version: z.literal(1), instanceId: z.string(), generation: z.uuid(), features: z.array(z.enum(['repository_inventory', 'repository_cleanup', 'database_export'])),
}));
export const InstanceRepositoryInventory = component('InstanceRepositoryInventory', z.object({
  version: z.literal(1), instanceId: z.string(), state: storageState, observedAt: isoDateTime, lastUseAt: isoDateTime.nullable(),
  repositories: z.array(z.object({ id: z.string(), name: z.string(), category: storageCategory, estimatedBytes: z.number().nonnegative().nullable(), protectedReasons: z.array(storageProtection) })),
}));
export const InstanceDatabaseExportRequest = component('InstanceDatabaseExportRequest', z.object({ instanceId: z.string(), generation: z.uuid() }).strict());
export const InstanceDatabaseExportQuery = querySet('InstanceDatabaseExportQuery', z.object({ instanceId: z.string(), generation: z.uuid() }));
export const InstanceDatabaseExport = component('InstanceDatabaseExport', z.object({
  version: z.literal(1), instanceId: z.string(), generation: z.uuid(), operationId: z.uuid(),
  state: z.enum(['running', 'ready', 'failed', 'redeemed']), expiresAt: isoDateTime, scope: z.literal('customer_database'),
  sizeBytes: z.number().nonnegative().optional(), sha256: z.string().optional(), schemaVersion: z.number().int().optional(), migration: z.string().nullable().optional(),
}));

export const FollowupHandoffStatus = component('FollowupHandoffStatus', z.object({
  repository: z.string().describe('Lowercase `owner/repo` of the pull request the handoff belongs to.'),
  pullRequest: z.number().int().positive(),
  taskId: z.string().describe('Task whose interrupted follow-up publication the handoff records.'),
  predecessorTaskIds: z.array(z.string()).describe('Source task lineage recorded when the agent launched.'),
  successorTaskId: z.string().nullable().describe('Task that adopted the handoff during recovery, when any.'),
  phase: z.enum(['agent_running', 'agent_exited', 'committed', 'pushed', 'comment_published', 'cleanup_pending'])
    .describe('Exact publication step recovery resumes from. `cleanup_pending` means everything is published and only branch release is owed.'),
  status: z.enum(['active', 'awaiting_operator', 'released'])
    .describe('`active` records are recovered automatically; `awaiting_operator` records never publish without an explicit operator decision.'),
  statusReason: z.string().nullable().describe('Why the handoff is held or failed closed, for example `cancelled_by_user`, `worktree_missing`, `head_advanced_externally`, `usage_limit_retry_unconfirmed`, `liveness_unavailable`. A mutable diagnostic; see `settlement` for the durable outcome.'),
  settlement: z.enum(['returned_to_queue', 'usage_limit_retry_scheduling', 'usage_limit_retry_scheduled']).nullable()
    .describe('Durable owner of the claimed comments once the attempt settles without publishing: `returned_to_queue` (recovery returned them to the pending list), `usage_limit_retry_scheduled` (a scheduled usage-limit retry job owns them; recovery never requeues them) or `usage_limit_retry_scheduling` (the worker stopped around the queue add; held for an operator as `usage_limit_retry_unconfirmed`). Unlike `statusReason`, later diagnostics never overwrite it, so the `noChanges`/`settled` counters stay correct.'),
  operatorAuthorized: z.boolean().describe('Whether an operator explicitly authorized publishing user-cancelled work.'),
  liveness: z.string().describe('Agent container liveness evidence, for example `running`, `stopped`, `not_found` or `unavailable` (recovery fails closed on the latter).'),
  branchName: z.string().describe('PR head branch still attached to the retained worktree until cleanup releases it.'),
  commitHash: z.string().nullable().describe('Commit recovery is bound to publish, once recorded.'),
  completionCommentUrl: z.string().nullable().describe('Delivered completion comment; recovery never overwrites it.'),
  nextAction: z.string().describe('Operator guidance for the current state.'),
  retainedWorktreePath: z.string().describe('Host path of the retained worktree. Deliberately admin-only; never shown on member routes.'),
  updatedAt: z.number().describe('Unix milliseconds of the last durable update.'),
}), 'Operator-facing status of one durable follow-up publication handoff.');

export const FollowupHandoffList = component('FollowupHandoffList', z.object({
  handoffs: z.array(FollowupHandoffStatus),
}));

export const FollowupHandoffDetail = component('FollowupHandoffDetail', z.object({
  status: FollowupHandoffStatus,
}));

export const FollowupHandoffRecoverySummary = component('FollowupHandoffRecoverySummary', z.object({
  inspected: z.number().int().nonnegative(),
  published: z.number().int().nonnegative().describe('Interrupted work recovered and published exactly once.'),
  noChanges: z.number().int().nonnegative().describe('Interrupted runs that produced nothing; their requests were returned to the queue (settlement `returned_to_queue`).'),
  settled: z.number().int().nonnegative().describe('Runs whose no-change completion, failure or usage-limit retry the normal path had already delivered or scheduled; recorded without republishing or requeueing.'),
  cleanupPending: z.number().int().nonnegative().describe('Publication settled but branch release still owed; retried on the next pass.'),
  skippedLiveAgent: z.number().int().nonnegative(),
  failedClosed: z.number().int().nonnegative().describe('Records whose container evidence was unavailable or ambiguous; left untouched.'),
  awaitingOperator: z.number().int().nonnegative(),
  lockedByOtherWriter: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative().describe('Records whose recovery failed (for example unreachable remote evidence); retained for the next pass.'),
}), 'Counts of one recovery pass. Keyed passes inspect at most the addressed pull request.');

export const FollowupHandoffResumeRequest = component('FollowupHandoffResumeRequest', z.object({
  authorizeCancelled: z.boolean().optional().describe('Set `true` to explicitly authorize publishing work the user cancelled. Without it, resume re-arms the operator-held record and refuses cancelled work with code `requires_cancellation_authorization`.'),
}));

export const FollowupHandoffResumeResult = component('FollowupHandoffResumeResult', z.object({
  summary: FollowupHandoffRecoverySummary,
  status: FollowupHandoffStatus.nullable().describe('State after the keyed recovery pass; `null` once the handoff retired completely.'),
}));

export const FollowupHandoffReleaseRequest = component('FollowupHandoffReleaseRequest', z.object({
  force: z.boolean().optional().describe('Also release a branch whose retained worktree still holds unpublished work. Never deletes worktree files, and never overrides a live or unverifiable agent.'),
}));

export const FollowupHandoffReleaseResult = component('FollowupHandoffReleaseResult', z.object({
  released: z.boolean(),
  reason: z.string().optional().describe('Refusal code when `released` is false, for example `agent_still_running`, `liveness_unavailable`, `lease_held_by_live_writer`, `worktree_holds_unpublished_work`, `branch_still_registered` (a Git worktree registration still holds the branch, even after a forced detach), `worktree_registrations_unavailable` or `cancelled_claims_withdrawal_failed` (the claimed comments of a cancelled request could not be withdrawn from the pending list, so releasing could let them run).'),
}), 'Outcome of a release request; refusals answer `409` with `released: false`.');
