// Agent Chat Types and API
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

export interface ChatQuery {
  agentId: string;
  model?: string;
}

export interface ChatResult {
  agentId: string;
  agentAlias: string;
  model: string;
  response?: string;
  error?: string;
  durationMs: number;
}

export const chatWithAgents = async (
  queries: ChatQuery[],
  prompt: string,
  context: string
): Promise<{ results: ChatResult[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/agents/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries, prompt, context }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
