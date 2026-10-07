import type {
  AgentAutonomyMode,
  AgentCapability,
  AgentDefinitionInput,
  AgentRunState,
  AgentRunTrigger,
  AGENT_DEFINITION_CONTRACT,
} from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/**
 * Typed client for the Agents REST surface: `/api/agent-definitions` (the
 * saved definitions, their input files and runs) and `/api/agent-runs`.
 * Responses mirror the server's stored shapes, with timestamps in epoch ms.
 */

export interface AgentDefinitionAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
}

export interface AgentDefinitionRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  repositories: string[];
  prompt: string;
  attachments: AgentDefinitionAttachment[];
  agentAlias: string | null;
  modelName: string | null;
  capabilities: AgentCapability[];
  includePreviousReports: boolean;
  previousReportsLimit: number;
  scheduleCron: string | null;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  nextRunAt: number | null;
  autonomyMode: AgentAutonomyMode;
  enabled: boolean;
  /** Optimistic concurrency token; send it back as `expectedRevision`. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunRecord {
  id: string;
  definitionId: string;
  ownerId: string;
  trigger: AgentRunTrigger;
  triggerSource: string | null;
  idempotencyKey: string | null;
  state: AgentRunState;
  autonomyMode: AgentAutonomyMode;
  /** Only in the run detail. */
  definitionSnapshot?: AgentDefinitionRecord | null;
  reportTaskId: string | null;
  actionTaskId: string | null;
  /** Only in the run detail. */
  report?: string | null;
  reportTruncated: boolean;
  actionSummary: string | null;
  skipReason: string | null;
  failureReason: string | null;
  approvedBy: string | null;
  operatorNote: string | null;
  deferredUntil: number | null;
  deferrals: number;
  createdAt: number;
  startedAt: number | null;
  reportedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface AgentCapacity {
  capacity: {
    status: string;
    sessionPercent?: number;
    weeklyPercent?: number;
    resetsInMs?: number;
    provider: string;
  };
  threshold: number;
}

export type AgentDefinitionContract = typeof AGENT_DEFINITION_CONTRACT;

interface Page { limit?: number; offset?: number }

/** An API failure that keeps the HTTP status and code, so callers can tell a 409 conflict apart. */
export class AgentApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export const isAgentConflictError = (error: unknown): boolean =>
  error instanceof AgentApiError && error.status === 409;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: init.body && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json', ...init.headers }
      : init.headers,
  });
  if (response.ok || response.status === 401) {
    await handleApiResponse(response);
  } else {
    const code = await response.clone().json().then((body: { code?: unknown }) => body?.code, () => undefined);
    try {
      await handleApiResponse(response);
    } catch (error) {
      // Demo-mode and other typed errors keep their own class.
      if (!(error instanceof Error) || error.constructor !== Error) throw error;
      throw new AgentApiError(error.message, response.status, typeof code === 'string' ? code : undefined);
    }
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const query = (page: Page = {}): string => {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  if (page.offset !== undefined) params.set('offset', String(page.offset));
  const text = params.toString();
  return text ? `?${text}` : '';
};

const definitionPath = (id: string) => `/api/agent-definitions/${encodeURIComponent(id)}`;
const runPath = (runId: string) => `/api/agent-runs/${encodeURIComponent(runId)}`;

export const listAgentDefinitions = (page?: Page) =>
  request<{ definitions: AgentDefinitionRecord[]; total: number; limit: number; offset: number }>(`/api/agent-definitions${query(page)}`);

export const getAgentDefinition = async (id: string) =>
  (await request<{ definition: AgentDefinitionRecord }>(definitionPath(id))).definition;

export const getAgentDefinitionContract = () =>
  request<AgentDefinitionContract>('/api/agent-definitions/contract');

export const createAgentDefinition = async (input: AgentDefinitionInput) =>
  (await request<{ definition: AgentDefinitionRecord }>('/api/agent-definitions', json('POST', input))).definition;

/** Applies a partial update; a stale `expectedRevision` fails with a 409 {@link AgentApiError}. */
export const updateAgentDefinition = async (id: string, patch: Partial<AgentDefinitionInput>, expectedRevision: number) =>
  (await request<{ definition: AgentDefinitionRecord }>(definitionPath(id), json('PATCH', { ...patch, expectedRevision }))).definition;

/** Deleting while a run is active fails with a 409 {@link AgentApiError}. */
export const deleteAgentDefinition = (id: string) =>
  request<void>(definitionPath(id), { method: 'DELETE' });

export const uploadAgentAttachment = (id: string, files: readonly File[]) => {
  const body = new FormData();
  files.forEach(file => body.append('files', file));
  return request<{ definition: AgentDefinitionRecord; attachments: AgentDefinitionAttachment[] }>(
    `${definitionPath(id)}/attachments`,
    { method: 'POST', body },
  );
};

export const deleteAgentAttachment = async (id: string, attachmentId: string) =>
  (await request<{ definition: AgentDefinitionRecord }>(
    `${definitionPath(id)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  )).definition;

export const triggerAgentRun = (id: string, options: { idempotencyKey?: string } = {}) =>
  request<{ run: AgentRunRecord; created: boolean }>(`${definitionPath(id)}/runs`, {
    ...json('POST', {}),
    headers: { 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID() },
  });

export const listAgentRuns = (id: string, page?: Page) =>
  request<{ runs: AgentRunRecord[]; total: number; limit: number; offset: number }>(`${definitionPath(id)}/runs${query(page)}`);

export const getAgentRun = async (runId: string) =>
  (await request<{ run: AgentRunRecord }>(runPath(runId))).run;

export const approveAgentRun = async (runId: string, note?: string) =>
  (await request<{ run: AgentRunRecord }>(`${runPath(runId)}/approve`, json('POST', note ? { note } : {}))).run;

export const rejectAgentRun = async (runId: string) =>
  (await request<{ run: AgentRunRecord }>(`${runPath(runId)}/reject`, json('POST', {}))).run;

export const cancelAgentRun = async (runId: string) =>
  (await request<{ run: AgentRunRecord }>(`${runPath(runId)}/cancel`, json('POST', {}))).run;

export const getAgentCapacity = (id: string) =>
  request<AgentCapacity>(`${definitionPath(id)}/capacity`);
