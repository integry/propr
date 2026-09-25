/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import type { Agent, AgentConfig } from '@propr/core';
import type { RedisClientType } from 'redis';
import {
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
  PROPR_VERSION,
  parseProprDesktopDiscovery,
} from '@propr/shared';
import type { SyntheticAgentConfig } from '@propr/shared';

type StatusRoutesDeps = {
  redisClient: RedisClientType;
  agentRegistry?: StatusAgentRegistry;
  loadAgents?: () => Promise<AgentConfig[]>;
  loadSyntheticAgents?: () => Promise<SyntheticAgentConfig[]>;
  getIndexingQueue?: () => Promise<{
    getJobCounts: (...statuses: string[]) => Promise<Record<string, number>>;
    getJobs: (
      statuses: string[],
      start?: number,
      end?: number,
      asc?: boolean,
    ) => Promise<Array<{ finishedOn?: number; timestamp?: number }>>;
  }>;
  agentStatusCacheTtlMs?: number;
  agentStatusCacheMaxAgeMs?: number;
  agentHealthTimeoutMs?: number;
  statusDependencyTimeoutMs?: number;
  now?: () => number;
  loadSummarizationRuntimeState?: () => Promise<{
    primary_quota_failures: number;
    primary_quota_failures_by_alias: Record<string, number>;
    cooldowns: Record<string, { repository: string; branch: string; until: string; reason: string }>;
    warning?: { mode: 'fallback_degraded' | 'fallback_promoted' | 'cooldown'; message: string; recorded_at: string };
  }>;
  projectSystemSnapshot?: (
    snapshot: Record<string, unknown> & { timestamp: string },
    additionalAdministratorIds: readonly string[],
  ) => Promise<void>;
  getPublicInstanceIdentity?: () => string;
};

type StatusAgentRegistry = {
  ensureInitialized(): Promise<void>;
  getAllAgents(): Agent[];
  getAgentById(id: string): Agent | undefined;
  getAgentByAlias(alias: string): Agent | undefined;
  createAgentFromConfig(config: AgentConfig): Agent;
  getOperationalStatus?(): {
    unifiedAgentImage: {
      status: 'ready' | 'unavailable';
      imageTag?: string;
      error?: string;
      recordedAt?: string;
    };
  };
};

// Env vars that influence resolved auth, intake, and agent status. They are
// snapshotted before each test and restored after so a developer shell or CI
// runner with any of them set can't make the assertions nondeterministic.
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
  'API_PUBLIC_URL',
  'AGENT_DOCKER_IMAGE',
  'CLAUDE_CONFIG_PATH',
] as const;

const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  MANAGED_ENV_VARS.map((key) => [key, process.env[key]]),
);

function createJsonResponse(): {
  response: ExpressResponse;
  status: () => number;
  body: () => Record<string, unknown>;
  headers: () => Record<string, string>;
} {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  let responseHeaders: Record<string, string> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return response;
    },
    set(headers: Record<string, string>) {
      responseHeaders = { ...responseHeaders, ...headers };
      return response;
    },
  } as unknown as ExpressResponse;
  return {
    response,
    status: () => statusCode,
    body: () => payload,
    headers: () => responseHeaders,
  };
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

function createIndexingQueue(
  counts: Record<string, number> = {},
  jobs: Partial<Record<'completed' | 'failed', Array<{ finishedOn?: number; timestamp?: number }>>> = {},
) {
  return {
    getJobCounts: async () => counts,
    getJobs: async (statuses: string[]) => statuses.flatMap(status =>
      jobs[status as 'completed' | 'failed'] ?? []),
  };
}

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1',
    type: 'codex',
    alias: 'codex-prod',
    enabled: true,
    dockerImage: 'propr/agent:latest',
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

function createRegistry(agents: Agent[] = [], overrides: Partial<StatusAgentRegistry> = {}): StatusAgentRegistry {
  return {
    ensureInitialized: async () => undefined,
    getAllAgents: () => agents,
    getAgentById: (id: string) => agents.find(agent => agent.config.id === id),
    getAgentByAlias: (alias: string) => agents.find(agent => agent.config.alias === alias),
    createAgentFromConfig: (config: AgentConfig) => createAgent(config, async () => true),
    ...overrides,
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
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0,
      primary_quota_failures_by_alias: {},
      cooldowns: {},
    }),
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

  assert.equal(body.version, PROPR_VERSION);
  assert.equal(body.apiCompatibility, PROPR_API_COMPATIBILITY);
  assert.equal(body.uiCompatibility, PROPR_UI_COMPATIBILITY);
  assert.deepEqual(body.agents, []);
  assert.equal(body.claudeAuth, 'not_applicable');
});

