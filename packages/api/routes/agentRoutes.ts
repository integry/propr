import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { getAgentRegistry, loadAgents, toProprOpenCodeExternalModelId, toProprOpenCodeModelId, type Agent, type AgentRegistry } from '@propr/core';
import { AGENT_DEFAULTS } from '@propr/shared';

const execFileAsync = promisify(execFile);

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

function resolveHostPath(configPath: string): string {
  if (configPath === '~') return os.homedir();
  if (configPath.startsWith('~/')) return path.join(os.homedir(), configPath.slice(2));
  return path.resolve(configPath);
}

function inferOpenCodeDataPath(configPath: string): string {
  if (process.env.HOST_OPENCODE_DATA_DIR) return resolveHostPath(process.env.HOST_OPENCODE_DATA_DIR);
  if (process.env.OPENCODE_DATA_PATH) return resolveHostPath(process.env.OPENCODE_DATA_PATH);
  const normalized = path.normalize(configPath);
  if (normalized.endsWith(path.join('.config', 'opencode'))) {
    return path.join(path.dirname(path.dirname(normalized)), '.local', 'share', 'opencode');
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

async function discoverOpenCodeModels(agentId?: string): Promise<string[]> {
  const agents = await loadAgents();
  const savedAgent = agents.find(agent => agent.type === 'opencode' && (agentId ? agent.id === agentId : true));
  const configPath = resolveHostPath(process.env.OPENCODE_CONFIG_PATH || savedAgent?.configPath || AGENT_DEFAULTS.opencode.configPath);
  const dataPath = inferOpenCodeDataPath(configPath);
  const dockerImage = await resolveOpenCodeDiscoveryImage(savedAgent?.dockerImage);

  const args = [
    'run', '--rm', '--user', '0:0',
    '-v', `${configPath}:/home/node/.config/opencode:rw`,
    '-v', `${dataPath}:/home/node/.local/share/opencode:rw`,
    '-v', '/tmp:/home/node/workspace:ro',
    '-w', '/home/node/workspace',
    dockerImage,
    'opencode', 'models'
  ];
  const { stdout } = await execFileAsync('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.includes(' ') && line.includes('/'))
    .map(toProprOpenCodeExternalModelId);
}

async function hasLocalDockerImage(image: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['image', 'inspect', image], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function resolveOpenCodeDiscoveryImage(savedDockerImage?: string): Promise<string> {
  if (process.env.OPENCODE_DOCKER_IMAGE) return process.env.OPENCODE_DOCKER_IMAGE;
  const fallbackImage = AGENT_DEFAULTS.opencode.dockerImage;
  if (!savedDockerImage || savedDockerImage === fallbackImage) return fallbackImage;
  return await hasLocalDockerImage(savedDockerImage) ? savedDockerImage : fallbackImage;
}

async function resolveChatAgent(registry: AgentRegistry, agentIdOrAlias: string): Promise<Agent | undefined> {
  const findRegisteredAgent = () =>
    registry.getAgentById(agentIdOrAlias) || registry.getAgentByAlias(agentIdOrAlias);

  let agent = findRegisteredAgent();
  if (agent) return agent;

  await registry.refresh();
  agent = findRegisteredAgent();
  if (agent) return agent;

  const savedAgent = (await loadAgents()).find(config =>
    config.enabled && (config.id === agentIdOrAlias || config.alias === agentIdOrAlias)
  );
  return savedAgent ? registry.createAgentFromConfig(savedAgent) : undefined;
}

function canonicalChatModel(agent: Agent, model: string | undefined): string {
  const fallbackModel = model || agent.config.defaultModel || 'default';
  return agent.config.type === 'opencode' && fallbackModel !== 'default'
    ? toProprOpenCodeModelId(fallbackModel)
    : fallbackModel;
}

export function createAgentRoutes() {
  const router = Router();

  router.get('/opencode/models', async (req: Request, res: Response): Promise<void> => {
    try {
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
      const models = await discoverOpenCodeModels(agentId);
      res.json({ models });
    } catch (error) {
      const err = error as Error;
      console.error('Error in /api/agents/opencode/models:', err);
      res.status(502).json({ error: 'Failed to discover OpenCode models', details: err.message });
    }
  });

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

      // Execute sequentially because several CLI agents keep shared session/state
      // files under their auth directory and can fail when multiple containers
      // use the same agent credentials concurrently.
      const results: AgentChatResult[] = [];
      for (const query of queries) {
          const agent = await resolveChatAgent(registry, query.agentId);

          if (!agent) {
            results.push({
              agentId: query.agentId,
              model: query.model || 'default',
              error: 'Agent not found',
              durationMs: 0
            });
            continue;
          }

          const start = Date.now();
          try {
            const analysisResult = await agent.analyze(prompt, { context, model: query.model });
            results.push({
              agentId: query.agentId,
              agentAlias: agent.config.alias,
              model: canonicalChatModel(agent, analysisResult.modelUsed || query.model),
              response: analysisResult.response,
              error: analysisResult.success === false ? (analysisResult.error || 'Analysis failed') : undefined,
              durationMs: Date.now() - start
            });
          } catch (err) {
            results.push({
              agentId: query.agentId,
              agentAlias: agent.config.alias,
              model: canonicalChatModel(agent, query.model),
              error: (err as Error).message,
              durationMs: Date.now() - start
            });
          }
      }

      res.json({ results });
    } catch (error) {
      console.error('Error in /api/agents/chat:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { router };
}
