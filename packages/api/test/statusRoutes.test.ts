import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import type { Agent, AgentConfig } from '@propr/core';
import type { RedisClientType } from 'redis';

type StatusRoutesDeps = {
  redisClient: RedisClientType;
  agentRegistry?: StatusAgentRegistry;
  loadAgents?: () => Promise<AgentConfig[]>;
  getIndexingQueue?: () => Promise<{ getJobCounts: (...statuses: string[]) => Promise<Record<string, number>> }>;
  agentStatusCacheTtlMs?: number;
  agentHealthTimeoutMs?: number;
  now?: () => number;
  loadSummarizationRuntimeState?: () => Promise<{
    primary_quota_failures: number;
    primary_quota_failures_by_alias: Record<string, number>;
    cooldowns: Record<string, { repository: string; branch: string; until: string; reason: string }>;
    warning?: { mode: 'fallback_degraded' | 'fallback_promoted' | 'cooldown'; message: string; recorded_at: string };
  }>;
};

type StatusAgentRegistry = {
  ensureInitialized(): Promise<void>;
  getAllAgents(): Agent[];
  getAgentById(id: string): Agent | undefined;
  getAgentByAlias(alias: string): Agent | undefined;
  createAgentFromConfig(config: AgentConfig): Agent;
};

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalNodeEnv = process.env.NODE_ENV;
const originalGhAppId = process.env.GH_APP_ID;
const originalGhPrivateKeyPath = process.env.GH_PRIVATE_KEY_PATH;
const originalGhInstallationId = process.env.GH_INSTALLATION_ID;

function createJsonResponse(): { response: ExpressResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return response;
    }
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload };
}

function createRedisClient() {
  return {
    ping: async () => 'PONG',
    get: async () => Date.now().toString(),
    sCard: async () => 1,
  };
}

function createIndexingQueue(counts: Record<string, number> = {}) {
  return {
    getJobCounts: async () => counts,
  };
}

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1',
    type: 'codex',
    alias: 'codex-prod',
    enabled: true,
    dockerImage: 'propr/agent-codex:latest',
    configPath: '/tmp/codex',
    supportedModels: ['gpt-5.5'],
    ...overrides,
  };
}

function createAgent(config: AgentConfig, healthCheck: () => Promise<boolean>): Agent {
  return {
    config,
    healthCheck,
    executeTask: async () => {
      throw new Error('not implemented');
    },
    analyze: async () => {
      throw new Error('not implemented');
    },
  };
}

function createRegistry(agents: Agent[] = []): StatusAgentRegistry {
  return {
    ensureInitialized: async () => undefined,
    getAllAgents: () => agents,
    getAgentById: (id: string) => agents.find(agent => agent.config.id === id),
    getAgentByAlias: (alias: string) => agents.find(agent => agent.config.alias === alias),
    createAgentFromConfig: (config: AgentConfig) => createAgent(config, async () => true),
  };
}

function configureStatusEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PROPR_DEMO_MODE = 'false';
  delete process.env.GH_APP_ID;
  delete process.env.GH_PRIVATE_KEY_PATH;
  delete process.env.GH_INSTALLATION_ID;
}

async function createRoutes(deps: StatusRoutesDeps) {
  const { createStatusRoutes } = await import('../routes/statusRoutes.js');
  return createStatusRoutes(deps);
}

async function readStatus(overrides: Partial<StatusRoutesDeps> = {}) {
  configureStatusEnv();
  const { response, status, body } = createJsonResponse();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [],
    agentRegistry: createRegistry(),
    getIndexingQueue: async () => createIndexingQueue(),
    ...overrides,
  });

  await routes.getStatus({} as Request, response);

  assert.equal(status(), 200);
  return body();
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalGhAppId === undefined) delete process.env.GH_APP_ID;
  else process.env.GH_APP_ID = originalGhAppId;
  if (originalGhPrivateKeyPath === undefined) delete process.env.GH_PRIVATE_KEY_PATH;
  else process.env.GH_PRIVATE_KEY_PATH = originalGhPrivateKeyPath;
  if (originalGhInstallationId === undefined) delete process.env.GH_INSTALLATION_ID;
  else process.env.GH_INSTALLATION_ID = originalGhInstallationId;
});

after(async () => {
  const { closeConnection, shutdownQueue } = await import('@propr/core');
  await closeConnection();
  await shutdownQueue();
});

test('/api/status omits disabled configured agents', async () => {
  const body = await readStatus({
    loadAgents: async () => [createAgentConfig({ enabled: false })],
  });

  assert.deepEqual(body.agents, []);
  assert.equal(body.claudeAuth, 'disconnected');
});

test('/api/status returns default Claude fallback when no agents are configured', async () => {
  const body = await readStatus();

  assert.deepEqual(body.agents, [{
    id: 'default-claude-agent',
    type: 'claude',
    alias: 'default',
    status: 'disconnected',
  }]);
});

test('/api/status includes warnings field in demo mode', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PROPR_DEMO_MODE = 'true';
  const { response, body } = createJsonResponse();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [],
    agentRegistry: createRegistry(),
    getIndexingQueue: async () => createIndexingQueue(),
  });

  await routes.getStatus({} as Request, response);

  assert.deepEqual(body().warnings, []);
});

test('/api/status caches agent health checks briefly', async () => {
  configureStatusEnv();
  let healthChecks = 0;
  let currentTime = 1000;
  const config = createAgentConfig();
  const registry = createRegistry([
    createAgent(config, async () => {
      healthChecks += 1;
      return true;
    }),
  ]);
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: registry,
    getIndexingQueue: async () => createIndexingQueue(),
    now: () => currentTime,
    agentStatusCacheTtlMs: 5000,
  });

  const first = createJsonResponse();
  await routes.getStatus({} as Request, first.response);
  currentTime += 1000;
  const second = createJsonResponse();
  await routes.getStatus({} as Request, second.response);

  assert.equal(healthChecks, 1);
  assert.deepEqual(first.body().agents, second.body().agents);
});

test('/api/status maps indexing queue states', async () => {
  const cases: Array<[Record<string, number>, string]> = [
    [{ active: 1, waiting: 0, delayed: 0, failed: 0 }, 'active'],
    [{ active: 0, waiting: 1, delayed: 0, failed: 0 }, 'queued'],
    [{ active: 0, waiting: 0, delayed: 1, failed: 0 }, 'queued'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, 'failed'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 0 }, 'idle'],
  ];

  for (const [counts, expected] of cases) {
    const body = await readStatus({
      getIndexingQueue: async () => createIndexingQueue(counts),
    });
    assert.equal(body.indexing, expected);
  }
});

test('/api/status caps summarization cooldown warnings', async () => {
  const cooldowns = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
    `cooldown-${index}`,
    {
      repository: `owner/repo-${index}`,
      branch: 'main',
      until: `2026-06-14T00:0${6 - index}:00.000Z`,
      reason: 'quota-limited',
    },
  ]));
  const body = await readStatus({
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0,
      primary_quota_failures_by_alias: {},
      cooldowns,
    }),
  });

  assert.deepEqual(body.warnings, [
    ...[6, 5, 4, 3, 2].map(index => ({
      type: 'summarization_cooldown',
      message: `owner/repo-${index} (main) summarization is paused until 2026-06-14T00:0${6 - index}:00.000Z: quota-limited`,
    })),
    {
      type: 'summarization_cooldown_summary',
      message: '2 additional repositories are in summarization cooldown.',
    },
  ]);
});
