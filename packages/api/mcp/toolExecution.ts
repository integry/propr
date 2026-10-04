import { McpError } from './config.js';
import { accessPrincipal, claimMcpSurface, classifyMcpFailure, recordMcpAccess, type McpAccessOutcome } from './accessLog.js';
import { McpPolicy, type McpPrincipal } from './policy.js';
import { McpOperations } from './operations.js';
import { cancellationTarget } from './operationTracking.js';
import { redact } from './adapter.js';
import { presentResult, type PresentedResult } from './presentation.js';
import type { Args, McpTool, ToolDeps } from './tools.js';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

async function authorizePlanContext(row: Args, principal: McpPrincipal, policy: McpPolicy): Promise<void> {
  const context = typeof row.context_config === 'string' ? JSON.parse(row.context_config || '{}') : row.context_config;
  const repositories = context?.contextRepositories;
  if (Array.isArray(repositories)) {
    if (repositories.length > 20) throw new McpError('CONTEXT_LIMIT', 'Plan has too many context repositories. Update it in the browser.');
    for (const repository of repositories) {
      if (typeof repository?.repository !== 'string') throw new McpError('INVALID_CONTEXT', 'Invalid plan context repository.');
      await policy.repository(principal, repository.repository);
    }
  }
}

async function authorizeTarget(tool: McpTool, args: Args, principal: McpPrincipal, deps: ToolDeps): Promise<void> {
  const target = tool.target!;
  if (args[target.arg] === undefined) {
    // Only a target declared optional may guard one arm of an exactly-one-of
    // schema (for example task versus pull request), leaving the other arm to
    // repository policy. Every other target fails closed on a missing argument.
    if (target.optional) return;
    throw new McpError('NOT_FOUND', 'Target not found in your authorized repository.', 404);
  }
  const row = await deps.db(target.table).where({ [target.column]: args[target.arg] }).first();
  if (!row || row.repository !== args.repository || (target.owner && row[target.owner] !== principal.user.id)) throw new McpError('NOT_FOUND', 'Target not found in your authorized repository.', 404);
  if (target.table === 'task_drafts') await authorizePlanContext(row, principal, deps.policy);
  if (target.table === 'tasks') {
    const owner = await deps.db('goals').where({ current_task_id: args.taskId }).first('owner_id');
    if ((row.task_type === 'goal' && !owner) || (owner && owner.owner_id !== principal.user.id)) throw new McpError('NOT_FOUND', 'Task not found.', 404);
    if (owner && !tool.readOnly) throw new McpError('USE_GOAL_CONTROLS', 'Use the owning goal’s input and cancellation controls.', 409);
  }
}

/** Durable operation handle a mutation result carries, for access-log correlation. */
const operationHandle = (data: Record<string, unknown>): string | undefined =>
  typeof data.operationId === 'string' ? data.operationId : undefined;

/** How one invocation ended, as the access log records it. */
interface RecordedFailure { status: number; outcome: McpAccessOutcome; errorCode: string }

/** Identifiers, sizes, handles and outcomes the access log records for one invocation. */
interface ToolAccess { repository?: string; operationId?: string; resultBytes: number; failure?: RecordedFailure }
interface ToolInvocation { tool: McpTool; raw: unknown; principal: McpPrincipal; deps: ToolDeps; access: ToolAccess; signal?: AbortSignal }

/**
 * The outcome a durable receipt reports. A replayed operation returns the
 * projection of an earlier attempt rather than throwing, so its failure is read
 * back off that receipt; an accepted, queued or completed one stays a success.
 */
function receiptFailure(data: Record<string, unknown>): RecordedFailure | undefined {
  if (data.state !== 'failed' && data.state !== 'unknown') return undefined;
  const code = (data.result as { error?: { code?: unknown } } | null)?.error?.code;
  const errorCode = typeof code === 'string' ? code : 'OUTCOME_UNKNOWN';
  // 'failed' is the rejection the caller can act on; 'unknown' is an outcome
  // this instance could not establish.
  return data.state === 'failed' ? { status: 400, outcome: 'denied', errorCode } : { status: 500, outcome: 'error', errorCode };
}

/** Read the handle, the size and the outcome one result carries into the access row. */
function contentBytes(content: ContentBlock[] | undefined): number | undefined {
  if (!content) return undefined;
  const binary = content.filter(block => block.type === 'image' || block.type === 'audio');
  if (!binary.length) return undefined;
  return binary.reduce((bytes, block) => bytes + Buffer.byteLength(block.data), 0);
}

function noteToolOutcome(tool: McpTool, access: ToolAccess, data: Record<string, unknown>, content?: ContentBlock[]): void {
  access.operationId = operationHandle(data);
  access.resultBytes = contentBytes(content) ?? Buffer.byteLength(JSON.stringify(data));
  // A replayed receipt reports an earlier attempt instead of throwing, so its
  // outcome is read back off the projection.
  if (!tool.readOnly) access.failure ??= receiptFailure(data);
}

/**
 * Document content is already redacted as one normalized page before its
 * offsets are calculated. Preserve that exact slice while retaining the
 * dispatch safeguard for every other result field: re-redacting a continuation
 * that happens to start with JSON can otherwise parse and reshape the text.
 */
function redactToolResult(tool: McpTool, result: unknown): Record<string, unknown> {
  const data = redact(result) as Record<string, unknown>;
  if (tool.name === 'get_doc' && result && typeof result === 'object') {
    const content = (result as Record<string, unknown>).content;
    if (typeof content === 'string') data.content = content;
  }
  return data;
}

