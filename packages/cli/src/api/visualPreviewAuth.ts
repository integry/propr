import type { ApiClient } from './client.js';

export interface VisualPreviewAuthStatus {
  configured: boolean;
  source?: 'github' | 'connect' | 'static_token' | 'environment';
  status: 'active' | 'reauth_required' | 'missing';
  githubUsername?: string;
}

export async function getVisualPreviewAuthStatus(client: ApiClient): Promise<VisualPreviewAuthStatus> {
  return (await client.get<VisualPreviewAuthStatus>('/api/config/visual-preview-auth')).data;
}

export async function saveVisualPreviewUploadToken(
  token: string,
  client: ApiClient,
): Promise<VisualPreviewAuthStatus> {
  return (await client.put<VisualPreviewAuthStatus>('/api/config/visual-preview-auth/token', {
    body: { token },
  })).data;
}