test('/api/compatibility returns public version contract metadata', async () => {
  configureStatusEnv();
  const { response, status, body } = createJsonResponse();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
  });

  routes.getCompatibility({} as Request, response);

  assert.equal(status(), 200);
  assert.deepEqual(body(), {
    version: PROPR_VERSION,
    apiCompatibility: PROPR_API_COMPATIBILITY,
    uiCompatibility: PROPR_UI_COMPATIBILITY,
    desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: true,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
    },
  });
});

test('/api/desktop/discovery returns the bounded public identity and runtime origin', async () => {
  configureStatusEnv();
  process.env.API_PUBLIC_URL = 'https://t-abc123.propr.dev';
  const { response, body, headers } = createJsonResponse();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    getPublicInstanceIdentity: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  await routes.getDesktopDiscovery({} as Request, response);

  assert.deepEqual(body(), {
    schemaVersion: 1,
    product: 'ProPR',
    canonicalEndpoint: 'https://t-abc123.propr.dev',
    publicInstanceIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    version: PROPR_VERSION,
    apiCompatibility: PROPR_API_COMPATIBILITY,
    uiCompatibility: PROPR_UI_COMPATIBILITY,
    desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: true,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
    },
  });
  assert.equal(headers()['Cache-Control'], 'no-store, max-age=0');
  assert.equal(JSON.stringify(body()).includes('SENTINEL'), false);
  assert.deepEqual(parseProprDesktopDiscovery(body()), body());
});

test('/api/desktop/discovery redacts identity persistence failures', async () => {
  configureStatusEnv();
  process.env.API_PUBLIC_URL = 'https://t-abc123.propr.dev';
  const { response, status, body, headers } = createJsonResponse();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    getPublicInstanceIdentity: () => {
      throw new Error('/private/path includes connector-token-SENTINEL');
    },
  });

  await routes.getDesktopDiscovery({} as Request, response);

  assert.equal(status(), 503);
  assert.deepEqual(body(), { schemaVersion: 1, code: 'IDENTITY_UNAVAILABLE' });
  assert.equal(headers()['Cache-Control'], 'no-store, max-age=0');
  assert.equal(headers().Pragma, 'no-cache');
  assert.equal(JSON.stringify(body()).includes('SENTINEL'), false);
});

test('/api/status reports Claude auth not applicable when no agents are configured', async () => {
  const implicitDefault = createAgentConfig({
    id: 'default-claude-agent', type: 'claude', alias: 'default',
  });
  const body = await readStatus({
    agentRegistry: createRegistry([createAgent(implicitDefault, async () => false)]),
  });

  assert.deepEqual(body.agents, []);
  assert.equal(body.claudeAuth, 'not_applicable');
});

test('/api/status preserves an explicitly environment-configured legacy Claude agent', async () => {
  const legacyClaude = createAgentConfig({
    id: 'default-claude-agent',
    type: 'claude',
    alias: 'default',
    dockerImage: 'registry.example/propr/claude:legacy',
    configPath: '/tmp/legacy-claude',
  });
  const body = await readStatus({
    agentRegistry: createRegistry([createAgent(legacyClaude, async () => false)]),
  }, () => {
    process.env.CLAUDE_CONFIG_PATH = legacyClaude.configPath;
  });

  assert.deepEqual(body.agents, [{
    id: 'default-claude-agent',
    type: 'claude',
    alias: 'default',
    status: 'disconnected',
  }]);
  assert.equal(body.claudeAuth, 'disconnected');
});

test('/api/status derives Claude applicability and health from enabled configured agents', async () => {
  const codex = createAgentConfig();
  const healthyClaude = createAgentConfig({
    id: 'claude-healthy', type: 'claude', alias: 'claude-healthy',
  });
  const unhealthyClaude = createAgentConfig({
    id: 'claude-unhealthy', type: 'claude', alias: 'claude-unhealthy',
  });

  const cases = [
    {
      name: 'Codex only',
      configs: [codex],
      agents: [createAgent(codex, async () => true)],
      expected: 'not_applicable',
    },
    {
      name: 'disabled Claude',
      configs: [codex, { ...unhealthyClaude, enabled: false }],
      agents: [createAgent(codex, async () => true)],
      expected: 'not_applicable',
    },
    {
      name: 'healthy Claude',
      configs: [healthyClaude],
      agents: [createAgent(healthyClaude, async () => true)],
      expected: 'connected',
    },
    {
      name: 'unhealthy Claude',
      configs: [unhealthyClaude],
      agents: [createAgent(unhealthyClaude, async () => false)],
      expected: 'disconnected',
    },
    {
      name: 'mixed providers with unhealthy Claude',
      configs: [codex, unhealthyClaude],
      agents: [
        createAgent(codex, async () => true),
        createAgent(unhealthyClaude, async () => false),
      ],
      expected: 'disconnected',
    },
  ] as const;

  for (const scenario of cases) {
    const body = await readStatus({
      loadAgents: async () => [...scenario.configs],
      agentRegistry: createRegistry([...scenario.agents]),
    });
    assert.equal(body.claudeAuth, scenario.expected, scenario.name);
  }
});

