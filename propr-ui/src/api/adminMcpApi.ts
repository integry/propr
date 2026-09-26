import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export const MCP_ALL_SCOPES = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'] as const;
export type McpScope = typeof MCP_ALL_SCOPES[number];

export interface McpStatus {
  enabled: boolean;
  operatorForced?: 'on' | 'off';
  demoMode?: boolean;
  missingHttpsOrigin?: boolean;
  missingSecretChain?: boolean;
  keyChanged?: boolean;
  origin?: string;
  resource?: string;
  instanceId?: string;
  connectAvailable?: boolean;
  scopeCeiling: McpScope[];
}

export interface McpAdminResponse {
  status: McpStatus;
  settings: {
    enabled: boolean;
    scopeCeiling: McpScope[];
    connectEnabled: boolean;
  };
  scopes: McpScope[];
}

export interface McpUpdateRequest {
  enabled?: boolean;
  scopeCeiling?: McpScope[];
  connectEnabled?: boolean;
}

export async function getMcpAdminSettings(): Promise<McpAdminResponse> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/mcp`, {
    credentials: 'include',
  });
  await handleApiResponse(response);
  return response.json();
}

export async function updateMcpAdminSettings(update: McpUpdateRequest): Promise<{ status: McpStatus }> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/mcp`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
  return response.json();
}

export async function revokeAllMcpConnections(): Promise<{ revoked: number; status?: McpStatus }> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/mcp/revoke-all`, {
    method: 'POST',
    credentials: 'include',
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
  return response.json();
}
