import { Request, Response } from 'express';
import {
  buildSummaryContext,
  runLightweightLLMAnalysis,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  loadSettings,
  getEffectiveTokenLimit
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

export function createRepoChatRoutes() {
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

      // Call the LLM
      const issueRef = { number: 0, repoOwner: owner, repoName };
      const reply = await runLightweightLLMAnalysis({
        prompt: fullPrompt,
        model,
        correlationId,
        worktreePath,
        githubToken: authToken,
        issueRef,
        executionType: 'other',
        metadata: {
          type: 'repo-chat',
          repository,
          branch,
          historyLength: history.length
        }
      });

      res.json({ reply });
    } catch (error) {
      console.error('Error in /api/repos/chat:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  return {
    postChat
  };
}
