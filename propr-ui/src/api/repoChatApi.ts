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
 * Options for the chatWithRepository function
 */
export interface ChatWithRepositoryOptions {
  repository: string;
  branch: string;
  prompt: string;
  history?: ChatMessage[];
  model?: string;
  contextLevel?: number;
}

/**
 * Sends a chat message to the repository chat endpoint and retrieves the AI's response.
 *
 * @param options - The chat options
 * @param options.repository - The full repository name (e.g., "owner/repo")
 * @param options.branch - The branch name to query against
 * @param options.prompt - The user's message/prompt
 * @param options.history - Previous conversation history for context
 * @param options.model - The model ID to use for the chat
 * @param options.contextLevel - The context level (0-100) for codebase analysis
 * @returns The AI's response containing the reply
 */
export const chatWithRepository = async (
  options: ChatWithRepositoryOptions
): Promise<RepoChatResponse> => {
  const { repository, branch, prompt, history = [], model, contextLevel } = options;
  const response = await fetch(`${API_BASE_URL}/api/repos/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository,
      branch,
      prompt,
      history,
      model,
      contextLevel
    }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
