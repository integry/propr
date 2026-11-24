import type { IdleShutdownSource, IdleShutdownStatus } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/** `GET/PUT /api/admin/idle-shutdown`: the opt-in idle shutdown setting and live status. */
export interface IdleShutdownSettings {
  enabled: boolean;
  afterMs: number;
  after: string;
  source: IdleShutdownSource;
  environmentManaged: boolean;
  environment: Record<string, string | null>;
  warnings: string[];
  status: IdleShutdownStatus | null;
}

export async function getIdleShutdownSettings(): Promise<IdleShutdownSettings> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/idle-shutdown`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
}

export async function updateIdleShutdownSettings(update: { enabled: boolean; after?: string }): Promise<IdleShutdownSettings> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/idle-shutdown`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
  return response.json();
}
