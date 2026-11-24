import { randomUUID } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import { AgentRunStoppedError, LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { execute } from './sprites/spritesExecution.js';
import { applySpriteNetworkPolicy, spriteNetworkPolicy, SPRITES_RESTRICTED_NETWORK_ENFORCEMENT } from './sprites/spritesNetwork.js';
import { SpritePool, startupStep, type Slot, type SpriteClient } from './sprites/spritesProvisioning.js';
import { unsupportedMount, uploadRun } from './sprites/spritesRun.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = { supportsBindMounts: false, supportsRestrictedNetwork: true,
        restrictedNetworkEnforcement: SPRITES_RESTRICTED_NETWORK_ENFORCEMENT, supportsMcpPrivateNetwork: false,
        supportsMcpReachableUrl: true, reattach: false, workspaceTransports: ['clone'] as const };
    readonly unsupportedMount = unsupportedMount;
    private readonly pools = new Map<string, Promise<SpritePool>>();
    private closing?: Promise<void>;

    constructor(private readonly client?: SpriteClient, private readonly environment = process.env) {}

    close(): Promise<void> {
        return this.closing ??= Promise.all([...this.pools.values()].map(async pool => (await pool).close())).then(() => {});
    }

    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec) {
        const type = spec.profile.agentType;
        if (!['codex', 'claude', 'antigravity'].includes(type)) return `unsupported agent type ${type}`;
        return spritesCliVersionRefusal({ ...config, type });
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        const token = this.environment.PROPR_SPRITES_TOKEN || this.environment.SPRITES_TOKEN;
        if (!token) throw new Error('Set PROPR_SPRITES_TOKEN on the worker to run agents on Sprites');
        // Named networks, private MCP endpoints and malformed policies stay refused.
        const networkPolicy = spriteNetworkPolicy(spec);
        process.env.SPRITES_CLIENT_SIGNALS ??= '0';
        if (this.closing) throw new Error('Sprites runtime is closed');
        let pool = this.pools.get(token);
        if (!pool) {
            pool = this.client ? Promise.resolve(new SpritePool(this.client))
                : import('@fly/sprites').then(({ SpritesClient }) => new SpritePool(new SpritesClient(token)));
            this.pools.set(token, pool);
        }
        options = { ...options, extraEnvVars: { ...options.extraEnvVars } };
        // As on Docker: a restricted Claude run skips the telemetry hosts its allowlist
        // denies, unless its configuration (env files, spec env) sets the variable.
        if (networkPolicy && spec.profile.agentType === 'claude') options.extraEnvVars!.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
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
        const result = (async () => {
            const refusal = await startupStep(signal, () => admitCostExecution('sprites', [], { ...options, agentRun: { spec } }));
            if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
            const inputPath = `/opt/propr/inbox/${randomUUID()}.json`;
            const launch = { spec, options, token, inputPath };
            const ready = await startupStep(signal, () => pool);
            const sprite = await startupStep(signal, async () => {
                // Keep ownership here until upload succeeds. Even a create response arriving
                // after stop() must dispose of its Sprite before this acquisition ends.
                const acquired = await ready.acquire(signal);
                try {
                    if (networkPolicy) {
                        // Marked first, so release clears a policy even if applying it failed halfway.
                        acquired.restricted = true;
                        await startupStep(signal, () => applySpriteNetworkPolicy(acquired.sprite, networkPolicy));
                    }
                    const writeBack = await startupStep(signal, () => uploadRun(acquired.sprite, launch));
                    signal.throwIfAborted();
                    slot = acquired;
                    commit = writeBack;
                    return acquired.sprite;
                } catch (error) {
                    if (signal.aborted) await ready.discard(acquired.sprite);
                    else await ready.release(acquired);
                    throw error;
                }
            });
            signal.throwIfAborted();
            return execute(sprite, launch, output, signal);
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