test('/api/status preserves unknown Claude applicability when agent config cannot be loaded', async () => {
  const body = await readStatus({
    loadAgents: async () => { throw new Error('configuration unavailable'); },
  });

  assert.deepEqual(body.agents, []);
  assert.equal(body.claudeAuth, 'unknown');
});

test('/api/status projects enabled, disabled, and re-enabled Claude transitions', async () => {
  configureStatusEnv();
  let currentTime = 1_000;
  let config = createAgentConfig({ id: 'claude-1', type: 'claude', alias: 'claude-prod' });
  const registered = createAgent(config, async () => false);
  const snapshots: Array<Record<string, unknown>> = [];
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([registered]),
    getIndexingQueue: async () => createIndexingQueue(),
    now: () => currentTime,
    agentStatusCacheTtlMs: 5_000,
    projectSystemSnapshot: async snapshot => { snapshots.push(snapshot); },
  });

  for (const enabled of [true, false, true]) {
    config = { ...config, enabled };
    currentTime += 6_000;
    routes.invalidateAgentStatusCache();
    const response = createJsonResponse();
    await routes.getStatus({} as Request, response.response);
  }

  assert.deepEqual(snapshots.map(snapshot => snapshot.claudeAuth), [
    'disconnected', 'not_applicable', 'disconnected',
  ]);
});

test('/api/status isolates system notification projection failures', async () => {
  const snapshots: Array<Record<string, unknown>> = [];
  const body = await readStatus({
    projectSystemSnapshot: async snapshot => {
      snapshots.push(snapshot);
      throw new Error('notification persistence unavailable');
    },
  });

  assert.equal(body.api, 'healthy');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].api, 'healthy');
});

