import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/**
 * Read client for the durable MCP access log
 * (`GET /api/admin/mcp/logs`, `GET /api/admin/mcp/logs/stats`).
 *
 * Both endpoints sit behind the same instance permission as the rest of
 * `/api/admin/mcp`, so a caller without it gets a 403 that this module reports
 * as its own error type rather than as a generic failure.
 */

export const MCP_ACCESS_KINDS = ['tool', 'resource', 'prompt', 'auth'] as const;
export const MCP_ACCESS_OUTCOMES = ['success', 'denied', 'error'] as const;

export type McpAccessKind = typeof MCP_ACCESS_KINDS[number];
export type McpAccessOutcome = typeof MCP_ACCESS_OUTCOMES[number];

export interface McpAccessLogEntry {
  id: number;
  occurredAt: number;
  ownerId: string | null;
  grantId: string | null;
  clientId: string | null;
  clientName: string | null;
  membershipSource: string | null;
  kind: McpAccessKind;
  name: string;
  repository: string | null;
  scope: string | null;
  readOnly: boolean;
  status: number;
  outcome: McpAccessOutcome;
  errorCode: string | null;
  durationMs: number;
  resultBytes: number;
  operationId: string | null;
  protocolVersion: string | null;
  requestId: string | null;
}

export interface McpAccessLogPagination {
  page: number;
  limit: number;
  offset: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface McpAccessLogResponse {
  data: McpAccessLogEntry[];
  pagination: McpAccessLogPagination;
  filters: Record<string, unknown>;
}

export interface McpAccessLogParams {
  page?: number;
  limit?: number;
  ownerId?: string;
  clientId?: string;
  repository?: string;
  name?: string;
  kind?: string;
  outcome?: string;
  since?: number;
  until?: number;
}

export interface McpAccessLogTopTool { name: string; count: number }
export interface McpAccessLogTopClient { clientId: string; clientName: string | null; count: number }
export interface McpAccessLogTopRepository { repository: string; count: number }
export interface McpAccessLogErrorCode { errorCode: string; count: number }

/**
 * Every figure is optional: a field an instance does not publish yet must be
 * rendered as unavailable, never as a zero.
 */
export interface McpAccessLogStats {
  window?: { since: number; until: number };
  total?: number;
  outcomes?: Partial<Record<McpAccessOutcome, number>>;
  topTools?: McpAccessLogTopTool[];
  topClients?: McpAccessLogTopClient[];
  topRepositories?: McpAccessLogTopRepository[];
  errorCodes?: McpAccessLogErrorCode[];
  durationMs?: { p50: number | null; p95: number | null };
}

export interface McpAccessLogStatsResponse { data: McpAccessLogStats }

/** A 403 from the admin MCP endpoints: the operator may not read this log. */
export class McpAccessLogPermissionError extends Error {
  constructor(message = 'You do not have permission to read the MCP access log.') {
    super(message);
    this.name = 'McpAccessLogPermissionError';
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  // The API rejects unknown and empty parameters, so only set what is present.
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : '';
}

async function readMcpLog<T>(path: string): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, { credentials: 'include' });
  try {
    await handleApiResponse(response);
  } catch (error) {
    // The permission gate is a distinct state on the page, not a broken log.
    if (response.status === 403) {
      throw new McpAccessLogPermissionError(error instanceof Error ? error.message : undefined);
    }
    throw error;
  }
  return await response.json() as T;
}

export const getMcpAccessLogs = async (params: McpAccessLogParams = {}): Promise<McpAccessLogResponse> =>
  await readMcpLog<McpAccessLogResponse>(`/api/admin/mcp/logs${buildQuery({ ...params })}`);

export const getMcpAccessLogStats = async (
  params: { since?: number; until?: number } = {},
): Promise<McpAccessLogStatsResponse> =>
  await readMcpLog<McpAccessLogStatsResponse>(`/api/admin/mcp/logs/stats${buildQuery({ ...params })}`);
