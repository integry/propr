import type { AgentCredentialStatusResponse, PastedAgentCredentialKind } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type { AgentCredentialStatusResponse, PastedAgentCredentialKind };

function credentialsUrl(agentId: string, kind?: string): string {
  const base = `${API_BASE_URL}/api/agents/${encodeURIComponent(agentId)}/credentials`;
  return kind ? `${base}/${encodeURIComponent(kind)}` : base;
}

async function handleCredentialResponse(response: Response): Promise<AgentCredentialStatusResponse> {
  if (!response.ok && response.status !== 401) {
    let data: { error?: string } | undefined;
    try {
      data = await response.clone().json() as { error?: string };
    } catch { /* Fall back to the shared HTTP error. */ }
    if (data?.error) throw new Error(data.error);
  }
  await handleApiResponse(response);
  return response.json();
}

export async function getAgentCredentials(agentId: string): Promise<AgentCredentialStatusResponse> {
  const response = await apiFetch(credentialsUrl(agentId), { credentials: 'include' });
  return handleCredentialResponse(response);
}

/** Store a pasted credential. The value is sent once and never returned. */
export async function setAgentCredential(
  agentId: string,
  kind: PastedAgentCredentialKind,
  value: string,
): Promise<AgentCredentialStatusResponse> {
  const response = await apiFetch(credentialsUrl(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, value }),
    credentials: 'include',
  });
  return handleCredentialResponse(response);
}

export async function clearAgentCredential(
  agentId: string,
  kind: PastedAgentCredentialKind,
): Promise<AgentCredentialStatusResponse> {
  const response = await apiFetch(credentialsUrl(agentId, kind), {
    method: 'DELETE',
    credentials: 'include',
  });
  return handleCredentialResponse(response);
}