test('/api/status surfaces unified agent image outages', async () => {
  const body = await readStatus({
    agentRegistry: createRegistry([], {
      getOperationalStatus: () => ({
        unifiedAgentImage: {
          status: 'unavailable',
          imageTag: 'propr/agent:bundle-test',
          error: 'pull failed',
          recordedAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    }),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0,
      primary_quota_failures_by_alias: {},
      cooldowns: {},
    }),
  });

  assert.deepEqual(body.agentRuntime, {
    unifiedAgentImage: {
      status: 'unavailable',
      imageTag: 'propr/agent:bundle-test',
      error: 'pull failed',
      recordedAt: '2026-07-17T00:00:00.000Z',
    },
  });
  assert.deepEqual(body.warnings, [{
    type: 'agent_runtime_unified_image_unavailable',
    message: 'Unified agent image is unavailable (propr/agent:bundle-test): pull failed',
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

test('/api/status coalesces concurrent expired-cache health snapshots', async () => {
  configureStatusEnv();
  let healthChecks = 0;
  let releaseHealthCheck!: () => void;
  const healthCheckBlocked = new Promise<void>(resolve => { releaseHealthCheck = resolve; });
  const config = createAgentConfig();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([
      createAgent(config, async () => {
        healthChecks += 1;
        await healthCheckBlocked;
        return true;
      }),
    ]),
    getIndexingQueue: async () => createIndexingQueue(),
    agentStatusCacheTtlMs: 5_000,
  });

  const responses = Array.from({ length: 12 }, () => createJsonResponse());
  const requests = responses.map(response => routes.getStatus({} as Request, response.response));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(healthChecks, 1, 'the fixture burst should launch one health probe');
  releaseHealthCheck();
  await Promise.all(requests);

  assert.ok(responses.every(response => response.status() === 200));
  assert.ok(responses.every(response =>
    (response.body().agents as Array<{ status: string }>)[0]?.status === 'connected'));
});

test('/api/status serves stale measurements while one bounded refresh runs', async () => {
  configureStatusEnv();
  let currentTime = 1_000;
  let healthChecks = 0;
  let indexingReads = 0;
  let warningReads = 0;
  let healthy = true;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const config = createAgentConfig();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([createAgent(config, async () => {
      healthChecks += 1;
      if (healthChecks === 2) await refreshBlocked;
      return healthy;
    })]),
    getIndexingQueue: async () => ({
      getJobCounts: async () => { indexingReads += 1; return {}; },
      getJobs: async () => [],
    }),
    loadSummarizationRuntimeState: async () => {
      warningReads += 1;
      return { primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {} };
    },
    now: () => currentTime,
    agentStatusCacheTtlMs: 5_000,
    agentStatusCacheMaxAgeMs: 30_000,
  });

  const initial = createJsonResponse();
  await routes.getStatus({} as Request, initial.response);
  assert.equal((initial.body().agents as Array<{ status: string }>)[0]?.status, 'connected');

  healthy = false;
  currentTime += 6_000;
  const staleResponses = Array.from({ length: 12 }, () => createJsonResponse());
  await Promise.all(staleResponses.map(response => routes.getStatus({} as Request, response.response)));
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(healthChecks, 2, '12 stale consumers should launch one refresh probe');
  assert.equal(indexingReads, 2, '12 stale consumers should launch one indexing refresh');
  assert.equal(warningReads, 2, '12 stale consumers should launch one warning refresh');
  assert.ok(staleResponses.every(response =>
    (response.body().agents as Array<{ status: string }>)[0]?.status === 'connected'));

  releaseRefresh();
  await new Promise<void>(resolve => setImmediate(resolve));
  const refreshed = createJsonResponse();
  await routes.getStatus({} as Request, refreshed.response);
  assert.equal((refreshed.body().agents as Array<{ status: string }>)[0]?.status, 'disconnected');
});

test('/api/status stops serving a stale measurement at the hard freshness bound', async () => {
  configureStatusEnv();
  let currentTime = 1_000;
  let healthChecks = 0;
  const config = createAgentConfig();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([createAgent(config, async () => {
      healthChecks += 1;
      if (healthChecks > 1) await new Promise<void>(() => undefined);
      return true;
    })]),
    getIndexingQueue: async () => createIndexingQueue(),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {},
    }),
    now: () => currentTime,
    agentStatusCacheTtlMs: 5,
    agentStatusCacheMaxAgeMs: 30,
    agentHealthTimeoutMs: 40,
  });

  await routes.getStatus({} as Request, createJsonResponse().response);
  currentTime += 6;
  await routes.getStatus({} as Request, createJsonResponse().response);
  await new Promise<void>(resolve => setImmediate(resolve));
  currentTime += 25;

  const startedAt = performance.now();
  const hardExpired = createJsonResponse();
  await routes.getStatus({} as Request, hardExpired.response);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(healthChecks, 2, 'hard-expired readers should join the in-flight refresh');
  assert.ok(elapsedMs >= 10 && elapsedMs < 200, `hard-expired read took ${elapsedMs.toFixed(1)}ms`);
  assert.equal((hardExpired.body().agents as Array<{ status: string }>)[0]?.status, 'disconnected');
});

test('/api/status invalidation isolates a new agent identity from an old in-flight refresh', async () => {
  configureStatusEnv();
  let currentTime = 1_000;
  let config = createAgentConfig({ id: 'agent-a', alias: 'agent-a' });
  let oldChecks = 0;
  let releaseOldRefresh!: () => void;
  const oldRefreshBlocked = new Promise<void>(resolve => { releaseOldRefresh = resolve; });
  const registered = createAgent(config, async () => {
    oldChecks += 1;
    if (oldChecks === 2) await oldRefreshBlocked;
    return true;
  });
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([registered], {
      createAgentFromConfig: candidate => createAgent(candidate, async () => true),
    }),
    getIndexingQueue: async () => createIndexingQueue(),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {},
    }),
    now: () => currentTime,
    agentStatusCacheTtlMs: 5,
  });

  await routes.getStatus({} as Request, createJsonResponse().response);
  currentTime += 6;
  await routes.getStatus({} as Request, createJsonResponse().response);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(oldChecks, 2);

  config = createAgentConfig({ id: 'agent-b', alias: 'agent-b' });
  routes.invalidateAgentStatusCache();
  const changed = createJsonResponse();
  await routes.getStatus({} as Request, changed.response);
  assert.deepEqual(changed.body().agents, [{
    id: 'agent-b', type: 'codex', alias: 'agent-b', status: 'connected',
  }]);

  releaseOldRefresh();
  await new Promise<void>(resolve => setImmediate(resolve));
  const settled = createJsonResponse();
  await routes.getStatus({} as Request, settled.response);
  assert.equal((settled.body().agents as Array<{ id: string }>)[0]?.id, 'agent-b');
});

