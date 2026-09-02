// Agent Chat Types and API
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export interface ChatQuery {
  agentId: string;
  /** Stable synthetic configuration identity, present only for pool choices. */
  syntheticConfigId?: string;
  model?: string;
}

export interface ChatResult {
  agentId: string;
  agentAlias: string;
  model: string;
  response?: string;
  error?: string;
  durationMs: number;
  syntheticConfigId?: string;
  virtualAgentAlias?: string;
  virtualModel?: string;
  physicalAgentAlias?: string;
  physicalModel?: string;
  attemptNumber?: number;
}

export const chatWithAgents = async (
  queries: ChatQuery[],
  prompt: string,
  context: string
): Promise<{ results: ChatResult[] }> => {
  const response = await apiFetch(`${API_BASE_URL}/api/agents/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries, prompt, context }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
