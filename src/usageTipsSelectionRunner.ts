import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { USAGE_TIPS_DAY_MS, type UsageTipSelection, type UsageTipSignals } from '@propr/shared';
import type { createUsageTipsStore } from '@propr/core';

export const USAGE_TIPS_LEASE_KEY = 'usage-tips:selection:lease';
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
export interface UsageTipsRunnerDependencies {
  redis: Pick<Redis, 'set' | 'eval'>;
  store: Pick<ReturnType<typeof createUsageTipsStore>, 'settings' | 'current' | 'persist'>;
  collect: () => Promise<UsageTipSignals>;
  select: (signals: UsageTipSignals, epoch: number) => Promise<UsageTipSelection>;
  now?: () => number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}
export function createUsageTipsSelectionRunner(deps: UsageTipsRunnerDependencies) {
  let active: Promise<boolean> | null = null;
  const now = deps.now ?? Date.now;
  const fresh = (selection: UsageTipSelection | null) => selection !== null && now() - selection.generatedAt < USAGE_TIPS_DAY_MS;
  const run = async () => {
    if (!(await deps.store.settings()).enabled || fresh(await deps.store.current())) return false;
    const token = randomUUID();
    const leaseMs = deps.leaseMs ?? 90_000;
    if (await deps.redis.set(USAGE_TIPS_LEASE_KEY, token, 'PX', leaseMs, 'NX') !== 'OK') return false;
    let lost = false;
    let renewing: Promise<boolean> | null = null;
    const renew = (): Promise<boolean> => {
      if (lost) return Promise.resolve(false);
      if (renewing) return renewing;
      renewing = Promise.resolve(deps.redis.eval(RENEW, 1, USAGE_TIPS_LEASE_KEY, token, String(leaseMs)))
        .then(result => { if (Number(result) !== 1) lost = true; return !lost; })
        .catch(() => { lost = true; return false; }).finally(() => { renewing = null; });
      return renewing;
    };
    const heartbeat = setInterval(() => { void renew(); }, Math.max(1, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      // Another replica may have persisted, or an operator disabled tips, while
      // we were acquiring the lease. Never spend a model call before rechecking.
      if (!(await deps.store.settings()).enabled) return false;
      const previous = await deps.store.current();
      if (fresh(previous)) return false;
      const epoch = (previous?.rotationEpoch ?? -1) + 1;
      const signals = await deps.collect();
      if (!await renew()) return false;
      const selection = await deps.select(signals, epoch);
      if (!(await deps.store.settings()).enabled || !await renew()) return false;
      return await deps.store.persist({ ...selection, generatedAt: now() }, previous?.rotationEpoch ?? null);
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await deps.redis.eval(RELEASE, 1, USAGE_TIPS_LEASE_KEY, token).catch(() => undefined);
    }
  };
  return {
    run() {
      if (!active) active = run().catch(error => { deps.onError?.(error); return false; }).finally(() => { active = null; });
      return active;
    },
  };
}
export async function startUsageTipsSelectionRunner() {
  const core = await import('@propr/core');
  const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: 1, connectTimeout: 10_000, commandTimeout: 10_000, enableReadyCheck: false });
  redis.on('error', error => core.logger.warn({ error: error.message }, 'Usage tips Redis unavailable'));
  const runner = createUsageTipsSelectionRunner({
    redis, store: core.createUsageTipsStore(core.db), collect: () => core.collectUsageTipSignals(core.db),
    select: async (signals, epoch) => {
      const settings = await core.loadSummarizationSettings();
      return core.selectUsageTips({ signals, epoch, agentAlias: settings.agent_alias, fallbackAgentAlias: settings.fallback_agent_alias,
        generate: async (alias, prompt) => {
          // Same alias[:model] resolution as repository summarization; analyze()
          // is the existing read-only execution method (never execute()).
          const registry = core.AgentRegistry.getInstance();
          await registry.ensureInitialized();
          const [name, ...modelParts] = alias.split(':');
          const agent = name ? registry.getAgentByAlias(name) : registry.getDefaultAgent();
          if (!agent) throw new Error('Indexing agent unavailable');
          const result = await agent.analyze(prompt, { model: modelParts.join(':') || agent.config.defaultModel,
            timeoutMs: 45_000, executionType: 'usage-tips-selection', correlationId: randomUUID() });
          if (!result.success) throw new Error(result.error || 'Usage tips model analysis failed');
          return { text: result.response, model: result.modelUsed };
        },
      });
    },
    onError: error => core.logger.warn({ error: String(error) }, 'Usage tips selection failed'),
  });
  let running = runner.run();
  const timer = setInterval(() => { running = runner.run(); }, 15 * 60_000);
  timer.unref();
  return { async close() { clearInterval(timer); await running; await redis.quit(); } };
}
