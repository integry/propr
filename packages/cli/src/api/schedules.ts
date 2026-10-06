/**
 * Scheduled Tasks API
 *
 * Typed access to the recurring task schedule endpoints (`/api/schedules`).
 */

import { ApiClient, createApiClient } from "./client.js";

/** What a schedule submits each time it fires, in the shape of a task submission. */
export interface ScheduleInstruction {
  text: string;
  agentAlias?: string;
  model?: string;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
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

export interface TaskScheduleRun {
  id: number;
  scheduleId: string;
  slot: string;
  trigger: "schedule" | "manual";
  status: "dispatching" | "dispatched" | "succeeded" | "failed" | "cancelled" | "skipped";
  reason: string | null;
  submissionId: string | null;
  taskId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Instance limits on unattended (scheduled) work, and how much is running now. */
export interface ScheduleAdmission {
  maxConcurrent: number;
  window: unknown;
  windowError: string | null;
  running: number;
}

export interface ListSchedulesResponse {
  schedules: TaskSchedule[];
  admission?: ScheduleAdmission;
}

export interface CreateScheduleRequest {
  name?: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: ScheduleInstruction;
  enabled?: boolean;
}

export interface RunScheduleNowResponse {
  schedule: TaskSchedule;
  run: TaskScheduleRun;
}

export async function listSchedules(repository?: string, client?: ApiClient): Promise<ListSchedulesResponse> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<ListSchedulesResponse>("/api/schedules", {
    params: { repository },
  });
  return response.data;
}

export async function getSchedule(id: string, client?: ApiClient): Promise<{ schedule: TaskSchedule; runs: TaskScheduleRun[] }> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<{ schedule: TaskSchedule; runs: TaskScheduleRun[] }>(
    `/api/schedules/${encodeURIComponent(id)}`
  );
  return response.data;
}

export async function createSchedule(request: CreateScheduleRequest, client?: ApiClient): Promise<TaskSchedule> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<{ schedule: TaskSchedule }>("/api/schedules", { body: request });
  return response.data.schedule;
}

export async function deleteSchedule(id: string, client?: ApiClient): Promise<void> {
  const apiClient = client ?? (await createApiClient());
  await apiClient.delete<unknown>(`/api/schedules/${encodeURIComponent(id)}`);
}

/** Runs a schedule once now. The key makes a retried request reuse the same manual run. */
export async function runScheduleNow(id: string, idempotencyKey: string, client?: ApiClient): Promise<RunScheduleNowResponse> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<RunScheduleNowResponse>(
    `/api/schedules/${encodeURIComponent(id)}/run-now`,
    { headers: { "Idempotency-Key": idempotencyKey } }
  );
  return response.data;
}
