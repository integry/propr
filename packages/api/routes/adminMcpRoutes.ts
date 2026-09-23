import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { CONFIG_EVENT_CHANNEL } from '../services/configReloadSubscription.js';
import { MCP_SCOPES } from '../mcp/config.js';
import {
  MCP_ACCESS_KINDS,
  MCP_ACCESS_OUTCOMES,
  MCP_ACCESS_LOG_RETENTION_MS,
  type McpAccessLogRow,
} from '../mcp/accessLog.js';
import { REPOSITORY_REGEX, validatePagination } from './validation.js';
import {
  loadMcpAdminSettings,
  saveMcpAdminSettingRows,
  resolveMcpStatus,
  invalidateMcpConfigCache,
  resetMcpKeyCheckValue,
} from '../mcp/configResolver.js';

interface RouteError { error: string; code: string; status: number }

const invalidInput = (error: string): RouteError => ({ error, code: 'INVALID_INPUT', status: 400 });

/** Every query parameter the access log endpoints accept. Anything else is rejected. */
const LOG_QUERY_KEYS = ['page', 'limit', 'ownerId', 'clientId', 'repository', 'name', 'kind', 'outcome', 'since', 'until'] as const;
const STATS_QUERY_KEYS = ['since', 'until'] as const;

/** Rows per aggregate list in the stats response. */
const STATS_TOP_N = 10;

/** Default stats window when the caller requests none. */
const DEFAULT_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Identifier shapes the recorder can produce, anchored so a filter cannot carry a pattern. */
const LOG_FILTER_PATTERNS = {
  ownerId: /^[A-Za-z0-9._-]{1,64}$/,
  clientId: /^[^\s]{1,255}$/,
  repository: REPOSITORY_REGEX,
  name: /^[A-Za-z0-9._:-]{1,128}$/,
} as const;

interface AccessLogFilters {
  ownerId?: string; clientId?: string; repository?: string; name?: string;
  kind?: string; outcome?: string; since?: number; until?: number;
}

/** Epoch milliseconds or an ISO 8601 instant. Anything else is a rejected filter. */
function parseTimestamp(value: unknown, field: string): { value?: number } | RouteError {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string') return invalidInput(`${field} must be epoch milliseconds or an ISO 8601 timestamp`);
  const parsed = /^\d{1,15}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) return invalidInput(`${field} must be epoch milliseconds or an ISO 8601 timestamp`);
  return { value: parsed };
}

function parseAccessLogFilters(query: Record<string, unknown>, allowed: readonly string[]): { filters: AccessLogFilters } | { failure: RouteError } {
  const unknown = Object.keys(query).filter(key => !(allowed as readonly string[]).includes(key));
  if (unknown.length) return { failure: invalidInput(`Unsupported query parameter(s): ${unknown.join(', ')}. Supported: ${allowed.join(', ')}`) };

  const filters: AccessLogFilters = {};
  for (const field of ['ownerId', 'clientId', 'repository', 'name'] as const) {
    const value = query[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !LOG_FILTER_PATTERNS[field].test(value)) return { failure: invalidInput(`${field} is not a valid filter value`) };
    filters[field] = value;
  }
  for (const [field, values] of [['kind', MCP_ACCESS_KINDS], ['outcome', MCP_ACCESS_OUTCOMES]] as const) {
    const value = query[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
      return { failure: invalidInput(`${field} must be one of: ${values.join(', ')}`) };
    }
    filters[field] = value;
  }
  for (const field of ['since', 'until'] as const) {
    const parsed = parseTimestamp(query[field], field);
    if ('status' in parsed) return { failure: parsed };
    if (parsed.value !== undefined) filters[field] = parsed.value;
  }
  if (filters.since !== undefined && filters.until !== undefined && filters.since > filters.until) {
    return { failure: invalidInput('since must not be later than until') };
  }
  return { filters };
}

function applyAccessLogFilters(query: Knex.QueryBuilder, filters: AccessLogFilters): Knex.QueryBuilder {
  if (filters.ownerId) query = query.where('owner_id', filters.ownerId);
  if (filters.clientId) query = query.where('client_id', filters.clientId);
  if (filters.repository) query = query.where('repository', filters.repository);
  if (filters.name) query = query.where('name', filters.name);
  if (filters.kind) query = query.where('kind', filters.kind);
  if (filters.outcome) query = query.where('outcome', filters.outcome);
  if (filters.since !== undefined) query = query.where('occurred_at', '>=', filters.since);
  if (filters.until !== undefined) query = query.where('occurred_at', '<=', filters.until);
  return query;
}

