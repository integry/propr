import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/** What a schedule submits each time it fires: the shape of a REST task submission. */
export interface ScheduleInstruction {
  text: string;
  agentAlias?: string;
  model?: string;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
  /** Per-task spend cap in USD; 0 or omitted uses the repository/instance cap. */
  maxCostUsd?: number;
}

export interface TaskSchedule {
  id: string;
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: ScheduleInstruction;
  enabled: boolean;
  owner: { userId: string; username: string };
  lastRunAt: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunStatus = 'dispatching' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface TaskScheduleRun {
  id: number;
  scheduleId: string;
  slot: string;
  trigger: 'schedule' | 'manual';
  status: ScheduleRunStatus;
  reason: string | null;
  submissionId: string | null;
  taskId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface UnattendedAdmission {
  maxConcurrent: number;
  window: string;
  windowError: string | null;
  running: number;
}

export interface ScheduleInput {
  name?: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: ScheduleInstruction;
  enabled?: boolean;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutation = init.method !== undefined && init.method !== 'GET';
  const response = await apiFetch(`${API_BASE_URL}/api/schedules${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
  }, mutation ? { replayMutationAfterTokenRefresh: true } : undefined);
  await handleApiResponse(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const listSchedules = () =>
  request<{ schedules: TaskSchedule[]; admission: UnattendedAdmission }>('');

export const getScheduleDetail = (id: string) =>
  request<{ schedule: TaskSchedule; runs: TaskScheduleRun[] }>(`/${encodeURIComponent(id)}`);

export const createSchedule = (input: ScheduleInput) =>
  request<{ schedule: TaskSchedule }>('', { method: 'POST', body: JSON.stringify(input) });

export const updateSchedule = (id: string, update: Partial<ScheduleInput>) =>
  request<{ schedule: TaskSchedule }>(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) });

export const deleteSchedule = (id: string) =>
  request<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const runScheduleNow = (id: string, idempotencyKey: string = crypto.randomUUID()) =>
  request<{ schedule: TaskSchedule; run: TaskScheduleRun }>(`/${encodeURIComponent(id)}/run-now`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  });