/** Preserve binary content while applying the result-redaction boundary to text overrides. */
function redactToolContent(content: ContentBlock[] | undefined): ContentBlock[] | undefined {
  return content?.map(block => block.type === 'text'
    ? { ...block, text: redact(block.text) as string }
    : block);
}

// eslint-disable-next-line complexity -- dispatch keeps authorization, durable mutation handling, content bounds and logging in one auditable path
async function runTool({ tool, raw, principal, deps, access, signal }: ToolInvocation): Promise<PresentedResult> {
  const args = tool.schema.parse(raw) as Args;
  access.repository = args.repository;
  deps.policy.requireScope(principal, tool.scope);
  if (tool.permission) deps.policy.requirePermission(principal, tool.permission);
  if (args.repository && tool.name !== 'create_repository_configuration') await deps.policy.repository(principal, args.repository, !tool.readOnly, { includeDisabled: tool.name.endsWith('_repository_configuration'), allowUnconfigured: tool.name === 'remove_repository_configuration' });
  // A deleted target cannot be reloaded, but its owner/grant-bound receipt can
  // still be returned after current scope and repository authorization.
  const deletedReplay = !tool.readOnly && tool.name.startsWith('delete_')
    ? await new McpOperations(deps.db).replay(principal, tool.name, args) : undefined;
  if (tool.name === 'send_task_followup' && /^\s*\/(?:merge|review|fix|ultrafix|deploy)\b/im.test(args.message)) throw new McpError('USE_EXPLICIT_TOOL', 'Use the dedicated PR lifecycle tool for slash commands so its scope and head preconditions can be checked.');
  if (tool.target && !deletedReplay) await authorizeTarget(tool, args, principal, deps);
  let operationRepository = args.repository;
  let cancellationReplay: Record<string, unknown> | undefined;
  if (tool.name === 'cancel_operation') {
    const source = await new McpOperations(deps.db).get(principal, args.operationId);
    operationRepository = source.repository;
    if (operationRepository) { access.repository = operationRepository; await deps.policy.repository(principal, operationRepository, true); }
    if (['generate_plan', 'refine_plan'].includes(source.tool)) deps.policy.requireScope(principal, 'plan');
    cancellationReplay = await new McpOperations(deps.db).replay(principal, tool.name, args);
    if (!cancellationReplay) {
      const sourceResult = source.result ? JSON.parse(source.result) : {};
      await cancellationTarget(deps, principal, source.repository, sourceResult.continuation || sourceResult);
    }
  }
  let readContent: ContentBlock[] | undefined;
  const result = deletedReplay ?? cancellationReplay ?? (tool.readOnly
    ? await tool.run({ principal, args, signal }).then(operation => {
      readContent = operation.content;
      return operation.data;
    })
    // The operation wrapper turns a failed callback into a durable receipt
    // instead of throwing, so the classification is captured here, before that
    // projection consumes it.
    : await new McpOperations(deps.db).run(principal, { tool: tool.name, args, repository: operationRepository },
      operationId => tool.run({ principal, args, operationId }).catch(error => { access.failure = classifyMcpFailure(error, { sideEffectsPossible: true }); throw error; })));
  const data = redactToolResult(tool, result);
  const content = redactToolContent(readContent);
  const jsonBytes = Buffer.byteLength(JSON.stringify(data));
  // Binary content has its own tool-specific bound and is intentionally not
  // subject to the JSON page limit below.
  noteToolOutcome(tool, access, data, content);
  if (jsonBytes > 256 * 1024) throw new McpError('RESULT_TOO_LARGE', 'Request a smaller page or narrower target.');
  return { ...presentResult(tool, args, data, deps.policy.config), data, ...(content ? { content } : {}) };
}

/**
 * Every tool call is observable: success, authorization denial and internal
 * error alike. The write is a single indexed insert that swallows its own
 * failures, so it can neither change the result nor fail the request.
 */
async function recordToolAccess(
  { tool, principal, deps, access }: ToolInvocation, startedAt: number,
  result: { status: number; outcome: McpAccessOutcome; errorCode: string | null },
): Promise<void> {
  // A resource read or prompt fetch that reached a tool is one invocation, and
  // is recorded under that surface rather than twice.
  const surface = claimMcpSurface();
  await recordMcpAccess(deps.db, {
    ...accessPrincipal(principal),
    kind: surface?.kind ?? 'tool',
    name: surface?.name ?? tool.name,
    repository: access.repository ?? null,
    scope: tool.scope,
    readOnly: !!tool.readOnly,
    operationId: access.operationId ?? null,
    durationMs: Date.now() - startedAt,
    resultBytes: access.resultBytes,
    ...result,
  });
}

/** `signal` reaches read tools that block (for example `wait_goal`) so cancellation releases them. */
// eslint-disable-next-line max-params -- the optional abort signal is transport context, not tool input
export async function executeTool(tool: McpTool, raw: unknown, principal: McpPrincipal, deps: ToolDeps, signal?: AbortSignal): Promise<PresentedResult> {
  const startedAt = Date.now();
  const invocation: ToolInvocation = { tool, raw, principal, deps, access: { resultBytes: 0 }, signal };
  try {
    const presented = await runTool(invocation);
    await recordToolAccess(invocation, startedAt, invocation.access.failure ?? { status: 200, outcome: 'success', errorCode: null });
    return presented;
  } catch (error) {
    await recordToolAccess(invocation, startedAt, classifyMcpFailure(error));
    throw error;
  }
}
