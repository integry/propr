import { randomUUID } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import { AgentRunStoppedError, LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { execute } from './sprites/spritesExecution.js';
import { startupStep, type SpriteClient } from './sprites/spritesProvisioning.js';
import { SpritePool, type Slot } from './sprites/spritesRunnerPool.js';
import { unsupportedMount, uploadRun } from './sprites/spritesRun.js';
import { RedisSpritePoolStore, resolveSpritesPoolConfig, spritesPoolScope, spritesWarmCloneKey, type SpritePoolStore } from './spritesPool.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = { supportsBindMounts: false, supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['clone'] as const };
    readonly unsupportedMount = unsupportedMount;
    private readonly pools = new Map<string, Promise<SpritePool>>();
    private closing?: Promise<void>;
    private store?: SpritePoolStore;
    /** Runs that may still use the pool store (not yet released). */
    private active = 0;

    /**
     * `pool.store` holds the runner leases every worker of the organization shares:
     * Redis (REDIS_HOST/REDIS_PORT) unless given.
     */
    constructor(private readonly client?: SpriteClient, private readonly environment = process.env,
        private readonly pool: { store?: SpritePoolStore; pollMs?: number; ttlMs?: number; owner?: string } = {}) {}

    close(): Promise<void> {
        return this.closing ??= Promise.all([...this.pools.values()].map(async pool => (await pool).close()))
            .then(() => this.closeStoreWhenIdle());
    }

    /** An owned store stays open until runs leased before close() are released. */
    private async closeStoreWhenIdle(): Promise<void> {
        if (this.closing && this.active === 0 && !this.pool.store) await this.store?.close?.();
    }

    /** The organization's pool, shared by every run of this runtime with the same token. */
    private poolFor(token: string, config: ReturnType<typeof resolveSpritesPoolConfig>): Promise<SpritePool> {
        let pool = this.pools.get(token);
        if (!pool) {
            const store = this.pool.store ?? (this.store ??= new RedisSpritePoolStore());
            const options = { ...this.pool, store, scope: spritesPoolScope(token), config };
            pool = this.client ? Promise.resolve(new SpritePool(this.client, options))
                : import('@fly/sprites').then(({ SpritesClient }) => new SpritePool(new SpritesClient(token), options));
            this.pools.set(token, pool);
        }
        return pool;
    }

    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec) {
        const type = spec.profile.agentType;
        if (!['codex', 'claude', 'antigravity'].includes(type)) return `unsupported agent type ${type}`;
        return spritesCliVersionRefusal({ ...config, type });
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        const token = this.environment.PROPR_SPRITES_TOKEN || this.environment.SPRITES_TOKEN;
        if (!token) throw new Error('Set PROPR_SPRITES_TOKEN on the worker to run agents on Sprites');
        if (spec.network.restriction || spec.network.policy?.mode === 'restricted' || spec.network.mode === 'named')
            throw new Error('Sprites requires open networking');
        process.env.SPRITES_CLIENT_SIGNALS ??= '0';
        if (this.closing) throw new Error('Sprites runtime is closed');
        const config = resolveSpritesPoolConfig(this.environment);
        const pool = this.poolFor(token, config);
        const clone = spec.workspace.clone;
        const repo = config.warmClones && clone?.remote ? spritesWarmCloneKey(clone.remote) : undefined;
        options = { ...options, extraEnvVars: { ...options.extraEnvVars } };
        const cancellation = new AbortController();
        const ownership = getExecutionOwnershipContext()?.signal;
        const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(options.timeout ?? 300_000),
            ...(options.signal ? [options.signal] : []), ...(ownership ? [ownership] : [])]);
        const output = new LazyOutputStreams();
        let slot: Slot | undefined;
        let released: Promise<void> | undefined;
        const reads = new Set<Promise<Buffer | null>>();
        let commit: (() => Promise<void>) | undefined;
        let settled = false;
        this.active += 1;
        let finishedUse = false;
        const doneWithPool = () => {
            if (finishedUse) return;
            finishedUse = true;
            this.active -= 1;
            void this.closeStoreWhenIdle().catch(() => {});
        };
        const result = (async () => {
            const refusal = await startupStep(signal, () => admitCostExecution('sprites', [], { ...options, agentRun: { spec } }));
            if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
            const inputPath = `/opt/propr/inbox/${randomUUID()}.json`;
            const launch = { spec, options, token, inputPath, warmClone: repo };
            const ready = await startupStep(signal, () => pool);
            const sprite = await startupStep(signal, async () => {
                // Keep ownership here until upload succeeds. Even a create response arriving
                // after stop() must dispose of its Sprite before this acquisition ends.
                const acquired = await ready.acquire(signal, { repo });
                try {
                    const writeBack = await startupStep(signal, () => uploadRun(acquired.sprite, launch));
                    signal.throwIfAborted();
                    slot = acquired;
                    commit = writeBack;
                    return acquired.sprite;
                } catch (error) {
                    if (signal.aborted) await ready.discard(acquired);
                    else await ready.release(acquired);
                    throw error;
                }
            });
            signal.throwIfAborted();
            const startedAt = Date.now();
            try {
                const executed = await execute(sprite, launch, output, signal);
                return { ...executed, computeUsage: {
                    runtime: 'sprites', wallTimeMs: Date.now() - startedAt, cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null,
                    costUsd: null, costSource: null, runnerPool: slot!.usage,
                } };
            } finally {
                await ready.finished(slot!);
            }
        })().finally(() => { settled = true; output.end(); if (!slot) doneWithPool(); });
        const release = () => released ??= (async () => {
            await result.catch(() => {});
            if (!slot) return;
            try {
                await Promise.allSettled(reads);
                await commit?.();
            } finally {
                try { await (await pool).release(slot, { repo }); }
                finally { doneWithPool(); }
            }
        })();
        // A rejected run has no result for the caller to retrieve.
        void result.catch(() => release()).catch(() => {});
        return {
            get recoveryLocation() { return slot && `Sprite ${slot.sprite.name} at /opt/propr/result`; },
            spec, get stdout() { return output.get('stdout'); }, get stderr() { return output.get('stderr'); },
            wait: () => result, stop: async () => { cancellation.abort(new AgentRunStoppedError(spec.name)); await result.catch(() => {}); },
            inspect: async () => ({ name: spec.name, id: slot?.sprite.name, liveness: settled ? 'stopped' : 'running' }),
            isAlive: async () => !settled,
            readFile: async file => {
                if (!slot || released || !settled) return null;
                const name = ['status', 'result.bundle'].find(n => file === WORKSPACE_TRANSPORT_RESULT_DIR + '/' + n);
                if (!name) return null;
                const read = slot.sprite.filesystem().readFile('/opt/propr/result/' + name, null);
                reads.add(read);
                try { return await read; }
                catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
                finally { reads.delete(read); }
            }, release,
        };
    }
}
