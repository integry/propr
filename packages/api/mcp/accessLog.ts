import { AsyncLocalStorage } from 'node:async_hooks';
import type { Knex } from 'knex';
import { z } from 'zod';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';

/**
 * Durable MCP access log.
 *
 * One row per MCP invocation: which connected app called which tool, resource
 * or prompt, for which repository, and how the call ended. Only names,
 * identifiers, counts, sizes and outcomes are stored. Tool arguments, message
 * bodies, plan or goal text, comment prose, GitHub or MCP tokens, and result
 * payloads never reach this table.
 */

/**
 * Retention window for access rows. Thirty days covers the incident review and
 * post-revocation audit an operator actually performs, while keeping the table
 * small on a busy instance. Anything older is answered from backups.
 */
export const MCP_ACCESS_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard row ceiling, so a burst inside the window cannot grow the table without bound. */
export const MCP_ACCESS_LOG_MAX_ROWS = 200_000;

/** Window behind the "recent requests" count shown per connected app. */
export const MCP_ACCESS_LOG_RECENT_MS = 24 * 60 * 60 * 1000;

/** A prune sweep is piggybacked on a write at most this often. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Rows deleted per prune statement, so a sweep stays bounded and cheap. */
const PRUNE_BATCH = 5000;

export const MCP_ACCESS_KINDS = ['tool', 'resource', 'prompt', 'auth'] as const;
export const MCP_ACCESS_OUTCOMES = ['success', 'denied', 'error'] as const;
export type McpAccessKind = typeof MCP_ACCESS_KINDS[number];
export type McpAccessOutcome = typeof MCP_ACCESS_OUTCOMES[number];

export interface McpAccessLogEntry {
  occurredAt?: number;
  ownerId?: string | null;
  grantId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  membershipSource?: string | null;
  kind: McpAccessKind;
  name: string;
  repository?: string | null;
  scope?: string | null;
  readOnly?: boolean;
  status: number;
  outcome: McpAccessOutcome;
  errorCode?: string | null;
  durationMs?: number;
  resultBytes?: number;
  operationId?: string | null;
  protocolVersion?: string | null;
  requestId?: string | null;
}

export interface McpAccessLogRow {
  id: number;
  occurred_at: number | string;
  owner_id: string | null;
  grant_id: string | null;
  client_id: string | null;
  client_name: string | null;
  membership_source: string | null;
  kind: string;
  name: string;
  repository: string | null;
  scope: string | null;
  read_only: boolean | number;
  status: number;
  outcome: string;
  error_code: string | null;
  duration_ms: number;
  result_bytes: number;
  operation_id: string | null;
  protocol_version: string | null;
  request_id: string | null;
}

interface McpAccessContext {
  protocolVersion?: string | null;
  requestId?: string | null;
  /** Shared by every nested scope of one dispatch, so the caller can see whether it produced a row. */
  dispatch?: { recorded: boolean };
  /** Set while a resource or prompt handler runs, so the invocation it makes is attributed to that surface. */
  surface?: { kind: McpAccessKind; name: string; recorded: boolean };
}

const accessContext = new AsyncLocalStorage<McpAccessContext>();

/** Truncate to the column width and normalize empties to NULL. Never stores objects. */
function text(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, max);
}

function count(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(Math.floor(numeric), 2_147_483_647) : 0;
}

