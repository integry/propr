/* eslint-disable max-lines -- status snapshot assembly is intentionally centralized */
import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { isDemoMode } from '../demoMode.js';
import {
  PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
  canonicalProprProxyUrl,
  getProprCompatibilityMetadata,
  resolveGithubAuthMode,
  resolveGithubEventIntakeMode,
  ROUTING_STATUS_REDIS_KEY,
  type GithubEventIntakeMode
} from '@propr/shared';
import {
  AgentRegistry,
  SyntheticRoutingService,
  getIndexingQueue as loadIndexingQueue,
  loadAgents as loadAgentConfigs,
  loadSyntheticAgents as loadSyntheticAgentConfigs,
  loadSummarizationRuntimeState
} from '@propr/core';
import type { Agent, AgentConfig, AgentRegistryOperationalStatus } from '@propr/core';
import type { SyntheticAgentConfig } from '@propr/shared';
import { applyRoutingStatus, parseConnectAccountStatus, type RoutingState } from './connectAccountStatus.js';
import { getOrCreatePublicInstanceIdentity } from '../publicInstanceIdentity.js';
import { timeApiStage } from '../apiPerformanceTiming.js';

interface StatusRoutesDeps {
  redisClient: RedisClientType;
  agentRegistry?: StatusAgentRegistry;
  loadAgents?: () => Promise<AgentConfig[]>;
  loadSyntheticAgents?: () => Promise<SyntheticAgentConfig[]>;
  getIndexingQueue?: () => Promise<IndexingStatusQueue>;
  agentStatusCacheTtlMs?: number;
  agentStatusCacheMaxAgeMs?: number;
  agentHealthTimeoutMs?: number;
  statusDependencyTimeoutMs?: number;
  now?: () => number;
  loadSummarizationRuntimeState?: typeof loadSummarizationRuntimeState;
  projectSystemSnapshot?: (
    snapshot: Record<string, unknown> & { timestamp: string },
    additionalAdministratorIds: readonly string[],
  ) => Promise<void>;
  getPublicInstanceIdentity?: () => string | Promise<string>;
}