function formatAccessLogRow(row: McpAccessLogRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    occurredAt: Number(row.occurred_at),
    ownerId: row.owner_id,
    grantId: row.grant_id,
    clientId: row.client_id,
    clientName: row.client_name,
    membershipSource: row.membership_source,
    kind: row.kind,
    name: row.name,
    repository: row.repository,
    scope: row.scope,
    readOnly: Boolean(row.read_only),
    status: Number(row.status),
    outcome: row.outcome,
    errorCode: row.error_code,
    durationMs: Number(row.duration_ms),
    resultBytes: Number(row.result_bytes),
    operationId: row.operation_id,
    protocolVersion: row.protocol_version,
    requestId: row.request_id,
  };
}

type GroupRow = Record<string, unknown> & { count: string | number };

/** Bounded top-N aggregate, computed by the database rather than in memory. */
async function topBy(query: Knex.QueryBuilder, columns: string[]): Promise<GroupRow[]> {
  return await query.whereNotNull(columns[0]).groupBy(...columns)
    .select(...columns).count({ count: '*' })
    .orderBy('count', 'desc').orderBy(columns[0], 'asc').limit(STATS_TOP_N) as GroupRow[];
}

interface AdminMcpRoutesDeps {
  database?: Knex;
  redisClient?: { publish(channel: string, message: string): Promise<unknown> };
}

async function logActivity(
  redisClient: AdminMcpRoutesDeps['redisClient'],
  description: string,
  username?: string,
): Promise<void> {
  if (!redisClient) return;
  try {
    const activity = {
      id: `activity-${Date.now()}-mcp`,
      type: 'mcp_settings_updated',
      timestamp: new Date().toISOString(),
      user: username,
      description,
      status: 'success',
    };
    await redisClient.publish('system:activity:log', JSON.stringify(activity));
  } catch { /* non-critical */ }
}

async function publishMcpUpdate(redisClient: AdminMcpRoutesDeps['redisClient']): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({ type: 'config_update', subtype: 'mcp_settings_update', timestamp: Date.now() }));
  } catch { /* non-critical */ }
}

function validatePutSettingsBody(body: Record<string, unknown>): { error: string; code: string; status: number } | null {
  const { enabled, scopeCeiling, connectEnabled } = body;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { error: 'enabled must be a boolean', code: 'INVALID_INPUT', status: 400 };
  }
  if (scopeCeiling !== undefined) {
    const invalid = !Array.isArray(scopeCeiling)
      || (scopeCeiling as unknown[]).some(s => typeof s !== 'string' || !(MCP_SCOPES as readonly string[]).includes(s as string));
    if (invalid) return { error: 'scopeCeiling must be an array of valid MCP scopes', code: 'INVALID_INPUT', status: 400 };
  }
  if (connectEnabled !== undefined && typeof connectEnabled !== 'boolean') {
    return { error: 'connectEnabled must be a boolean', code: 'INVALID_INPUT', status: 400 };
  }
  return null;
}

async function checkEnablePrerequisites(database: Knex): Promise<{ error: string; code: string; status: number } | null> {
  if (process.env.MCP_ENABLED === 'false') {
    return { error: 'MCP is disabled by operator configuration', code: 'OPERATOR_DISABLED', status: 403 };
  }
  if (process.env.NODE_ENV === 'test') return null;
  const status = await resolveMcpStatus(database);
  if (status.demoMode) return { error: 'MCP cannot be enabled in demo mode', code: 'DEMO_MODE', status: 403 };
  if (status.missingHttpsOrigin) return { error: 'MCP requires an HTTPS origin (API_PUBLIC_URL or GH_OAUTH_CALLBACK_URL)', code: 'MISSING_HTTPS_ORIGIN', status: 400 };
  if (status.missingSecretChain) return { error: 'MCP requires an encryption secret (PROPR_CREDENTIAL_ENCRYPTION_KEY, SYSTEM_TASK_SECRET, or SESSION_SECRET)', code: 'MISSING_SECRET_CHAIN', status: 400 };
  return null;
}

