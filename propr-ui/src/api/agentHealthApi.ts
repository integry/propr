import { API_BASE_URL, apiFetch, handleApiResponse, shareInFlightApiRead } from './apiClient';

export interface AgentHealthResult {
  agentId: string;
  status: 'ready' | 'error' | 'disabled';
  model?: string;
  error?: string;
  errorCode?: 'auth_required' | 'rate_limit' | 'unknown';
}

export function checkAgentHealth(agentId: string, configurationKey = agentId, fresh = false): Promise<AgentHealthResult> {
  // Both responsive layouts and StrictMode can mount the same configuration.
  // Share concurrent probes within the current authenticated instance scope.
  return shareInFlightApiRead(`agent-health:${configurationKey}:${fresh}`, async signal => {
    const response = await apiFetch(`${API_BASE_URL}/api/agents/${encodeURIComponent(agentId)}/health${fresh ? '?fresh=true' : ''}`, {
      method: 'POST',
      credentials: 'include',
      signal,
    });
    await handleApiResponse(response);
    return response.json();
  });
}