interface IndexingStatusQueue {
  getJobCounts(...statuses: Array<'active' | 'waiting' | 'delayed' | 'failed'>): Promise<Record<string, number>>;
  getJobs(
    statuses: Array<'completed' | 'failed'>,
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Array<{ finishedOn?: number; timestamp?: number }>>;
}

const INDEXING_FAILURE_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StatusAgentRegistry = Pick<AgentRegistry, 'ensureInitialized' | 'getAllAgents' | 'getAgentById' | 'getAgentByAlias'> & {
  createAgentFromConfig(config: AgentConfig): Agent;
  getOperationalStatus?: () => AgentRegistryOperationalStatus;
};

type ServiceStatus = 'connected' | 'disconnected' | 'active' | 'queued' | 'idle' | 'failed'
  | 'unknown' | 'not_applicable';

interface AgentStatus {
  id: string;
  type: AgentConfig['type'] | 'synthetic';
  alias: string;
  status: 'connected' | 'disconnected' | 'degraded';
}

interface AgentStatusSnapshot {
  agents: AgentStatus[];
  claudeAuth: Extract<ServiceStatus, 'connected' | 'disconnected' | 'unknown' | 'not_applicable'>;
}

interface AgentStatusSnapshotDeps {
  loadAgents: () => Promise<AgentConfig[]>;
  loadSyntheticAgents: () => Promise<SyntheticAgentConfig[]>;
  registry: StatusAgentRegistry;
  healthTimeoutMs: number;
  dependencyTimeoutMs: number;
}

interface RuntimeStatusSnapshot {
  redis: 'connected' | 'disconnected';
  daemon: 'running' | 'stopped' | 'unknown';
  worker: 'running' | 'stopped' | 'unknown';
  workerCount?: number;
  routing?: RoutingState;
}

interface BoundedFreshValue<T> {
  value: T;
  freshUntil: number;
  expiresAt: number;
}

/**
 * Serve a recently measured value while one caller refreshes it in the
 * background. The hard expiry prevents a failing or stuck dependency from
 * making the status response indefinitely stale, while the generation keeps a
 * pre-invalidation refresh from repopulating the cache with the old identity.
 */
function createBoundedFreshCache<T>({
  load,
  now,
  freshForMs,
  maxAgeMs,
}: {
  load: () => Promise<T>;
  now: () => number;
  freshForMs: number;
  maxAgeMs: number;
}) {
  let cached: BoundedFreshValue<T> | undefined;
  let generation = 0;
  let pending: { generation: number; promise: Promise<T> } | undefined;

  function refresh(): Promise<T> {
    const refreshGeneration = generation;
    if (pending?.generation === refreshGeneration) return pending.promise;

    const refreshState = {
      generation: refreshGeneration,
      promise: Promise.resolve().then(load).then(value => {
        if (generation === refreshGeneration) {
          const completedAt = now();
          cached = {
            value,
            freshUntil: completedAt + freshForMs,
            expiresAt: completedAt + Math.max(freshForMs, maxAgeMs),
          };
        }
        return value;
      }),
    };
    pending = refreshState;
    void refreshState.promise.finally(() => {
      if (pending === refreshState) pending = undefined;
    }).catch(() => undefined);
    return refreshState.promise;
  }

  return {
    read(): Promise<T> {
      const currentTime = now();
      const cachedAtRead = cached;
      if (cachedAtRead && cachedAtRead.freshUntil > currentTime) {
        return Promise.resolve(cachedAtRead.value);
      }
      const refreshPromise = refresh();
      if (cachedAtRead && cachedAtRead.expiresAt > currentTime) {
        // The refresh is intentionally detached for stale-while-refresh reads.
        // Its rejection is observed above; a hard-expired reader will retry.
        return Promise.resolve(cachedAtRead.value);
      }
      return refreshPromise;
    },
    invalidate(): void {
      generation += 1;
      cached = undefined;
    },
  };
}

export function createStatusRoutes(deps: StatusRoutesDeps) {
  const {
    redisClient,
    agentRegistry = AgentRegistry.getInstance() as StatusAgentRegistry,
    loadAgents = loadAgentConfigs,
    loadSyntheticAgents: configuredSyntheticLoader,
    getIndexingQueue = loadIndexingQueue,
    agentStatusCacheTtlMs = 5000,
    agentStatusCacheMaxAgeMs = 30_000,
    agentHealthTimeoutMs = 1500,
    statusDependencyTimeoutMs = 250,
    now = Date.now,
    loadSummarizationRuntimeState: loadSummarizationRuntimeStateDep = loadSummarizationRuntimeState,
    projectSystemSnapshot,
    getPublicInstanceIdentity: loadPublicInstanceIdentity = getOrCreatePublicInstanceIdentity,
  } = deps;
  // Unit/integration callers that replace the direct config loader predate
  // synthetic pools. Treat that fixture as an empty synthetic document unless
  // it explicitly supplies one; production still uses persisted configuration.
  const loadSyntheticAgents = configuredSyntheticLoader
    ?? (deps.loadAgents ? async () => [] : loadSyntheticAgentConfigs);
  const agentStatusCache = createBoundedFreshCache({
    load: () => getAgentStatusSnapshot({
      loadAgents,
      loadSyntheticAgents,
      registry: agentRegistry,
      healthTimeoutMs: agentHealthTimeoutMs,
      dependencyTimeoutMs: statusDependencyTimeoutMs,
    }),
    now,
    freshForMs: agentStatusCacheTtlMs,
    maxAgeMs: agentStatusCacheMaxAgeMs,
  });
  const indexingStatusCache = createBoundedFreshCache({
    load: () => timeApiStage('status.indexing', () => {
      const progress: IndexingStatusProgress = { failuresConfirmed: false };
      // Once counts confirm failures, a stalled recency lookup must not turn
      // that evidence into a queue-disconnection report.
      return withLazyTimeout(
        getIndexingStatus(getIndexingQueue, now, progress),
        statusDependencyTimeoutMs,
        () => (progress.failuresConfirmed ? 'failed' : 'disconnected'),
      );
    }),
    now,
    freshForMs: agentStatusCacheTtlMs,
    maxAgeMs: agentStatusCacheMaxAgeMs,
  });
  const systemWarningsCache = createBoundedFreshCache({
    load: () => timeApiStage('status.system-warnings', () => withTimeout(
      getSystemWarnings(loadSummarizationRuntimeStateDep), statusDependencyTimeoutMs, [],
    )),
    now,
    freshForMs: agentStatusCacheTtlMs,
    maxAgeMs: agentStatusCacheMaxAgeMs,
  });

  function getCompatibility(_req: Request, res: Response): void {
    res.json(getProprCompatibilityMetadata(!isDemoMode()));
  }

  async function getDesktopDiscovery(_req: Request, res: Response): Promise<void> {
    // This endpoint is intentionally unauthenticated. Keep it cache-safe and
    // bounded, and never include environment/account/credential state.
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    try {
      res.json({
        schemaVersion: PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
        product: 'ProPR',
        canonicalEndpoint: canonicalProprProxyUrl(process.env.API_PUBLIC_URL) ?? null,
        publicInstanceIdentity: await loadPublicInstanceIdentity(),
        ...getProprCompatibilityMetadata(!isDemoMode()),
      });
    } catch {
      // Do not expose a persistence path or parse error through public discovery.
      res.status(503).json({
        schemaVersion: PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
        code: 'IDENTITY_UNAVAILABLE',
      });
    }
  }

  async function getStatus(req: Request, res: Response): Promise<void> {
    try {
      const compatibility = getProprCompatibilityMetadata(!isDemoMode());
      // In demo mode, return all-green status
      if (isDemoMode()) {
        res.json({
          ...compatibility,
          api: 'healthy',
          redis: 'connected',
          daemon: 'running',
          worker: 'running',
          workerCount: 3,
          githubAuth: 'connected',
          githubAuthMode: 'demo',
          githubEventIntake: resolveIntakeMode(),
          githubEventIntakeStatus: 'connected',
          claudeAuth: 'connected',
          indexing: 'idle',
          warnings: [],
          agents: [{
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            status: 'connected'
          }],
          timestamp: new Date().toISOString()
        });
        return;
      }

      const status: Record<string, unknown> = {
        ...compatibility,
        api: 'healthy',
        redis: 'unknown',
        daemon: 'unknown',
        worker: 'unknown',
        githubAuth: 'unknown',
        claudeAuth: 'unknown',
        indexing: 'unknown',
        warnings: [],
        agents: [],
        timestamp: new Date().toISOString()
      };

      const runtimeStatus = await getRuntimeStatusSnapshot(redisClient);
      Object.assign(status, runtimeStatus);

      // Auth mode (how ProPR authenticates to GitHub) and event intake mode (how
      // GitHub events arrive) are independent — surface both so operators can tell
      // a relay-auth + routing-websocket deployment apart from an app + webhook one.
      const authMode = resolveAuthMode();
      status.githubAuthMode = authMode;
      // The coarse githubAuth health is derived from the resolved auth mode rather
      // than GH_APP_* alone, so a valid relay-auth deployment reports 'connected'
      // instead of a misleading 'disconnected'. Only 'none' (nothing configured)
      // and 'unknown' (resolver error) report as disconnected.
      status.githubAuth = (authMode === 'app' || authMode === 'relay' || authMode === 'demo')
        ? 'connected'
        : 'disconnected';
      const intakeMode = resolveIntakeMode();
      status.githubEventIntake = intakeMode;

      // Routing WebSocket runtime state, published to Redis by the daemon when the
      // default routing_websocket intake path is active. Included only when present
      // so non-routing deployments don't carry an empty field.
      // Routing remains independently observable when another Redis operation
      // fails, matching the previous partial-failure behavior.
      const routing = runtimeStatus.routing;
      applyRoutingStatus(status, intakeMode, routing);

      // The intake status is a stable, mode-aware health signal for the active
      // GitHub event delivery path so operators can tell a healthy intake from a
      // stalled one independent of the intake method name.
      status.githubEventIntakeStatus = resolveIntakeStatus(intakeMode, routing, status.daemon);

      const [agentSnapshot, indexing, cachedWarnings] = await Promise.all([
        timeApiStage('status.agent-health', agentStatusCache.read),
        indexingStatusCache.read(),
        systemWarningsCache.read(),
      ]);
      status.agents = agentSnapshot.agents;
      status.claudeAuth = agentSnapshot.claudeAuth;
      status.indexing = indexing;
      // The operational warning below is request-local; never mutate the cached
      // summarization warning array.
      const warnings = [...cachedWarnings];
      const agentRuntime = agentRegistry.getOperationalStatus?.();
      if (agentRuntime) {
        status.agentRuntime = agentRuntime;
        const image = agentRuntime.unifiedAgentImage;
        if (image.status === 'unavailable') {
          warnings.push({
            type: 'agent_runtime_unified_image_unavailable',
            message: `Unified agent image is unavailable${image.imageTag ? ` (${image.imageTag})` : ''}: ${image.error || 'unknown error'}`
          });
        }
      }
      status.warnings = warnings;

      res.json(status);
      if (projectSystemSnapshot) {
        const additionalAdministratorIds = req.user
          && req.authorization?.permissions.includes('instance.manage_settings')
          ? [req.user.id]
          : [];
        void projectSystemSnapshot(
          status as Record<string, unknown> & { timestamp: string },
          additionalAdministratorIds,
        ).catch(error => {
          console.warn('[notifications] Failed to project system health snapshot:', error);
        });
      }
    } catch (error) {
      console.error('Error in /api/status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return {
    getCompatibility,
    getDesktopDiscovery,
    getStatus,
    invalidateAgentStatusCache: agentStatusCache.invalidate,
  };
}

function resolveAuthMode(): string {
  // A misconfigured GH_AUTH_MODE must not break the diagnostic endpoint; report
  // 'unknown' rather than letting a resolver error turn /api/status into a 500.
  try {
    const { mode } = resolveGithubAuthMode({
      demoMode: isDemoMode(),
      ghAuthMode: process.env.GH_AUTH_MODE,
      relayUrl: process.env.PROPR_GH_RELAY_URL,
      relayToken: process.env.PROPR_GH_RELAY_TOKEN,
      appId: process.env.GH_APP_ID,
      privateKeyPath: process.env.GH_PRIVATE_KEY_PATH,
      installationId: process.env.GH_INSTALLATION_ID
    });
    return mode;
  } catch {
    return 'unknown';
  }
}

function resolveIntakeMode(): GithubEventIntakeMode | 'unknown' {
  // A misconfigured GITHUB_EVENT_INTAKE_MODE throws here; the status route must
  // still answer, so report it as 'unknown' rather than failing the whole call.
  try {
    return resolveGithubEventIntakeMode({
      eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
      enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS
    }).mode;
  } catch {
    return 'unknown';
  }
}

// Maps the resolved intake mode and the runtime signals it depends on into a
// single health value. The three intake paths are healthy in different ways:
//   routing_websocket — healthy only when the daemon has published a live,
//                       connected routing state; missing or disconnected state
//                       is unhealthy so a stalled relay surfaces immediately.
//   polling / direct_webhook — driven by the daemon process, so they are active
//                       while the daemon heartbeat is fresh and disconnected
//                       once it goes stale.
// An unknown/misconfigured mode reports 'unknown' rather than guessing a health.
function resolveIntakeStatus(
  mode: GithubEventIntakeMode | 'unknown',
  routing: RoutingState | undefined,
  daemonStatus: unknown
): ServiceStatus {
  switch (mode) {
    case 'routing_websocket':
      return routing?.connected ? 'connected' : 'disconnected';
    case 'polling':
    case 'direct_webhook':
      return daemonStatus === 'running' ? 'active' : 'disconnected';
    default:
      return 'unknown';
  }
}

async function getRoutingState(redisClient: RedisClientType): Promise<RoutingState | undefined> {
  try {
    const raw = await redisClient.get(ROUTING_STATUS_REDIS_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    // A stale or malformed Redis value should not produce confusing CLI output;
    // only expose routing state that matches the expected shape.
    return parseRoutingState(parsed);
  } catch {
    return undefined;
  }
}

async function getRuntimeStatusSnapshot(redisClient: RedisClientType): Promise<RuntimeStatusSnapshot> {
  const [pingResult, daemonResult, workerResult, routingResult] = await Promise.allSettled([
    redisClient.ping(),
    redisClient.get('system:status:daemon'),
    redisClient.sCard('system:status:workers'),
    getRoutingState(redisClient),
  ]);
  const routing = routingResult.status === 'fulfilled' ? routingResult.value : undefined;
  const routingField = routing ? { routing } : {};
  if (pingResult.status === 'rejected'
    || daemonResult.status === 'rejected'
    || workerResult.status === 'rejected') {
    return { redis: 'disconnected', daemon: 'unknown', worker: 'unknown', ...routingField };
  }
  const daemonHeartbeat = daemonResult.value;
  const activeWorkers = workerResult.value;
  return {
    redis: 'connected',
    daemon: daemonHeartbeat && Date.now() - parseInt(daemonHeartbeat) < 120000 ? 'running' : 'stopped',
    worker: activeWorkers > 0 ? 'running' : 'stopped',
    workerCount: activeWorkers,
    ...routingField,
  };
}

function parseRoutingState(value: unknown): RoutingState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const state = value as Record<string, unknown>;
  if (!(typeof state.connected === 'boolean'
    && typeof state.routingUrl === 'string'
    && (typeof state.lastDeliveryId === 'string' || state.lastDeliveryId === null)
    && isNullableTimestamp(state.lastAckAt))) return undefined;

  const connectAccount = state.connectAccount === undefined
    ? undefined
    : parseConnectAccountStatus(state.connectAccount);
  // A malformed optional account object invalidates only that additive object;
  // legacy routing diagnostics remain available and no entitlement is guessed.
  return {
    connected: state.connected,
    routingUrl: state.routingUrl,
    lastDeliveryId: state.lastDeliveryId,
    lastAckAt: state.lastAckAt as string | null,
    ...(connectAccount ? { connectAccount } : {})
  };
}

// lastAckAt is an ISO-8601 string when present (the routing service produces it
// via Date#toISOString). Validate against an actual ISO-8601 shape rather than the
// permissive Date.parse() — which would accept loose inputs like "2026" or
// "Jan 1 2026" — so the API contract stays tight and a corrupt Redis value never
// reaches consumers as a non-ISO date.
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isNullableTimestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  return ISO_8601_RE.test(value) && !Number.isNaN(Date.parse(value));
}

async function getSystemWarnings(loadRuntimeState: typeof loadSummarizationRuntimeState): Promise<Array<{ type: string; message: string }>> {
  try {
    const state = await loadRuntimeState();
    const warnings: Array<{ type: string; message: string }> = [];
    const maxCooldownWarnings = 5;
    if (state.warning && state.warning.mode !== 'cooldown') {
      warnings.push({ type: `summarization_${state.warning.mode}`, message: state.warning.message });
    }
    // Surface the soonest-expiring cooldowns first so operators see what will
    // resume next; the rest are summarized in the overflow warning below.
    const cooldowns = Object.values(state.cooldowns || {})
      .sort((left, right) => Date.parse(left.until) - Date.parse(right.until));
    for (const cooldown of cooldowns.slice(0, maxCooldownWarnings)) {
      warnings.push({
        type: 'summarization_cooldown',
        message: `${cooldown.repository} (${cooldown.branch}) summarization is paused until ${formatCooldownUntil(cooldown.until)}: ${cooldown.reason}`
      });
    }
    if (cooldowns.length > maxCooldownWarnings) {
      warnings.push({
        type: 'summarization_cooldown_summary',
        message: `${cooldowns.length - maxCooldownWarnings} additional repositories are in summarization cooldown.`
      });
    }
    return warnings;
  } catch (error) {
    console.error('Error loading summarization warnings:', error);
    return [];
  }
}

function formatCooldownUntil(until: string): string {
  const parsed = new Date(until);
  if (Number.isNaN(parsed.getTime())) return until;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });
}