export function createAdminMcpRoutes({ database = db, redisClient }: AdminMcpRoutesDeps = {}) {
  async function getSettings(req: Request, res: Response): Promise<void> {
    try {
      const status = await resolveMcpStatus(database);
      const adminSettings = await loadMcpAdminSettings(database);
      res.json({
        status,
        settings: {
          enabled: adminSettings.enabled,
          scopeCeiling: adminSettings.scopeCeiling,
          connectEnabled: adminSettings.connectEnabled,
        },
        scopes: [...MCP_SCOPES],
      });
    } catch (error) {
      console.error('Failed to get MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to get MCP settings' });
    }
  }

  async function putSettings(req: Request, res: Response): Promise<void> {
    const body: Record<string, unknown> = req.body ?? {};
    const { enabled, scopeCeiling, connectEnabled } = body;

    const validationError = validatePutSettingsBody(body);
    if (validationError) { res.status(validationError.status).json({ error: validationError.error, code: validationError.code }); return; }

    try {
      if (enabled === true) {
        const prereqError = await checkEnablePrerequisites(database);
        if (prereqError) { res.status(prereqError.status).json({ error: prereqError.error, code: prereqError.code }); return; }
      }

      const updates: Record<string, string> = {};
      if (enabled !== undefined) updates.enabled = String(enabled);
      if (scopeCeiling !== undefined) updates.scope_ceiling = JSON.stringify(scopeCeiling);
      if (connectEnabled !== undefined) updates.connect_enabled = String(connectEnabled);

      if (Object.keys(updates).length > 0) {
        await saveMcpAdminSettingRows(updates, database);
        invalidateMcpConfigCache();
        await publishMcpUpdate(redisClient);
        const desc = enabled !== undefined ? (enabled ? 'enabled' : 'disabled') : 'updated';
        await logActivity(redisClient, `MCP server ${desc}`, req.user?.username);
      }

      const newStatus = await resolveMcpStatus(database);
      res.json({ status: newStatus });
    } catch (error) {
      console.error('Failed to update MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to update MCP settings' });
    }
  }

  async function revokeAll(req: Request, res: Response): Promise<void> {
    try {
      const now = Date.now();
      // Count of grant rows this call invalidates. Rows an earlier sweep already
      // expired are left out so repeated invocations do not re-count them.
      const [counted] = await database('mcp_records')
        .where({ kind: 'grant' })
        .whereRaw('(expires_at IS NULL OR expires_at > ?)', [now])
        .count<Array<{ count: string | number }>>({ count: '*' });
      const revoked = Number(counted?.count ?? 0);

      // Delete rather than expire. Every value here is ciphertext sealed with the
      // current encryption key, and the key fingerprint is forgotten just below so
      // a rotated secret can be adopted; anything left behind would be unreadable
      // and its read path would throw instead of failing as an invalid grant.
      await database('mcp_records')
        .whereIn('kind', ['grant', 'access', 'refresh', 'code', 'pending', 'credential', 'client'])
        .delete();

      // Nothing usable remains that was encrypted under the previous secret.
      // Forgetting the key fingerprint clears the "Reconnect required" state and
      // lets an admin enable MCP again after a key rotation.
      await resetMcpKeyCheckValue(database);
      invalidateMcpConfigCache();
      await publishMcpUpdate(redisClient);

      await logActivity(redisClient, `Revoked all MCP connections (${revoked} grants invalidated)`, req.user?.username);
      res.json({ revoked, status: await resolveMcpStatus(database) });
    } catch (error) {
      console.error('Failed to revoke MCP grants:', error);
      res.status(500).json({ error: 'Failed to revoke MCP grants' });
    }
  }

  async function getLogs(req: Request, res: Response): Promise<void> {
    const parsed = parseAccessLogFilters(req.query as Record<string, unknown>, LOG_QUERY_KEYS);
    if ('failure' in parsed) { res.status(parsed.failure.status).json({ error: parsed.failure.error, code: parsed.failure.code }); return; }

    const pagination = validatePagination(req.query.page, req.query.limit, { maxLimit: 200, defaultLimit: 50 });
    if (!pagination.valid) { res.status(400).json({ error: pagination.error, code: 'INVALID_INPUT' }); return; }
    const { page, limit, offset } = pagination.params!;

    try {
      const [rows, counted] = await Promise.all([
        applyAccessLogFilters(database('mcp_access_log'), parsed.filters)
          .orderBy('occurred_at', 'desc').orderBy('id', 'desc')
          .limit(limit).offset(offset).select('*') as unknown as Promise<McpAccessLogRow[]>,
        applyAccessLogFilters(database('mcp_access_log'), parsed.filters)
          .count<Array<{ count: string | number }>>({ count: '*' }).first(),
      ]);
      const total = Number(counted?.count ?? 0);
      const totalPages = Math.ceil(total / limit);
      res.json({
        data: rows.map(formatAccessLogRow),
        pagination: { page, limit, offset, total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
        filters: parsed.filters,
      });
    } catch (error) {
      console.error('Failed to read MCP access log:', error);
      res.status(500).json({ error: 'Failed to read MCP access log' });
    }
  }

  async function getLogStats(req: Request, res: Response): Promise<void> {
    const parsed = parseAccessLogFilters(req.query as Record<string, unknown>, STATS_QUERY_KEYS);
    if ('failure' in parsed) { res.status(parsed.failure.status).json({ error: parsed.failure.error, code: parsed.failure.code }); return; }

    const until = parsed.filters.until ?? Date.now();
    const since = parsed.filters.since ?? until - DEFAULT_STATS_WINDOW_MS;
    // Nothing older than the retention window exists, so a wider request is a
    // mistake rather than a more expensive but useful query.
    if (until - since > MCP_ACCESS_LOG_RETENTION_MS) {
      res.status(400).json({ error: `The requested window exceeds the ${MCP_ACCESS_LOG_RETENTION_MS}ms retention window`, code: 'INVALID_INPUT' });
      return;
    }

    const window = () => database('mcp_access_log').where('occurred_at', '>=', since).where('occurred_at', '<=', until);
    try {
      const [outcomes, counted, tools, clients, repositories, errorCodes] = await Promise.all([
        window().groupBy('outcome').select('outcome').count<GroupRow[]>({ count: '*' }),
        window().count<Array<{ count: string | number }>>({ count: '*' }).first(),
        topBy(window().where('kind', 'tool'), ['name']),
        topBy(window(), ['client_id', 'client_name']),
        topBy(window(), ['repository']),
        topBy(window(), ['error_code']),
      ]);
      const total = Number(counted?.count ?? 0);
      // Nearest-rank percentiles, selected by offset inside the window, so no
      // row payload is ever loaded into memory to compute them.
      const percentile = async (fraction: number): Promise<number | null> => {
        if (!total) return null;
        const rank = Math.min(Math.max(Math.ceil(fraction * total) - 1, 0), total - 1);
        const row = await window().orderBy('duration_ms', 'asc').orderBy('id', 'asc')
          .offset(rank).limit(1).first('duration_ms');
        return row ? Number(row.duration_ms) : null;
      };
      const [p50, p95] = await Promise.all([percentile(0.5), percentile(0.95)]);
      res.json({
        data: {
          window: { since, until },
          total,
          outcomes: Object.fromEntries(MCP_ACCESS_OUTCOMES.map(outcome =>
            [outcome, Number(outcomes.find(row => row.outcome === outcome)?.count ?? 0)])),
          topTools: tools.map(row => ({ name: String(row.name), count: Number(row.count) })),
          topClients: clients.map(row => ({ clientId: String(row.client_id), clientName: row.client_name as string | null, count: Number(row.count) })),
          topRepositories: repositories.map(row => ({ repository: String(row.repository), count: Number(row.count) })),
          errorCodes: errorCodes.map(row => ({ errorCode: String(row.error_code), count: Number(row.count) })),
          durationMs: { p50, p95 },
        },
      });
    } catch (error) {
      console.error('Failed to aggregate MCP access log:', error);
      res.status(500).json({ error: 'Failed to aggregate MCP access log' });
    }
  }

  return { getSettings, putSettings, revokeAll, getLogs, getLogStats };
}
