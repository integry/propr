import { Router, Request, Response } from 'express';
import { getAgentRegistry } from '@gitfix/core';

interface ChatQuery {
    agentId: string;
    model?: string;
}

interface ChatRequest {
    queries: ChatQuery[];
    prompt: string;
    context?: string;
}

interface ChatResult {
    agentId: string;
    agentAlias?: string;
    model: string;
    response?: string;
    error?: string;
    durationMs: number;
}

interface ChatResponse {
    results: ChatResult[];
}

export function createAgentRoutes() {
    const router = Router();

    router.post('/chat', async (req: Request, res: Response): Promise<void> => {
        try {
            const { queries, prompt, context } = req.body as ChatRequest;

            if (!queries || !Array.isArray(queries) || queries.length === 0) {
                res.status(400).json({ error: 'Invalid queries array' });
                return;
            }

            if (!prompt || typeof prompt !== 'string') {
                res.status(400).json({ error: 'Invalid prompt' });
                return;
            }

            const registry = getAgentRegistry();
            await registry.ensureInitialized();

            const results: ChatResult[] = await Promise.all(
                queries.map(async (query: ChatQuery): Promise<ChatResult> => {
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

            const response: ChatResponse = { results };
            res.json(response);
        } catch (error) {
            console.error('Error in /api/agents/chat:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return { router };
}
