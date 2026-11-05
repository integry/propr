import type {
  AutomationAutonomyMode,
  AutomationCapability,
  AutomationDefinitionInput,
  AutomationRunState,
  AutomationRunTrigger,
  AUTOMATION_DEFINITION_CONTRACT,
  AttributedUser,
} from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/**
 * Typed client for the Automations REST surface: `/api/automation-definitions` (the
 * saved definitions, their input files and runs) and `/api/automation-runs`.
 * Responses mirror the server's stored shapes, with timestamps in epoch ms.
 */

export interface AutomationDefinitionAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
}

export interface AutomationDefinitionRecord {
  extensionProfile?: import('@propr/shared').ExtensionSelection | null;
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  repositories: string[];
  prompt: string;
  attachments: AutomationDefinitionAttachment[];
  agentAlias: string | null;
  modelName: string | null;
  capabilities: AutomationCapability[];
  includePreviousReports: boolean;
  previousReportsLimit: number;
  scheduleCron: string | null;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  nextRunAt: number | null;
  autonomyMode: AutomationAutonomyMode;
  enabled: boolean;
  /** Optimistic concurrency token; send it back as `expectedRevision`. */
  revision: number;
  /** Who created the automation; null when their profile is not cached. */
  createdBy?: AttributedUser | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRunRecord {
  id: string;
  definitionId: string;
  ownerId: string;
  trigger: AutomationRunTrigger;
  triggerSource: string | null;
  idempotencyKey: string | null;
  state: AutomationRunState;
  autonomyMode: AutomationAutonomyMode;
  /** Only in the run detail. */
  definitionSnapshot?: AutomationDefinitionRecord | null;
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

export interface AutomationCapacity {
  capacity: {
    status: string;
    sessionPercent?: number;
    weeklyPercent?: number;
    resetsInMs?: number;
    provider: string;
  };
  threshold: number;
}

export type AutomationDefinitionContract = typeof AUTOMATION_DEFINITION_CONTRACT;

interface Page { limit?: number; offset?: number }

/** An API failure that keeps the HTTP status and code, so callers can tell a 409 conflict apart. */
export class AutomationApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AutomationApiError';
  }
}

export const isAutomationConflictError = (error: unknown): boolean =>
  error instanceof AutomationApiError && error.status === 409;

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
      throw new AutomationApiError(error.message, response.status, typeof code === 'string' ? code : undefined);
    }
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), ...((body as { extensionProfile?: unknown })?.extensionProfile ? { headers: { 'X-ProPR-Extensions': '1' } } : {}) }),
});

const query = (page: Page = {}): string => {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  if (page.offset !== undefined) params.set('offset', String(page.offset));
  const text = params.toString();
  return text ? `?${text}` : '';
};

const definitionPath = (id: string) => `/api/automation-definitions/${encodeURIComponent(id)}`;
const runPath = (runId: string) => `/api/automation-runs/${encodeURIComponent(runId)}`;

export const listAutomationDefinitions = (page?: Page) =>
  request<{ definitions: AutomationDefinitionRecord[]; total: number; limit: number; offset: number }>(`/api/automation-definitions${query(page)}`);

export const getAutomationDefinition = async (id: string) =>
  (await request<{ definition: AutomationDefinitionRecord }>(definitionPath(id))).definition;

export const getAutomationDefinitionContract = () =>
  request<AutomationDefinitionContract>('/api/automation-definitions/contract');

export const createAutomationDefinition = async (input: AutomationDefinitionInput) =>
  (await request<{ definition: AutomationDefinitionRecord }>('/api/automation-definitions', json('POST', input))).definition;

/** Applies a partial update; a stale `expectedRevision` fails with a 409 {@link AutomationApiError}. */
export const updateAutomationDefinition = async (id: string, patch: Partial<AutomationDefinitionInput>, expectedRevision: number) =>
  (await request<{ definition: AutomationDefinitionRecord }>(definitionPath(id), json('PATCH', { ...patch, expectedRevision }))).definition;

/** Deleting while a run is active fails with a 409 {@link AutomationApiError}. */
export const deleteAutomationDefinition = (id: string) =>
  request<void>(definitionPath(id), { method: 'DELETE' });

export const uploadAutomationAttachment = (id: string, files: readonly File[]) => {
  const body = new FormData();
  files.forEach(file => body.append('files', file));
  return request<{ definition: AutomationDefinitionRecord; attachments: AutomationDefinitionAttachment[] }>(
    `${definitionPath(id)}/attachments`,
    { method: 'POST', body },
  );
};

export const deleteAutomationAttachment = async (id: string, attachmentId: string) =>
  (await request<{ definition: AutomationDefinitionRecord }>(
    `${definitionPath(id)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  )).definition;

/** Triggers the REST run endpoint accepts in its body. */
export type AutomationRunRequestTrigger = Extract<AutomationRunTrigger, 'manual' | 'api' | 'cli'>;

/**
 * Without `trigger` the server classifies the run by how the request was
 * authenticated, so a token or native-bridge caller counts as `api` and stays
 * cost-gated. An attended Run now passes `trigger: 'manual'` explicitly.
 */
export const triggerAutomationRun = (id: string, options: { idempotencyKey?: string; trigger?: AutomationRunRequestTrigger } = {}) =>
  request<{ run: AutomationRunRecord; created: boolean }>(`${definitionPath(id)}/runs`, {
    ...json('POST', options.trigger ? { trigger: options.trigger } : {}),
    headers: { 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID() },
  });

export interface AutomationRunPage {
  runs: AutomationRunRecord[];
  total: number;
  limit: number;
  offset: number;
  /** Where the next page starts, or null when this page reaches the end. */
  nextOffset: number | null;
}

/** Runs newest first. */
export const listAutomationRuns = async (id: string, page?: Page): Promise<AutomationRunPage> => {
  const body = await request<Omit<AutomationRunPage, 'nextOffset'> & { nextOffset?: number | null }>(`${definitionPath(id)}/runs${query(page)}`);
  const end = body.offset + body.runs.length;
  return { ...body, nextOffset: body.nextOffset !== undefined ? body.nextOffset : (body.runs.length > 0 && end < body.total ? end : null) };
};

export const getAutomationRun = async (runId: string) =>
  (await request<{ run: AutomationRunRecord }>(runPath(runId))).run;

export const approveAutomationRun = async (runId: string, note?: string) =>
  (await request<{ run: AutomationRunRecord }>(`${runPath(runId)}/approve`, json('POST', note ? { note } : {}))).run;

export const rejectAutomationRun = async (runId: string) =>
  (await request<{ run: AutomationRunRecord }>(`${runPath(runId)}/reject`, json('POST', {}))).run;

export const cancelAutomationRun = async (runId: string) =>
  (await request<{ run: AutomationRunRecord }>(`${runPath(runId)}/cancel`, json('POST', {}))).run;

export const getAutomationCapacity = (id: string) =>
  request<AutomationCapacity>(`${definitionPath(id)}/capacity`);