test('/api/status does not attribute an old registered runtime to changed persisted config', async () => {
  configureStatusEnv();
  let oldRuntimeChecks = 0;
  const registeredConfig = createAgentConfig({ configPath: '/credentials/old' });
  const persistedConfig = { ...registeredConfig, configPath: '/credentials/new' };
  const body = await readStatus({
    loadAgents: async () => [persistedConfig],
    agentRegistry: createRegistry([createAgent(registeredConfig, async () => {
      oldRuntimeChecks += 1;
      return true;
    })]),
  });

  assert.equal(oldRuntimeChecks, 0);
  assert.deepEqual(body.agents, [{
    id: persistedConfig.id,
    type: persistedConfig.type,
    alias: persistedConfig.alias,
    status: 'disconnected',
  }]);
});

test('/api/status runs independent config, health, indexing, and warning work concurrently', async () => {
  configureStatusEnv();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const starts = new Set<string>();
  const direct = createAgentConfig();
  const synthetic: SyntheticAgentConfig = {
    id: '11111111-1111-4111-8111-111111111111',
    alias: 'pool', enabled: true, defaultModel: 'balanced', models: [],
  };
  const directAgent = createAgent(direct, async () => {
    starts.add('direct-health');
    await blocked;
    return true;
  });
  const syntheticAgent = createAgent({
    ...direct,
    id: synthetic.id,
    alias: synthetic.alias,
  }, async () => {
    starts.add('synthetic-health');
    await blocked;
    return true;
  });
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => { starts.add('direct-config'); return [direct]; },
    loadSyntheticAgents: async () => { starts.add('synthetic-config'); return [synthetic]; },
    agentRegistry: createRegistry([directAgent, syntheticAgent]),
    getIndexingQueue: async () => ({
      getJobCounts: async () => { starts.add('indexing'); await blocked; return {}; },
      getJobs: async () => [],
    }),
    loadSummarizationRuntimeState: async () => {
      starts.add('warnings');
      await blocked;
      return { primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {} };
    },
  });

  const response = createJsonResponse();
  const request = routes.getStatus({} as Request, response.response);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...starts].sort(), [
    'direct-config', 'direct-health', 'indexing', 'synthetic-config', 'synthetic-health', 'warnings',
  ]);

  release();
  await request;
  assert.equal(response.status(), 200);
});

test('/api/status does not initialize the execution registry and bounds failing probes', async () => {
  configureStatusEnv();
  let registryInitializations = 0;
  const config = createAgentConfig();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([createAgent(config, async () =>
      new Promise<boolean>(() => undefined))], {
      ensureInitialized: async () => { registryInitializations += 1; },
    }),
    getIndexingQueue: async () => createIndexingQueue(),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {},
    }),
    agentHealthTimeoutMs: 25,
  });

  const startedAt = performance.now();
  const response = createJsonResponse();
  await routes.getStatus({} as Request, response.response);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(registryInitializations, 0);
  assert.ok(elapsedMs >= 10 && elapsedMs < 200, `bounded probe took ${elapsedMs.toFixed(1)}ms`);
  assert.equal((response.body().agents as Array<{ status: string }>)[0]?.status, 'disconnected');
});

test('/api/status bounds an unavailable configuration read and reports unknown applicability', async () => {
  configureStatusEnv();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => new Promise<AgentConfig[]>(() => undefined),
    agentRegistry: createRegistry(),
    getIndexingQueue: async () => createIndexingQueue(),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {},
    }),
    statusDependencyTimeoutMs: 25,
  });

  const startedAt = performance.now();
  const response = createJsonResponse();
  await routes.getStatus({} as Request, response.response);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs >= 10 && elapsedMs < 200, `bounded config read took ${elapsedMs.toFixed(1)}ms`);
  assert.deepEqual(response.body().agents, []);
  assert.equal(response.body().claudeAuth, 'unknown');
});

test('/api/status recovers after a failed cached health measurement', async () => {
  configureStatusEnv();
  let currentTime = 1_000;
  let healthChecks = 0;
  const config = createAgentConfig();
  const routes = await createRoutes({
    redisClient: createRedisClient() as never,
    loadAgents: async () => [config],
    agentRegistry: createRegistry([createAgent(config, async () => {
      healthChecks += 1;
      if (healthChecks === 1) throw new Error('temporary probe failure');
      return true;
    })]),
    getIndexingQueue: async () => createIndexingQueue(),
    loadSummarizationRuntimeState: async () => ({
      primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {},
    }),
    now: () => currentTime,
    agentStatusCacheTtlMs: 5,
  });

  const failed = createJsonResponse();
  await routes.getStatus({} as Request, failed.response);
  assert.equal((failed.body().agents as Array<{ status: string }>)[0]?.status, 'disconnected');

  currentTime += 6;
  const stale = createJsonResponse();
  await routes.getStatus({} as Request, stale.response);
  assert.equal((stale.body().agents as Array<{ status: string }>)[0]?.status, 'disconnected');
  await new Promise<void>(resolve => setImmediate(resolve));

  const recovered = createJsonResponse();
  await routes.getStatus({} as Request, recovered.response);
  assert.equal(healthChecks, 2);
  assert.equal((recovered.body().agents as Array<{ status: string }>)[0]?.status, 'connected');
});

