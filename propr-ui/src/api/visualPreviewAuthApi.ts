import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type VisualPreviewAuthStatusValue = 'active' | 'reauth_required' | 'missing';

export interface VisualPreviewAuthStatus {
  configured: boolean;
  source?: 'github' | 'connect' | 'environment';
  status: VisualPreviewAuthStatusValue;
  githubUsername?: string;
  currentUsername?: string;
  canUseCurrentLogin: boolean;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastErrorCode?: string;
  updatedAt?: string;
}

export async function getVisualPreviewAuthStatus(): Promise<VisualPreviewAuthStatus> {
  const response = await apiFetch(`${API_BASE_URL}/api/config/visual-preview-auth`, {
    credentials: 'include',
  });
  await handleApiResponse(response);
  return response.json();
}

export async function connectCurrentGitHubLoginForVisualPreviews(): Promise<VisualPreviewAuthStatus> {
  const response = await apiFetch(`${API_BASE_URL}/api/config/visual-preview-auth`, {
    method: 'POST',
    credentials: 'include',
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
  return response.json();
}

export async function disconnectVisualPreviewAuth(): Promise<void> {
  const response = await apiFetch(`${API_BASE_URL}/api/config/visual-preview-auth`, {
    method: 'DELETE',
    credentials: 'include',
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
}
