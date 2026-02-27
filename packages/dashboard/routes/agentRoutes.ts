import { Router, Request, Response } from 'express';
import { getAgentRegistry } from '@propr/core';

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
            const analysisResult = await agent.analyze(prompt, context, query.model);
            return {
              agentId: query.agentId,
              agentAlias: agent.config.alias,
              model: analysisResult.modelUsed || query.model || 'default',
              response: analysisResult.response,
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

  return { router };
}