async function getAgentStatusSnapshot({
  loadAgents,
  loadSyntheticAgents,
  registry,
  healthTimeoutMs,
  dependencyTimeoutMs,
}: AgentStatusSnapshotDeps): Promise<AgentStatusSnapshot> {
  // These are independent persisted documents. Loading them together avoids
  // adding two database/contention waits to the critical path.
  const [configuredResult, syntheticResult] = await Promise.allSettled([
    timeApiStage('status.config', () => withTimeout(
      loadAgents(), dependencyTimeoutMs, undefined,
    )),
    timeApiStage('status.config', () => withTimeout(
      loadSyntheticAgents(), dependencyTimeoutMs, undefined,
    )),
  ]);
  if (configuredResult.status === 'rejected') {
    const error = configuredResult.reason;
    console.error('Error loading agent status configuration:', error);
    // Configuration availability is part of applicability. Do not mistake a
    // read failure for a known Codex-only instance and hide a possible Claude
    // auth problem.
    return { agents: [], claudeAuth: 'unknown' };
  }
  if (configuredResult.value === undefined) {
    console.error('Timed out loading agent status configuration');
    return { agents: [], claudeAuth: 'unknown' };
  }
  const configuredAgents = configuredResult.value;
  let syntheticAgents: SyntheticAgentConfig[] = [];
  if (syntheticResult.status === 'fulfilled' && syntheticResult.value !== undefined) {
    syntheticAgents = syntheticResult.value;
  } else if (syntheticResult.status === 'fulfilled') {
    console.error('Timed out loading synthetic agent status configuration');
  } else {
    // Synthetic configuration availability must not suppress or downgrade
    // unrelated direct-agent health.
    console.error('Error loading synthetic agent status configuration:', syntheticResult.reason);
  }

  // Status is diagnostic and must not initialize or repair the execution
  // runtime. AgentRegistry.ensureInitialized() performs Docker image inspection
  // (and can prepare images on first use), which made a read-only status request
  // contend with real work. Probe the already-live registry when available and
  // use the persisted configuration fallback otherwise.
  const registeredAgents = registry.getAllAgents();
  const registeredById = new Map(registeredAgents.map(agent => [agent.config.id, agent]));
  const registeredByAlias = new Map(registeredAgents.map(agent => [agent.config.alias, agent]));

  // With no persisted configs the registry still supports the legacy,
  // environment-configured Claude runtime. Only surface the concrete enabled
  // agent that the registry actually created, and only when its legacy
  // environment configuration is explicit. This avoids reviving the old
  // fabricated disconnected default for genuinely unconfigured instances.
  const legacyClaudeAgent = configuredAgents.length === 0 && hasExplicitLegacyClaudeConfiguration()
    ? registeredById.get('default-claude-agent')
    : undefined;
  const enabledLegacyClaudeAgent = legacyClaudeAgent?.config.enabled && legacyClaudeAgent.config.type === 'claude'
    ? legacyClaudeAgent
    : undefined;

  // Build the same read-only fallback runtimes used by direct status probes once,
  // then make them available to synthetic routing as well. The API intentionally
  // does not initialize its execution registry from this diagnostic endpoint, so
  // requiring a registered synthetic facade here would make every configured pool
  // look degraded until another API route happened to initialize the registry.
  const directProbeAgents = new Map<string, Agent>();
  for (const config of configuredAgents.filter(agent => agent.enabled)) {
    const registeredAgent = registeredById.get(config.id) ?? registeredByAlias.get(config.alias);
    if (registeredAgent) {
      if (registeredAgentMatchesConfig(registeredAgent, config)) {
        directProbeAgents.set(config.alias, registeredAgent);
      }
      continue;
    }
    try {
      directProbeAgents.set(config.alias, registry.createAgentFromConfig(config));
    } catch (error) {
      console.error('Error creating configured agent status probe:', error);
    }
  }

  const directStatusesPromise = Promise.all(configuredAgents
    .filter(agent => agent.enabled)
    .map(config => {
      const probeAgent = directProbeAgents.get(config.alias);
      // A persisted change can reach this process before its live registry
      // refresh. Never attribute the old registered runtime to the new config.
      return probeAgent
        ? buildRegisteredAgentStatus(probeAgent, healthTimeoutMs, config)
        : Promise.resolve(buildDisconnectedAgentStatus(config));
    }));

  const syntheticFallbackRouting = new SyntheticRoutingService({
    loadSyntheticConfigs: async () => syntheticAgents,
    getDirectAgent: alias => directProbeAgents.get(alias),
  });

  const syntheticStatusesPromise = Promise.all(syntheticAgents
    .filter(pool => pool.enabled)
    .map(async pool => {
      const registered = registeredById.get(pool.id) ?? registeredByAlias.get(pool.alias);
      let healthy = false;
      try {
        const healthCheck = registered
          ? registered.healthCheck()
          : syntheticFallbackRouting.healthCheck(syntheticFallbackRouting.begin({
            requestedAgentAlias: pool.alias,
            requestedModel: pool.defaultModel,
            requiredTokens: 0,
          }));
        healthy = await withTimeout(healthCheck, healthTimeoutMs, false);
      } catch {
        healthy = false;
      }
      return {
        id: pool.id,
        type: 'synthetic' as const,
        alias: pool.alias,
        status: healthy ? 'connected' as const : 'degraded' as const,
      };
    }));

  const legacyClaudeStatusesPromise = enabledLegacyClaudeAgent
    ? buildRegisteredAgentStatus(enabledLegacyClaudeAgent, healthTimeoutMs).then(status => [status])
    : Promise.resolve([] as AgentStatus[]);
  // Direct, legacy, and synthetic checks do not depend on each other. Keeping
  // them in one stage makes the route latency the slowest bounded probe rather
  // than the sum of up to three probe groups.
  const [directStatuses, legacyClaudeStatuses, syntheticStatuses] = await timeApiStage(
    'status.health-probes',
    () => Promise.all([
      directStatusesPromise,
      legacyClaudeStatusesPromise,
      syntheticStatusesPromise,
    ]),
  );
  const agents = [...directStatuses, ...legacyClaudeStatuses, ...syntheticStatuses];
  const claudeApplicable = configuredAgents.some(agent => agent.enabled && agent.type === 'claude')
    || enabledLegacyClaudeAgent !== undefined;
  return {
    agents,
    claudeAuth: !claudeApplicable
      ? 'not_applicable'
      : agents.some(agent => agent.type === 'claude' && agent.status === 'connected')
        ? 'connected'
        : 'disconnected',
  };
}

