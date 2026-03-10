// Repository Chat API
import { API_BASE_URL, handleApiResponse } from './proprApi';

/**
 * Represents a message in the conversation history
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Response from the repository chat endpoint
 */
export interface RepoChatResponse {
  reply: string;
  error?: string;
}

/**
 * Sends a chat message to the repository chat endpoint and retrieves the AI's response.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @param branch - The branch name to query against
 * @param prompt - The user's message/prompt
 * @param history - Previous conversation history for context
 * @returns The AI's response containing the reply
 */
export const chatWithRepository = async (
  repository: string,
  branch: string,
  prompt: string,
  history: ChatMessage[] = []
): Promise<RepoChatResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository,
      branch,
      prompt,
      history
    }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