// A persistent failure (missing migration, unreadable database) must be visible
// without flooding the log on every request.
let lastWarnAt = 0;
function warnAccessLogFailure(action: string, error: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[mcp] Access log ${action} failed:`, error instanceof Error ? error.message : 'Unknown error');
}

/**
 * Write one access row. Best effort in every direction: the row is built from a
 * fixed column whitelist, and any failure is swallowed so logging can never
 * change a tool result, a status code or a response body.
 */
export async function recordMcpAccess(db: Knex, entry: McpAccessLogEntry): Promise<void> {
  const context = accessContext.getStore();
  // Claim the dispatch before the write: a row that failed to insert is still
  // this invocation's row, and must not be replaced by a rejection row.
  if (context?.dispatch) context.dispatch.recorded = true;
  try {
    await db('mcp_access_log').insert({
      occurred_at: entry.occurredAt ?? Date.now(),
      owner_id: text(entry.ownerId, 64),
      grant_id: text(entry.grantId, 128),
      client_id: text(entry.clientId, 255),
      client_name: text(entry.clientName, 255),
      membership_source: text(entry.membershipSource, 32),
      kind: entry.kind,
      name: text(entry.name, 128) ?? 'unknown',
      repository: text(entry.repository, 255),
      scope: text(entry.scope, 32),
      read_only: !!entry.readOnly,
      status: count(entry.status),
      outcome: entry.outcome,
      error_code: text(entry.errorCode, 64),
      duration_ms: count(entry.durationMs),
      result_bytes: count(entry.resultBytes),
      operation_id: text(entry.operationId, 36),
      protocol_version: text(entry.protocolVersion ?? context?.protocolVersion, 32),
      request_id: text(entry.requestId ?? context?.requestId, 128),
    });
  } catch (error) {
    warnAccessLogFailure('write', error);
    return;
  }
  schedulePrune(db);
}

/** Identity columns for a principal. Tolerates a partial or absent principal. */
export function accessPrincipal(principal?: Pick<McpPrincipal, 'user' | 'grant'> | null): Pick<McpAccessLogEntry,
  'ownerId' | 'grantId' | 'clientId' | 'clientName' | 'membershipSource'> {
  return {
    ownerId: principal?.user?.id ?? null,
    grantId: principal?.grant?.id ?? null,
    clientId: principal?.grant?.clientId ?? null,
    clientName: principal?.grant?.clientName ?? null,
    membershipSource: principal?.grant?.membershipSource ?? null,
  };
}

/**
 * Map a thrown failure onto the recorded outcome. Rejected requests (missing
 * scope, forbidden repository, invalid arguments) are denials; anything the
 * instance itself could not complete is an error.
 */
export function classifyMcpFailure(error: unknown): { status: number; outcome: McpAccessOutcome; errorCode: string } {
  if (error instanceof McpError) {
    return { status: error.status, outcome: error.status >= 500 ? 'error' : 'denied', errorCode: error.code };
  }
  if (error instanceof z.ZodError) return { status: 400, outcome: 'denied', errorCode: 'INVALID_INPUT' };
  return { status: 500, outcome: 'error', errorCode: 'INTERNAL_ERROR' };
}

/** JSON-RPC request identifiers are scalars; anything else is not correlatable. */
export function mcpRequestId(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : null;
}

/** Make the transport-level correlation fields available to every recorder below. */
export function withMcpRequestContext<T>(context: { protocolVersion?: string | null; requestId?: string | null }, run: () => T): T {
  return accessContext.run({ protocolVersion: context.protocolVersion ?? null, requestId: context.requestId ?? null }, run);
}

/**
 * Run one dispatched MCP message and report whether it recorded an invocation.
 * The protocol SDK validates a tool's input schema and a prompt's argument
 * schema before it calls the registered callback, so a rejected call never
 * reaches the recorders below; the caller records that rejection itself when
 * this returns false.
 */
export async function withMcpDispatch(run: () => Promise<void>): Promise<boolean> {
  const dispatch = { recorded: false };
  await accessContext.run({ ...accessContext.getStore(), dispatch }, run);
  return dispatch.recorded;
}

/**
 * Record one resource read or prompt fetch. The invocation it performs claims
 * the surface, so a resource backed by a tool still produces exactly one row;
 * a failure before that claim is recorded here instead.
 */
export async function withMcpSurface<T>(
  db: Knex, principal: Pick<McpPrincipal, 'user' | 'grant'>, { kind, name }: { kind: McpAccessKind; name: string }, run: () => Promise<T>,
): Promise<T> {
  const parent = accessContext.getStore();
  const surface: McpAccessContext['surface'] = { kind, name, recorded: false };
  const startedAt = Date.now();
  try {
    const value = await accessContext.run({ ...parent, surface }, run);
    if (!surface.recorded) {
      await recordMcpAccess(db, { ...accessPrincipal(principal), kind, name, status: 200, outcome: 'success', durationMs: Date.now() - startedAt });
    }
    return value;
  } catch (error) {
    if (!surface.recorded) {
      await recordMcpAccess(db, { ...accessPrincipal(principal), kind, name, ...classifyMcpFailure(error), durationMs: Date.now() - startedAt });
    }
    throw error;
  }
}

/** Take over recording for the surrounding resource or prompt surface, once. */
export function claimMcpSurface(): { kind: McpAccessKind; name: string } | null {
  const surface = accessContext.getStore()?.surface;
  if (!surface || surface.recorded) return null;
  surface.recorded = true;
  return { kind: surface.kind, name: surface.name };
}

// Opportunistic retention: no always-on timer, so nothing runs in a test that
// never writes a row. The sweep is detached from the request that triggered it.
let lastPruneAt = 0;
function schedulePrune(db: Knex): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  void pruneMcpAccessLog(db).catch(error => warnAccessLogFailure('prune', error));
}

/**
 * Delete the oldest rows a query matches, at most `limit` of them, in one
 * statement: find the id that closes the batch, then delete up to it.
 */
async function deleteOldestBatch(scope: Knex.QueryBuilder, limit: number): Promise<number> {
  const boundary = await scope.clone().orderBy('id').offset(limit - 1).limit(1).first('id');
  return boundary ? scope.clone().where('id', '<=', boundary.id).delete() : scope.clone().delete();
}

/**
 * Drop rows outside the retention window, then enforce the row ceiling. Each
 * statement is bounded to one batch of the oldest rows, and the sweep repeats
 * until both limits hold, so a backlog deeper than one batch is cleared by the
 * sweep that found it rather than surviving until the next one.
 */
export async function pruneMcpAccessLog(
  db: Knex,
  { now = Date.now(), retentionMs = MCP_ACCESS_LOG_RETENTION_MS, maxRows = MCP_ACCESS_LOG_MAX_ROWS } = {},
): Promise<number> {
  let deleted = 0;
  try {
    const cutoff = now - retentionMs;
    for (;;) {
      const removed = await deleteOldestBatch(db('mcp_access_log').where('occurred_at', '<', cutoff), PRUNE_BATCH);
      deleted += removed;
      if (removed < PRUNE_BATCH) break;
    }
    for (;;) {
      const [total] = await db('mcp_access_log').count<Array<{ count: string | number }>>({ count: '*' });
      const excess = Math.min(Number(total?.count ?? 0) - maxRows, PRUNE_BATCH);
      if (excess <= 0) break;
      const removed = await deleteOldestBatch(db('mcp_access_log'), excess);
      deleted += removed;
      // A statement that removed nothing cannot make progress; stop instead of
      // spinning against a table the next sweep will retry.
      if (!removed) break;
    }
  } catch (error) {
    warnAccessLogFailure('prune', error);
  }
  return deleted;
}

export interface McpGrantActivity { lastSeenAt: number | null; recentRequests: number }

/**
 * Last-seen timestamp and recent request count per grant, for the connected-apps
 * view. A grant with no entry has no retained rows, which is not proof it was
 * never used: rows are pruned and history predates the table. Resolves `null`
 * when the log cannot be read, so callers can tell that apart from no rows.
 */
export async function loadMcpGrantActivity(db: Knex, grantIds: string[], now = Date.now()): Promise<Map<string, McpGrantActivity> | null> {
  const activity = new Map<string, McpGrantActivity>();
  const ids = [...new Set(grantIds)].filter(Boolean).slice(0, 200);
  if (!ids.length) return activity;
  try {
    const rows = await db('mcp_access_log').whereIn('grant_id', ids).groupBy('grant_id')
      .select('grant_id')
      .select(db.raw('MAX(occurred_at) as last_seen_at'))
      .select(db.raw('SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) as recent_requests', [now - MCP_ACCESS_LOG_RECENT_MS])) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const lastSeenAt = Number(row.last_seen_at);
      activity.set(String(row.grant_id), {
        lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : null,
        recentRequests: Number(row.recent_requests ?? 0) || 0,
      });
    }
  } catch (error) {
    warnAccessLogFailure('read', error);
    return null;
  }
  return activity;
}