test('/api/status marks an unavailable synthetic pool degraded without downgrading direct agents', async () => {
  const direct = createAgentConfig();
  const syntheticConfig: SyntheticAgentConfig = {
    id: '11111111-1111-4111-8111-111111111111',
    alias: 'balanced-pool',
    enabled: true,
    defaultModel: 'balanced',
    models: [{
      id: 'balanced',
      enabled: true,
      strategy: 'round_robin',
      members: [{
        id: '22222222-2222-4222-8222-222222222222',
        directAgentAlias: direct.alias,
        model: direct.supportedModels[0],
        enabled: true,
        priority: 100,
      }],
    }],
  };
  const syntheticFacade = createAgent({
    ...direct,
    id: syntheticConfig.id,
    alias: syntheticConfig.alias,
    supportedModels: ['balanced'],
    defaultModel: 'balanced',
  }, async () => false);
  const body = await readStatus({
    loadAgents: async () => [direct],
    loadSyntheticAgents: async () => [syntheticConfig],
    agentRegistry: createRegistry([
      createAgent(direct, async () => true),
      syntheticFacade,
    ]),
  });

  assert.deepEqual(body.agents, [
    { id: direct.id, type: direct.type, alias: direct.alias, status: 'connected' },
    { id: syntheticConfig.id, type: 'synthetic', alias: syntheticConfig.alias, status: 'degraded' },
  ]);
});

test('/api/status probes an unregistered synthetic pool through configured direct agents', async () => {
  const direct = createAgentConfig();
  const syntheticConfig: SyntheticAgentConfig = {
    id: '33333333-3333-4333-8333-333333333333',
    alias: 'fallback-pool',
    enabled: true,
    defaultModel: 'balanced',
    models: [{
      id: 'balanced',
      enabled: true,
      strategy: 'round_robin',
      members: [{
        id: '44444444-4444-4444-8444-444444444444',
        directAgentAlias: direct.alias,
        model: direct.supportedModels[0],
        enabled: true,
        priority: 100,
      }],
    }],
  };
  const body = await readStatus({
    loadAgents: async () => [direct],
    loadSyntheticAgents: async () => [syntheticConfig],
    // The API registry is intentionally empty until an execution route needs it.
    agentRegistry: createRegistry(),
  });

  assert.deepEqual(body.agents, [
    { id: direct.id, type: direct.type, alias: direct.alias, status: 'connected' },
    { id: syntheticConfig.id, type: 'synthetic', alias: syntheticConfig.alias, status: 'connected' },
  ]);
});

test('/api/status reports resolved auth mode and event intake mode', async () => {
  const body = await readStatus();

  // configureStatusEnv() clears all GitHub auth config, so the auth mode
  // resolves to 'none' and the intake mode defaults to routing_websocket.
  assert.equal(body.githubAuthMode, 'none');
  assert.equal(body.githubEventIntake, 'routing_websocket');
  // With no routing state published, the default routing_websocket path is
  // reported as disconnected so a missing relay surfaces as unhealthy.
  assert.equal(body.githubEventIntakeStatus, 'disconnected');
});

test('/api/status reports connected intake status when routing state is live', async () => {
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

  assert.equal(body.githubEventIntake, 'routing_websocket');
  assert.equal(body.githubEventIntakeStatus, 'connected');
});

test('/api/status reports disconnected intake status when routing state is down', async () => {
  const routingState = {
    connected: false,
    routingUrl: 'wss://routing.example',
    lastDeliveryId: null,
    lastAckAt: null,
  };
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) =>
      key === 'system:status:routing' ? JSON.stringify(routingState) : Date.now().toString(),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });

  assert.equal(body.githubEventIntakeStatus, 'disconnected');
});

test('/api/status reports active intake status for polling when the daemon is running', async () => {
  const body = await readStatus({}, () => {
    process.env.GITHUB_EVENT_INTAKE_MODE = 'polling';
  });

  assert.equal(body.githubEventIntake, 'polling');
  // The daemon heartbeat is fresh in the test redis stub, so the daemon-driven
  // polling path is active.
  assert.equal(body.githubEventIntakeStatus, 'active');
});