function hasExplicitLegacyClaudeConfiguration(): boolean {
  return Boolean(process.env.AGENT_DOCKER_IMAGE?.trim() || process.env.CLAUDE_CONFIG_PATH?.trim());
}

function registeredAgentMatchesConfig(agent: Agent, config: AgentConfig): boolean {
  // The registry deliberately rewrites dockerImage to the effective unified
  // bundle tag, so it is excluded. Every other persisted field identifies the
  // logical runtime whose health is being attributed.
  const fingerprint = (value: AgentConfig): string => JSON.stringify([
    value.id,
    value.type,
    value.alias,
    value.enabled,
    value.configPath,
    value.supportedModels,
    value.defaultModel,
    value.envVars,
    value.modelCustomLabels,
    value.modelReasoningLevels,
    value.cliVersionType,
    value.cliVersion,
    value.cliVersionResolved,
  ]);
  return fingerprint(agent.config) === fingerprint(config);
}

async function buildRegisteredAgentStatus(
  agent: Agent,
  healthTimeoutMs: number,
  identity: AgentConfig = agent.config,
): Promise<AgentStatus> {
  let healthy = false;
  try {
    healthy = await withTimeout(agent.healthCheck(), healthTimeoutMs, false);
  } catch {
    healthy = false;
  }
  return {
    // Persisted configuration owns the public identity. A registry refresh and
    // a status refresh can overlap, but an old runtime must never leak its old
    // alias/type into a snapshot for the new configuration.
    id: identity.id,
    type: identity.type,
    alias: identity.alias,
    status: healthy ? 'connected' : 'disconnected'
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return withLazyTimeout(promise, timeoutMs, () => fallback);
}

async function withLazyTimeout<T>(promise: Promise<T>, timeoutMs: number, getFallback: () => T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timeout = setTimeout(() => resolve(getFallback()), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildDisconnectedAgentStatus(config: AgentConfig): AgentStatus {
  return {
    id: config.id,
    type: config.type,
    alias: config.alias,
    status: 'disconnected'
  };
}

interface IndexingStatusProgress {
  failuresConfirmed: boolean;
}

// Only the terminal timestamp describes when an outcome happened; the enqueue
// timestamp says nothing about when a failure occurred or a recovery finished.
function indexingJobFinishedAt(job: { finishedOn?: number } | undefined): number | undefined {
  const value = job?.finishedOn;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function getIndexingStatus(
  getIndexingQueue: () => Promise<IndexingStatusQueue>,
  now: () => number,
  progress: IndexingStatusProgress,
): Promise<ServiceStatus> {
  try {
    const indexingQueue = await getIndexingQueue();
    const counts = await indexingQueue.getJobCounts('active', 'waiting', 'delayed', 'failed');
    if ((counts.active ?? 0) > 0) return 'active';
    if ((counts.waiting ?? 0) > 0 || (counts.delayed ?? 0) > 0) return 'queued';
    if ((counts.failed ?? 0) > 0) {
      progress.failuresConfirmed = true;
      try {
        const [failedJobs, completedJobs] = await Promise.all([
          indexingQueue.getJobs(['failed'], 0, 0, false),
          indexingQueue.getJobs(['completed'], 0, 0, false),
        ]);
        const latestFailureAt = indexingJobFinishedAt(failedJobs[0]);
        const latestCompletionAt = indexingJobFinishedAt(completedJobs[0]);

        // Failed BullMQ entries are retained for diagnostics and age-based
        // removal is lazy. They must not permanently poison current service
        // health after newer successful work or after the incident is stale.
        if (latestFailureAt !== undefined
          && latestCompletionAt !== undefined
          && latestCompletionAt >= latestFailureAt) return 'idle';
        if (latestFailureAt !== undefined
          && now() - latestFailureAt > INDEXING_FAILURE_STATUS_MAX_AGE_MS) return 'idle';
        return 'failed';
      } catch {
        // Counts were readable and confirm failures, but their recency could not
        // be established. Preserve the conservative legacy result.
        return 'failed';
      }
    }
    return 'idle';
  } catch {
    return 'disconnected';
  }
}
