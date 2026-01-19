import { Router, Request, Response } from 'express';
import { getAgentRegistry, getClaudeUsageStats, ClaudeUsageStats, AgentConfig, Agent } from '@gitfix/core';
import * as configManager from '@gitfix/core';

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
   * Works for both enabled and disabled agents.
   */
  router.get('/:agentId/usage', async (req: Request, res: Response): Promise<void> => {
    try {
      const { agentId } = req.params;

      // Load agent config directly from config (works for both enabled and disabled agents)
      const allAgentConfigs: AgentConfig[] = await configManager.loadAgents();
      const agentConfig = allAgentConfigs.find((a: AgentConfig) => a.id === agentId);

      if (!agentConfig) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Currently only Claude agents support usage stats
      if (agentConfig.type !== 'claude') {
        res.status(400).json({
          error: 'Usage stats only available for Claude agents',
          agentType: agentConfig.type
        });
        return;
      }

      const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
      if (!githubToken) {
        res.status(500).json({ error: 'GitHub token not configured' });
        return;
      }

      // Try to get an enabled agent for LLM parsing (use registry if available)
      const registry = getAgentRegistry();
      await registry.ensureInitialized();

      // Try to get the specific agent first (if enabled), otherwise get any enabled Claude agent
      let parsingAgent: Agent | undefined = registry.getAgentById(agentId);
      if (!parsingAgent) {
        // Fall back to any enabled Claude agent for parsing
        const allAgents = registry.getAllAgents();
        parsingAgent = allAgents.find((a: Agent) => a.config.type === 'claude');
      }

      // Create LLM parsing function if we have an available agent
      const parseWithLLM = parsingAgent
        ? async (rawOutput: string): Promise<Partial<ClaudeUsageStats>> => {
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
              // Use an available agent's analyze function with haiku for lightweight parsing
              const analysisResult = await parsingAgent!.analyze(parsingPrompt, undefined, 'haiku');

              // Try to extract JSON from the response
              const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
              }
              return {};
            } catch {
              return {};
            }
          }
        : undefined; // No LLM parsing if no enabled Claude agent available

      const usageStats = await getClaudeUsageStats(githubToken, parseWithLLM);

      res.json({
        agentId,
        agentAlias: agentConfig.alias,
        agentType: agentConfig.type,
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