test('/api/status reports disconnected intake status for polling when the daemon is stopped', async () => {
  const redisClient = {
    ping: async () => 'PONG',
    // A stale daemon heartbeat (epoch 0) marks the daemon stopped, so the
    // daemon-driven polling path is reported disconnected.
    get: async (key: string) => (key === 'system:status:routing' ? null : '0'),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never }, () => {
    process.env.GITHUB_EVENT_INTAKE_MODE = 'direct_webhook';
  });

  assert.equal(body.githubEventIntake, 'direct_webhook');
  assert.equal(body.githubEventIntakeStatus, 'disconnected');
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

test('/api/status exposes only validated UI-safe Connect account fields', async () => {
  const connectAccount = {
    installationId: 42,
    accountLogin: 'octo-org',
    plan: 'community',
    hasPlusAccess: false,
    activeSeats: 3,
    allowedSeats: 3,
    seatsRemaining: 0,
    billingCycleResetAt: '2026-09-01T00:00:00.000Z',
    seatLimitBlockedAt: '2026-08-14T09:31:06.000Z',
    sentAt: '2026-08-14T09:31:07.000Z',
    polarCustomerId: 'must-not-be-exposed',
  };
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) => key === 'system:status:routing'
      ? JSON.stringify({
          connected: true,
          routingUrl: 'wss://routing.example',
          lastDeliveryId: null,
          lastAckAt: null,
          connectAccount,
        })
      : Date.now().toString(),
    sCard: async () => 1,
  };

  const body = await readStatus({ redisClient: redisClient as never });
  assert.deepEqual(body.connectAccount, {
    installationId: 42,
    accountLogin: 'octo-org',
    plan: 'community',
    hasPlusAccess: false,
    activeSeats: 3,
    allowedSeats: 3,
    seatsRemaining: 0,
    billingCycleResetAt: '2026-09-01T00:00:00.000Z',
    seatLimitBlockedAt: '2026-08-14T09:31:06.000Z',
    sentAt: '2026-08-14T09:31:07.000Z',
  });
  assert.deepEqual((body.routing as { connectAccount: unknown }).connectAccount, body.connectAccount);
});

test('/api/status rejects impossible account dates and preserves valid leap-day instants', async () => {
  const connectAccount = {
    installationId: 42,
    accountLogin: 'octo-org',
    plan: 'community',
    hasPlusAccess: false,
    activeSeats: 2,
    allowedSeats: 3,
    seatsRemaining: 1,
    billingCycleResetAt: '2024-02-29T23:59:59.123456789Z',
    seatLimitBlockedAt: '2024-02-29T12:30:45.5+05:30',
    sentAt: '2024-02-29T08:15:00-04:00',
  };
  const readAccount = async (account: typeof connectAccount) => readStatus({
    redisClient: {
      ping: async () => 'PONG',
      get: async (key: string) => key === 'system:status:routing'
        ? JSON.stringify({
            connected: true,
            routingUrl: 'wss://routing.example',
            lastDeliveryId: null,
            lastAckAt: null,
            connectAccount: account,
          })
        : Date.now().toString(),
      sCard: async () => 1,
    } as never,
  });

  assert.deepEqual((await readAccount(connectAccount)).connectAccount, connectAccount);

  for (const field of ['billingCycleResetAt', 'seatLimitBlockedAt', 'sentAt'] as const) {
    const body = await readAccount({
      ...connectAccount,
      [field]: '2026-02-30T00:00:00.000Z',
    });
    assert.equal('connectAccount' in body, false, `${field} must reject an impossible calendar date`);
  }
});

test('/api/status drops malformed or disconnected Connect account state without assuming Community', async () => {
  for (const routingState of [
    {
      connected: true,
      routingUrl: 'wss://routing.example',
      lastDeliveryId: null,
      lastAckAt: null,
      connectAccount: { installationId: 42, plan: 'community' },
    },
    {
      connected: false,
      routingUrl: 'wss://routing.example',
      lastDeliveryId: null,
      lastAckAt: null,
      connectAccount: {
        installationId: 42,
        accountLogin: 'octo-org',
        plan: 'community',
        hasPlusAccess: false,
        activeSeats: 1,
        allowedSeats: 3,
        seatsRemaining: 2,
        billingCycleResetAt: '2026-09-01T00:00:00.000Z',
        sentAt: '2026-08-14T09:31:07.000Z',
      },
    },
  ]) {
    const redisClient = {
      ping: async () => 'PONG',
      get: async (key: string) => key === 'system:status:routing'
        ? JSON.stringify(routingState)
        : Date.now().toString(),
      sCard: async () => 1,
    };
    const body = await readStatus({ redisClient: redisClient as never });
    assert.equal('connectAccount' in body, false);
    assert.equal(
      'connectAccount' in (body.routing as Record<string, unknown>),
      false,
    );
  }
});

