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
  /** Estimated duration for the LLM call in milliseconds */
  estimatedDurationMs?: number;
  /** Actual duration for the LLM call in milliseconds */
  actualDurationMs?: number;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
}

/**
 * Persisted chat message with full metadata
 */
export interface PersistedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: {
    estimatedDurationMs?: number;
    actualDurationMs?: number;
    isHistoricalEstimate?: boolean;
  };
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

/**
 * Get all persisted chat messages for a repository.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @returns Array of persisted chat messages
 */
export const getChatMessages = async (
  repository: string
): Promise<PersistedChatMessage[]> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/chat/messages?repository=${encodeURIComponent(repository)}`,
    {
      method: 'GET',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.messages || [];
};

/**
 * Save chat messages for a repository.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @param messages - Array of messages to save
 */
export const saveChatMessages = async (
  repository: string,
  messages: PersistedChatMessage[]
): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/chat/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, messages }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/**
 * Delete a single chat message by ID.
 *
 * @param messageId - The ID of the message to delete
 * @returns Whether the message was deleted
 */
export const deleteChatMessage = async (
  messageId: string
): Promise<boolean> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/chat/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.success;
};

/**
 * Clear all chat messages for a repository.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @returns Number of messages deleted
 */
export const clearChatMessages = async (
  repository: string
): Promise<number> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/chat/messages?repository=${encodeURIComponent(repository)}`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.deletedCount;
};
