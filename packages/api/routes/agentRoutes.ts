import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  getAgentRegistry,
  loadAgents,
  resolveConfigPath,
  toProprOpenCodeExternalModelId,
  toProprOpenCodeModelId,
  type Agent,
  type AgentRegistry,
  SyntheticAgent,
} from '@propr/core';
import { AGENT_DEFAULTS, isManagedAgentConfigPath } from '@propr/shared';
import { requireManageAgents } from '../permissionGuards.js';

const execFileAsync = promisify(execFile);

interface AgentChatQuery {
  agentId: string;
  syntheticConfigId?: string;
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
  syntheticConfigId?: string;
  virtualAgentAlias?: string;
  virtualModel?: string;
  physicalAgentAlias?: string;
  physicalModel?: string;
  attemptNumber?: number;
}

interface ChatRoutingMetadata {
  virtualAgentAlias?: string;
  virtualModel?: string;
  physicalAgentAlias?: string;
  physicalModel?: string;
  attemptNumber?: number;
}

function chatRoutingFields(metadata: Record<string, unknown> | undefined): ChatRoutingMetadata {
  if (!metadata) return {};
  return {
    virtualAgentAlias: typeof metadata.virtualAgentAlias === 'string' ? metadata.virtualAgentAlias : undefined,
    virtualModel: typeof metadata.virtualModel === 'string' ? metadata.virtualModel : undefined,
    physicalAgentAlias: typeof metadata.physicalAgentAlias === 'string' ? metadata.physicalAgentAlias : undefined,
    physicalModel: typeof metadata.physicalModel === 'string' ? metadata.physicalModel : undefined,
    attemptNumber: typeof metadata.attemptNumber === 'number' ? metadata.attemptNumber : undefined,
  };
}

function resolveHostPath(configPath: string): string {
  if (configPath === '~') return os.homedir();
  if (configPath.startsWith('~/')) return path.join(os.homedir(), configPath.slice(2));
  return path.resolve(configPath);
}

function inferOpenCodeDataPath(configPath: string, managedCredentials = false): string {
  if (!managedCredentials && process.env.HOST_OPENCODE_DATA_DIR) {
    return resolveHostPath(process.env.HOST_OPENCODE_DATA_DIR);
  }
  if (!managedCredentials && process.env.OPENCODE_DATA_PATH) {
    return resolveHostPath(process.env.OPENCODE_DATA_PATH);
  }
  const normalized = path.normalize(configPath);
  if (normalized.endsWith(path.join('.config', 'opencode'))) {
    return path.join(path.dirname(path.dirname(normalized)), '.local', 'share', 'opencode');
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

async function discoverOpenCodeModels(agentId?: string): Promise<string[]> {
  const agents = await loadAgents();
  const savedAgent = agents.find(agent => agent.type === 'opencode' && (agentId ? agent.id === agentId : true));
  const managedCredentials = Boolean(
    savedAgent && isManagedAgentConfigPath(savedAgent.configPath),
  );
  const configuredPath = managedCredentials
    ? savedAgent!.configPath
    : process.env.OPENCODE_CONFIG_PATH || savedAgent?.configPath || AGENT_DEFAULTS.opencode.configPath;
  const configPath = managedCredentials
    ? resolveConfigPath(configuredPath)
    : resolveHostPath(configuredPath);
  const dataPath = inferOpenCodeDataPath(configPath, managedCredentials);
  const dockerImage = await resolveOpenCodeDiscoveryImage(savedAgent?.dockerImage);

  const args = [
    'run', '--rm', '--user', '0:0',
    '-v', `${configPath}:/home/node/.config/opencode:rw`,
    '-v', `${dataPath}:/home/node/.local/share/opencode:rw`,
    ...(managedCredentials ? ['-e', 'PROPR_MANAGED_CREDENTIALS=1'] : []),
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
  if (process.env.AGENT_DOCKER_IMAGE) return process.env.AGENT_DOCKER_IMAGE;
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

async function executeChatQuery(
  registry: AgentRegistry,
  query: AgentChatQuery,
  prompt: string,
  context: string | undefined,
): Promise<AgentChatResult> {
  const requestedAgentId = query.syntheticConfigId || query.agentId;
  const agent = await resolveChatAgent(registry, requestedAgentId);

  if (!agent) {
    return {
      agentId: requestedAgentId,
      model: query.model || 'default',
      error: 'Agent not found',
      durationMs: 0,
    };
  }

  const start = Date.now();
  const routingSession = agent instanceof SyntheticAgent
    ? agent.beginRoutingSession(query.model)
    : undefined;

  try {
    const analysisResult = routingSession
      ? await routingSession.analyze(prompt, { context, model: query.model })
      : await agent.analyze(prompt, { context, model: query.model });
    const routing = chatRoutingFields(routingSession?.routingMetadata);
    return {
      agentId: requestedAgentId,
      ...(query.syntheticConfigId ? { syntheticConfigId: query.syntheticConfigId } : {}),
      agentAlias: agent.config.alias,
      model: routing.virtualModel || canonicalChatModel(agent, analysisResult.modelUsed || query.model),
      ...routing,
      response: analysisResult.response,
      error: analysisResult.success === false ? (analysisResult.error || 'Analysis failed') : undefined,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const routing = chatRoutingFields(routingSession?.routingMetadata);
    return {
      agentId: requestedAgentId,
      ...(query.syntheticConfigId ? { syntheticConfigId: query.syntheticConfigId } : {}),
      agentAlias: agent.config.alias,
      model: routing.virtualModel || canonicalChatModel(agent, query.model),
      ...routing,
      error: (error as Error).message,
      durationMs: Date.now() - start,
    };
  }
}

export function createAgentRoutes() {
  const router = Router();

  router.get('/opencode/models', requireManageAgents, async (req: Request, res: Response): Promise<void> => {
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

  // Chat executes an already-configured agent; it does not mutate installation
  // agent configuration, so authenticated members may use it.
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
        results.push(await executeChatQuery(registry, query, prompt, context));
      }

      res.json({ results });
    } catch (error) {
      console.error('Error in /api/agents/chat:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { router };
}