test('/api/status does not expose Connect account state for a non-Connect intake mode', async () => {
  const redisClient = {
    ping: async () => 'PONG',
    get: async (key: string) => key === 'system:status:routing'
      ? JSON.stringify({
          connected: true,
          routingUrl: 'wss://routing.example',
          lastDeliveryId: null,
          lastAckAt: null,
          connectAccount: {
            installationId: 42,
            accountLogin: 'octo-org',
            plan: 'community',
            hasPlusAccess: false,
            activeSeats: 1,
            allowedSeats: 3,
            seatsRemaining: 2,
            billingCycleResetAt: '2026-09-01T00:00:00.000Z',
            sentAt: '2026-08-14T09:31:07.000Z',
          },
        })
      : Date.now().toString(),
    sCard: async () => 1,
  };
  const body = await readStatus({ redisClient: redisClient as never }, () => {
    process.env.GITHUB_EVENT_INTAKE_MODE = 'polling';
  });
  assert.equal('connectAccount' in body, false);
  assert.equal(
    'connectAccount' in (body.routing as Record<string, unknown>),
    false,
  );
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
  assert.equal(body().githubEventIntakeStatus, 'connected');
});

test('/api/status maps indexing queue states', async () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const cases: Array<[
    Record<string, number>,
    Partial<Record<'completed' | 'failed', Array<{ finishedOn?: number; timestamp?: number }>>>,
    string,
  ]> = [
    [{ active: 1, waiting: 0, delayed: 0, failed: 0 }, {}, 'active'],
    [{ active: 0, waiting: 1, delayed: 0, failed: 0 }, {}, 'queued'],
    [{ active: 0, waiting: 0, delayed: 1, failed: 0 }, {}, 'queued'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, { failed: [{ finishedOn: now - 1_000 }] }, 'failed'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, {
      failed: [{ finishedOn: now - 2_000 }],
      completed: [{ finishedOn: now - 1_000 }],
    }, 'idle'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, {
      failed: [{ finishedOn: now - (25 * 60 * 60 * 1_000) }],
    }, 'idle'],
    // Enqueue timestamps are not terminal outcomes: missing or invalid
    // finishedOn metadata cannot establish that a failure expired or recovered.
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, {
      failed: [{ timestamp: now - (25 * 60 * 60 * 1_000) }],
    }, 'failed'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, {
      failed: [{ finishedOn: Number.NaN, timestamp: now - (25 * 60 * 60 * 1_000) }],
    }, 'failed'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 1 }, {
      failed: [{ finishedOn: now - 2_000 }],
      completed: [{ timestamp: now - 1_000 }],
    }, 'failed'],
    [{ active: 0, waiting: 0, delayed: 0, failed: 0 }, {}, 'idle'],
  ];

  for (const [counts, jobs, expected] of cases) {
    const body = await readStatus({
      getIndexingQueue: async () => createIndexingQueue(counts, jobs),
      now: () => now,
    });
    assert.equal(body.indexing, expected);
  }
});

test('/api/status preserves confirmed indexing failures when outcome metadata stalls', async () => {
  for (const stalled of ['failed', 'completed'] as const) {
    const startedAt = performance.now();
    const body = await readStatus({
      getIndexingQueue: async () => ({
        getJobCounts: async () => ({ active: 0, waiting: 0, delayed: 0, failed: 1 }),
        getJobs: async (statuses: string[]) => (statuses.includes(stalled)
          ? new Promise<Array<{ finishedOn?: number }>>(() => undefined)
          : []),
      }),
      statusDependencyTimeoutMs: 25,
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(body.indexing, 'failed', `stalled ${stalled} lookup`);
    assert.ok(elapsedMs >= 10 && elapsedMs < 200, `bounded indexing read took ${elapsedMs.toFixed(1)}ms`);
  }
});

test('/api/status reports indexing disconnected when queue counts stall', async () => {
  const body = await readStatus({
    getIndexingQueue: async () => ({
      getJobCounts: async () => new Promise<Record<string, number>>(() => undefined),
      getJobs: async () => [],
    }),
    statusDependencyTimeoutMs: 25,
  });

  assert.equal(body.indexing, 'disconnected');
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
