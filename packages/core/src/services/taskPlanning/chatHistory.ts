/**
 * Chat history utilities for plan refinement.
 */

import crypto from 'crypto';
import { truncateToSentences } from '../planning/index.js';
import type { ChatHistoryMessage } from './types.js';

/**
 * Build the initial chat history messages to seed the refinement chat.
 * Creates a user message with the prompt summary and an assistant response
 * confirming plan generation with guidance on next steps.
 */
export function buildInitialChatHistory(prompt: string | null | undefined, taskCount: number): ChatHistoryMessage[] {
  // Handle null/undefined/empty prompt
  const safePrompt = prompt?.trim() || '';
  const promptSummary = safePrompt ? truncateToSentences(safePrompt) : 'Plan generation request';
  const userTimestamp = new Date();
  // Offset assistant message by 1ms to ensure distinct timestamps for UI sorting
  const assistantTimestamp = new Date(userTimestamp.getTime() + 1);

  const userMessage: ChatHistoryMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: promptSummary,
    timestamp: userTimestamp.toISOString()
  };

  const taskWord = taskCount === 1 ? 'issue has' : 'issues have';
  const assistantMessage: ChatHistoryMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `${taskCount} ${taskWord} been planned.\n\nI can help you refine this plan. You can:\n\n**Ask questions:**\n- "Why is task #2 structured this way?"\n- "What would happen if we combined these tasks?"\n\n**Give instructions:**\n- "Make the testing task more detailed"\n- "Split the backend task into two"\n- "Add error handling to all tasks"`,
    timestamp: assistantTimestamp.toISOString()
  };

  return [userMessage, assistantMessage];
}
