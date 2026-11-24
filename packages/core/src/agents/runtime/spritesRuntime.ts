import { assertNativeLogAdmission } from '../../diagnostics/managedLogRuntime.js';
import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import { AgentRunStoppedError, LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { execute } from './sprites/spritesExecution.js';
import { SpritePool, startupStep, type Slot, type SpriteClient } from './sprites/spritesProvisioning.js';
import { prepareSpriteRun, unsupportedMount } from './sprites/spritesRun.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = { supportsExtensions: false, supportsBindMounts: false, supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['clone'] as const };
    readonly unsupportedMount = unsupportedMount;
    private readonly pools = new Map<string, Promise<SpritePool>>();
    private closing?: Promise<void>;

    constructor(private readonly client?: SpriteClient | ((token: string) => Promise<SpriteClient>), private readonly environment = process.env) {}

    close(): Promise<void> {
        return this.closing ??= Promise.allSettled([...this.pools.values()].map(async pool => (await pool).close())).then(() => {});
    }

    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec) {
        const type = spec.profile.agentType;
        if (!['codex', 'claude', 'antigravity'].includes(type)) return `unsupported agent type ${type}`;
        return spritesCliVersionRefusal({ ...config, type });
    }

    private getPool(token: string) {
        let pool = this.pools.get(token);
        if (!pool) {
            const client = this.client;
            const load = async () => {
                if (typeof client === 'function') return client(token);
                if (client) return client;
                const { SpritesClient } = await import('@fly/sprites');
                return new SpritesClient(token);
            };
            pool = load().then(sdk => new SpritePool(sdk));
            this.pools.set(token, pool);
            void pool.catch(() => { if (this.pools.get(token) === pool) this.pools.delete(token); });
        }
        return pool;
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        if (extensionLaunchForRun(this.kind, [], { ...options, agentRun: { spec } })) throw new Error('Sprites runtime does not support extensions');
        assertNativeLogAdmission(options.diagnostics);
        const token = this.environment.PROPR_SPRITES_TOKEN || this.environment.SPRITES_TOKEN;
        if (!token) throw new Error('Set PROPR_SPRITES_TOKEN on the worker to run agents on Sprites');
        if (spec.network.restriction || spec.network.policy?.mode === 'restricted' || spec.network.mode === 'named')
            throw new Error('Sprites requires open networking');
        process.env.SPRITES_CLIENT_SIGNALS ??= '0';
        if (this.closing) throw new Error('Sprites runtime is closed');
        const pool = this.getPool(token);
        options = { ...options, extraEnvVars: { ...options.extraEnvVars } };
        const cancellation = new AbortController();
        const ownership = getExecutionOwnershipContext()?.signal;
        const signal = AbortSignal.any([cancellation.signal,
            ...(options.signal ? [options.signal] : []), ...(ownership ? [ownership] : [])]);
        const output = new LazyOutputStreams();
        let slot: Slot | undefined;
        let released: Promise<void> | undefined;
        const reads = new Set<Promise<Buffer | null>>();
        let commit: (() => Promise<void>) | undefined;
        let settled = false;
        const result = (async () => {
            const refusal = await startupStep(signal, () => admitCostExecution('sprites', [], { ...options, agentRun: { spec } }));
            if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
            const inputPath = `/opt/propr/inbox/${randomUUID()}.json`;
            const launch = { spec, options, token, inputPath };
            const prepared = prepareSpriteRun(launch);
            const ready = await startupStep(signal, () => pool);
            const sprite = await startupStep(signal, async () => {
                // An interrupted upload may still write to the leased Sprite. Discard it before reuse.
                const acquired = await ready.acquire(signal);
                try {
                    await startupStep(AbortSignal.any([signal, AbortSignal.timeout(60_000)]), () => prepared.upload(acquired.sprite));
                    signal.throwIfAborted();
                    slot = acquired;
                    return acquired.sprite;
                } catch (error) {
                    await ready.discard(acquired.sprite);
                    throw error;
                }
            });
            signal.throwIfAborted();
            const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeout ?? 300_000)]);
            const outcome = await execute(sprite, launch, {
                output, signal: executionSignal, prepared, onSpawn: () => { commit = () => prepared.commit(sprite); },
            });
            // A physical cost refusal has no workspace result for the caller to retain.
            if (!commit && slot) {
                const unused = slot;
                slot = undefined;
                await ready.release(unused);
            }
            return outcome;
        })().finally(() => { settled = true; output.end(); });
        const release = () => released ??= (async () => {
            await result.catch(() => {});
            if (!slot) return;
            try {
                await Promise.allSettled(reads);
                await commit?.();
            } finally {
                await (await pool).release(slot);
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
