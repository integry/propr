import type { AgentType } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type AgentLoginSessionStatus =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface AgentLoginSession {
  id: string;
  agentId: string;
  agentType: AgentType;
  status: AgentLoginSessionStatus;
  output: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  exitCode?: number;
  error?: string;
}

function sessionUrl(agentId: string, sessionId?: string): string {
  const base = `${API_BASE_URL}/api/agents/${encodeURIComponent(agentId)}/login-sessions`;
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

async function handleAgentLoginResponse(response: Response): Promise<void> {
  if (!response.ok && response.status !== 401) {
    let data: { error?: string } | undefined;
    try {
      data = await response.clone().json() as { error?: string };
    } catch { /* Preserve the shared HTTP fallback for malformed responses. */ }
    if (data?.error) throw new Error(data.error);
  }
  await handleApiResponse(response);
}

export async function startAgentLogin(agentId: string): Promise<AgentLoginSession> {
  const response = await apiFetch(sessionUrl(agentId), {
    method: 'POST',
    credentials: 'include',
  });
  await handleAgentLoginResponse(response);
  return response.json();
}

export async function getAgentLogin(
  agentId: string,
  sessionId: string,
): Promise<AgentLoginSession> {
  const response = await apiFetch(sessionUrl(agentId, sessionId), {
    credentials: 'include',
  });
  await handleAgentLoginResponse(response);
  return response.json();
}

export async function sendAgentLoginInput(
  agentId: string,
  sessionId: string,
  input: string,
): Promise<AgentLoginSession> {
  const response = await apiFetch(`${sessionUrl(agentId, sessionId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
    credentials: 'include',
  });
  await handleAgentLoginResponse(response);
  return response.json();
}

export async function cancelAgentLogin(
  agentId: string,
  sessionId: string,
): Promise<AgentLoginSession> {
  const response = await apiFetch(sessionUrl(agentId, sessionId), {
    method: 'DELETE',
    credentials: 'include',
  });
  await handleAgentLoginResponse(response);
  return response.json();
}
