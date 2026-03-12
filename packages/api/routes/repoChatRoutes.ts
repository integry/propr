import { Request, Response } from 'express';
import {
  buildSummaryContext,
  runLightweightLLMAnalysis,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  loadSettings,
  getEffectiveTokenLimit,
  estimateLlmDuration,
  estimateTokens,
  getMessagesForRepository,
  saveMessage,
  deleteMessage as deleteMessageFromDb,
  clearMessagesForRepository
} from '@propr/core';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RepoChatRequest {
  repository: string;
  branch?: string;
  prompt: string;
  history?: ChatMessage[];
  model?: string;
  contextLevel?: number;
}

interface SaveMessagesRequest {
  repository: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    metadata?: {
      estimatedDurationMs?: number;
      actualDurationMs?: number;
      isHistoricalEstimate?: boolean;
    };
  }>;
}

export function createRepoChatRoutes() {
  /**
   * GET /api/repos/chat/messages?repository=owner/repo
   * Get all persisted chat messages for a repository
   */
  async function getMessages(req: Request, res: Response): Promise<void> {
    try {
      const repository = req.query.repository as string;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository query parameter is required' });
        return;
      }

      const messages = await getMessagesForRepository(repository);
      res.json({ messages });
    } catch (error) {
      console.error('Error getting chat messages:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/repos/chat/messages
   * Save chat messages for a repository
   */
  async function saveMessages(req: Request, res: Response): Promise<void> {
    try {
      const { repository, messages } = req.body as SaveMessagesRequest;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required' });
        return;
      }

      if (!Array.isArray(messages)) {
        res.status(400).json({ error: 'messages must be an array' });
        return;
      }

      // Save each message
      for (const msg of messages) {
        await saveMessage({
          messageId: msg.id,
          repository,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          estimatedDurationMs: msg.metadata?.estimatedDurationMs,
          actualDurationMs: msg.metadata?.actualDurationMs,
          isHistoricalEstimate: msg.metadata?.isHistoricalEstimate,
        });
      }

      res.json({ success: true, savedCount: messages.length });
    } catch (error) {
      console.error('Error saving chat messages:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * DELETE /api/repos/chat/messages/:messageId
   * Delete a single chat message
   */
  async function deleteMessage(req: Request, res: Response): Promise<void> {
    try {
      const { messageId } = req.params;

      if (!messageId) {
        res.status(400).json({ error: 'messageId is required' });
        return;
      }

      const deleted = await deleteMessageFromDb(messageId);
      res.json({ success: deleted });
    } catch (error) {
      console.error('Error deleting chat message:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * DELETE /api/repos/chat/messages?repository=owner/repo
   * Clear all chat messages for a repository
   */
  async function clearMessages(req: Request, res: Response): Promise<void> {
    try {
      const repository = req.query.repository as string;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository query parameter is required' });
        return;
      }

      const deletedCount = await clearMessagesForRepository(repository);
      res.json({ success: true, deletedCount });
    } catch (error) {
      console.error('Error clearing chat messages:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  async function postChat(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();

    try {
      const { repository, branch, prompt, history = [], model: requestedModel, contextLevel } = req.body as RepoChatRequest;

      // Validate required fields
      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string' });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required and must be a string' });
        return;
      }

      // Parse repository into owner and name
      const [owner, repoName] = repository.split('/');
      if (!owner || !repoName) {
        res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo"' });
        return;
      }

      // Get GitHub authentication token
      let authToken: string;
      try {
        authToken = await getGitHubInstallationToken();
      } catch {
        res.status(500).json({ error: 'Failed to obtain GitHub authentication' });
        return;
      }

      // Ensure the repository is cloned/accessible
      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      let worktreePath: string;
      try {
        worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken, baseBranch: branch });
      } catch (cloneError) {
        res.status(500).json({ error: `Failed to access repository: ${(cloneError as Error).message}` });
        return;
      }

      // Build codebase context using summaries
      // Use contextLevel to determine token budget (default 50% = expanded)
      const contextPercentage = contextLevel ?? 50;
      const tokenBudget = getEffectiveTokenLimit(requestedModel, contextPercentage);
      const summaryResult = await buildSummaryContext({
        repoName: repository,
        correlationId,
        tokenBudget
      });

      // Build conversation history string
      const historyContext = history.length > 0
        ? history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n')
        : '';

      // Construct the system prompt with codebase context
      const systemPrompt = `You are a helpful assistant that answers questions about the ${repository} codebase.

## Codebase Context
The following summaries describe the structure and contents of the repository:

${summaryResult.context || 'No codebase summaries available. The repository may not be indexed yet.'}

## Instructions
- Answer the user's question based on the codebase context provided above.
- If the question cannot be answered from the available context, say so clearly.
- Be concise and helpful in your responses.
- When referencing specific files or directories, use the exact paths from the context.`;

      // Build the full prompt including history
      const fullPrompt = historyContext
        ? `${systemPrompt}\n\n## Conversation History\n${historyContext}\n\n## Current Question\n${prompt}`
        : `${systemPrompt}\n\n## Question\n${prompt}`;

      // Get model settings - use requested model or fall back to settings
      const settings = await loadSettings();
      const model = requestedModel || settings.planner_context_model || 'haiku';

      // Estimate input tokens and duration for the request
      const estimatedInputTokens = estimateTokens(fullPrompt);
      const estimation = await estimateLlmDuration({
        executionType: 'repo-chat',
        modelName: model,
        inputTokenCount: estimatedInputTokens,
        correlationId
      });

      // Call the LLM
      const issueRef = { number: 0, repoOwner: owner, repoName };
      const startTime = Date.now();
      const reply = await runLightweightLLMAnalysis({
        prompt: fullPrompt,
        model,
        correlationId,
        worktreePath,
        githubToken: authToken,
        issueRef,
        executionType: 'repo-chat',
        metadata: {
          type: 'repo-chat',
          repository,
          branch,
          historyLength: history.length
        }
      });
      const actualDurationMs = Date.now() - startTime;

      res.json({
        reply,
        estimatedDurationMs: estimation.estimatedDurationMs,
        actualDurationMs,
        isHistoricalEstimate: estimation.isHistoricalEstimate
      });
    } catch (error) {
      console.error('Error in /api/repos/chat:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  return {
    postChat,
    getMessages,
    saveMessages,
    deleteMessage,
    clearMessages
  };
}
