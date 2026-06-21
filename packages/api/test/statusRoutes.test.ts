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

// Env vars that influence the resolved auth mode, intake mode, and legacy
// githubAuth health. They are snapshotted before each test and restored after so
// a developer shell or CI runner with any of them set can't make the assertions
// nondeterministic.
const MANAGED_ENV_VARS = [
  'NODE_ENV',
  'PROPR_DEMO_MODE',
  'GH_APP_ID',
  'GH_PRIVATE_KEY_PATH',
  'GH_INSTALLATION_ID',
  'GH_AUTH_MODE',
  'PROPR_GH_RELAY_URL',
  'PROPR_GH_RELAY_TOKEN',
  'GITHUB_EVENT_INTAKE_MODE',
  'ENABLE_GITHUB_WEBHOOKS',
] as const;

const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  MANAGED_ENV_VARS.map((key) => [key, process.env[key]]),
);

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
    // The daemon heartbeat key returns a timestamp; the routing key is absent by
    // default so tests that don't publish routing state see it omitted.
    get: async (key: string) => (key === 'system:status:routing' ? null : Date.now().toString()),
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
  // Clear every managed var first so inherited values can't leak into a test,
  // then set only the baseline the default-case assertions expect.
  for (const key of MANAGED_ENV_VARS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.PROPR_DEMO_MODE = 'false';
}

async function createRoutes(deps: StatusRoutesDeps) {
  const { createStatusRoutes } = await import('../routes/statusRoutes.js');
  return createStatusRoutes(deps);
}

async function readStatus(overrides: Partial<StatusRoutesDeps> = {}, configureEnv?: () => void) {
  configureStatusEnv();
  // Optional per-test env tweaks applied on top of the cleared baseline (e.g. to
  // exercise relay-auth resolution) before the route reads process.env.
  configureEnv?.();
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
  for (const key of MANAGED_ENV_VARS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
  configureStatusEnv();
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

test('/api/status reports resolved auth mode and event intake mode', async () => {
  const body = await readStatus();

  // configureStatusEnv() clears all GitHub auth config, so the auth mode
  // resolves to 'none' and the intake mode defaults to routing_websocket.
  assert.equal(body.githubAuthMode, 'none');
  assert.equal(body.githubEventIntake, 'routing_websocket');
});

test('/api/status includes routing state published by the daemon', async () => {
  const routingState = {
    connected: true,
    routingUrl: 'wss://routing.example',
    lastDeliveryId: 'd-1',
    lastAckAt: '2026-06-21T03:00:00.000Z',
  };
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) =>
      key === 'system:status:routing' ? JSON.stringify(routingState) : Date.now().toString(),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });

  assert.deepEqual(body.routing, routingState);
});

test('/api/status reports connected githubAuth for relay-auth deployments', async () => {
  const body = await readStatus({}, () => {
    process.env.PROPR_GH_RELAY_URL = 'https://relay.example';
    process.env.PROPR_GH_RELAY_TOKEN = 'relay-token';
  });

  assert.equal(body.githubAuthMode, 'relay');
  assert.equal(body.githubAuth, 'connected');
});

test('/api/status reports unknown auth mode and disconnected health when the resolver is bypassed', async () => {
  // 'none' (nothing configured) is the disconnected case the legacy field must
  // still report so misconfiguration surfaces rather than masquerading as healthy.
  const body = await readStatus();

  assert.equal(body.githubAuthMode, 'none');
  assert.equal(body.githubAuth, 'disconnected');
});

test('/api/status omits malformed routing state', async () => {
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) =>
      key === 'system:status:routing'
        ? JSON.stringify({ connected: 'yes', routingUrl: 42 })
        : Date.now().toString(),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });

  assert.equal('routing' in body, false);
});

test('/api/status omits routing state with a malformed lastAckAt timestamp', async () => {
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) =>
      key === 'system:status:routing'
        ? JSON.stringify({
            connected: true,
            routingUrl: 'wss://routing.example',
            lastDeliveryId: 'd-1',
            lastAckAt: 'not-a-timestamp',
          })
        : Date.now().toString(),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });

  // An unparseable ACK timestamp is rejected at the API boundary rather than
  // surfaced to consumers as a bogus date.
  assert.equal('routing' in body, false);
});

test('/api/status omits routing state when none is published', async () => {
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) => (key === 'system:status:routing' ? null : Date.now().toString()),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });

  assert.equal('routing' in body, false);
});

test('/api/status reports demo auth mode in demo mode', async () => {
  configureStatusEnv();
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

  assert.equal(body().githubAuthMode, 'demo');
  assert.equal(body().githubEventIntake, 'routing_websocket');
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
      message: `owner/repo-${index} (main) summarization is paused until ${new Date(`2026-06-14T00:0${6 - index}:00.000Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })}: quota-limited`,
    })),
    {
      type: 'summarization_cooldown_summary',
      message: '2 additional repositories are in summarization cooldown.',
    },
  ]);
});
