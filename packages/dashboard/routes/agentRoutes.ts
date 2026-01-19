import { Router, Request, Response } from 'express';
import { getAgentRegistry, getClaudeUsageStats, ClaudeUsageStats } from '@gitfix/core';

interface AgentChatQuery {
  agentId: string;
  model?: string;
}

interface AgentChatRequest {
  queries: AgentChatQuery[];
  prompt: string;
  context?: string;
}

interface AgentChatResult {
  agentId: string;
  agentAlias?: string;
  model: string;
  response?: string;
  error?: string;
  durationMs: number;
}

export function createAgentRoutes() {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    try {
      const { queries, prompt, context } = req.body as AgentChatRequest;

      // Validate input
      if (!queries || !Array.isArray(queries) || queries.length === 0) {
        res.status(400).json({ error: 'Invalid queries array' });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required and must be a string' });
        return;
      }

      // Get agent registry
      const registry = getAgentRegistry();
      await registry.ensureInitialized();

      // Execute all queries in parallel
      const results = await Promise.all(
        queries.map(async (query): Promise<AgentChatResult> => {
          const agent = registry.getAgentById(query.agentId);

          if (!agent) {
            return {
              agentId: query.agentId,
              model: query.model || 'default',
              error: 'Agent not found',
              durationMs: 0
            };
          }

          const start = Date.now();
          try {
            const response = await agent.analyze(prompt, context, query.model);
            return {
              agentId: query.agentId,
              agentAlias: agent.config.alias,
              model: query.model || 'default',
              response,
              durationMs: Date.now() - start
            };
          } catch (err) {
            return {
              agentId: query.agentId,
              agentAlias: agent.config.alias,
              model: query.model || 'default',
              error: (err as Error).message,
              durationMs: Date.now() - start
            };
          }
        })
      );

      res.json({ results });
    } catch (error) {
      console.error('Error in /api/agents/chat:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/agents/:agentId/usage
   * Fetches usage statistics for a specific agent.
   * Currently only supported for Claude agents.
   */
  router.get('/:agentId/usage', async (req: Request, res: Response): Promise<void> => {
    try {
      const { agentId } = req.params;

      // Get agent registry and find the agent
      const registry = getAgentRegistry();
      await registry.ensureInitialized();
      const agent = registry.getAgentById(agentId);

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Currently only Claude agents support usage stats
      if (agent.config.type !== 'claude') {
        res.status(400).json({
          error: 'Usage stats only available for Claude agents',
          agentType: agent.config.type
        });
        return;
      }

      const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
      if (!githubToken) {
        res.status(500).json({ error: 'GitHub token not configured' });
        return;
      }

      // Create LLM parsing function that uses the agent itself
      const parseWithLLM = async (rawOutput: string): Promise<Partial<ClaudeUsageStats>> => {
        const parsingPrompt = `You are parsing the raw terminal output from a Claude Code /usage command.
Extract the following information and return it as a JSON object:

{
  "currentSessionUsed": <number 0-100, the current session usage percentage>,
  "sessionResetTime": <string or null, when the session resets, e.g. "5am (Europe/Berlin)">,
  "currentWeekAllModelsUsed": <number 0-100, the current week usage for all models>,
  "weekAllModelsResetTime": <string or null, when the week resets for all models>,
  "currentWeekSonnetUsed": <number 0-100 or null, the current week usage for Sonnet only>,
  "weekSonnetResetTime": <string or null, when Sonnet week resets>
}

Return ONLY the JSON object, no other text.

Raw terminal output to parse:
${rawOutput}`;

        try {
          // Use the same agent's analyze function with haiku for lightweight parsing
          const analysisResult = await agent.analyze(parsingPrompt, undefined, 'haiku');

          // Try to extract JSON from the response
          const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
          return {};
        } catch {
          return {};
        }
      };

      const usageStats = await getClaudeUsageStats(githubToken, parseWithLLM);

      res.json({
        agentId,
        agentAlias: agent.config.alias,
        agentType: agent.config.type,
        usage: usageStats
      });
    } catch (error) {
      console.error('Error fetching agent usage stats:', error);
      res.status(500).json({
        error: 'Failed to fetch usage stats',
        details: (error as Error).message
      });
    }
  });

  return { router };
}
