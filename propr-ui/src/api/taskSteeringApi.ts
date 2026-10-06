import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import type { TaskSteeringCapability } from '@propr/shared';

export interface TaskSteer {
  id: string;
  sequence: number;
  taskId: string;
  author: string;
  authorSource: 'session' | 'token' | 'mcp';
  message: string;
  createdAt: string;
  deliveredAt: string | null;
  delivery: 'live' | 'replacement_prompt' | null;
  acknowledgedAt: string | null;
}

export interface TaskSteeringState {
  steers: TaskSteer[];
  running: boolean;
  capability: TaskSteeringCapability;
  agentAlias: string | null;
  agentType: string | null;
  maxMessageLength: number;
  maxSteersPerRun: number;
}

export interface SteerTaskResponse extends Omit<TaskSteeringState, 'steers'> {
  steer: TaskSteer;
}

export const getTaskSteering = async (taskId: string): Promise<TaskSteeringState> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/steers`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const steerTask = async (taskId: string, message: string): Promise<SteerTaskResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    credentials: 'include',
  });
  await handleApiResponse(response);
  return response.json();
};
