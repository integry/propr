import { randomUUID } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import { AgentRunStoppedError, LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { execute } from './sprites/spritesExecution.js';
import { SpritePool, type Slot, type SpriteClient } from './sprites/spritesProvisioning.js';
import { unsupportedMount, uploadRun } from './sprites/spritesRun.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = { supportsBindMounts: false, supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['clone'] as const };
    readonly unsupportedMount = unsupportedMount;
    private pool?: { token: string; ready: Promise<SpritePool> };

    constructor(private readonly client?: SpriteClient, private readonly environment = process.env) {}

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
        if (this.pool?.token !== token) {
            const ready = this.client ? Promise.resolve(new SpritePool(this.client))
                : import('@fly/sprites').then(({ SpritesClient }) => new SpritePool(new SpritesClient(token)));
            this.pool = { token, ready };
        }
        const pool = this.pool.ready;
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
            const refusal = await admitCostExecution('sprites', [], { ...options, agentRun: { spec } });
            if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
            signal.throwIfAborted();
            slot = await (await pool).acquire();
            signal.throwIfAborted();
            const inputPath = `/opt/propr/inbox/${randomUUID()}.json`;
            const launch = { spec, options, token, inputPath };
            const writeBack = await uploadRun(slot.sprite, launch);
            signal.throwIfAborted();
            commit = writeBack;
            return execute(slot.sprite, launch, output, signal);
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
            releaseAfterResultRead: true, spec, get stdout() { return output.get('stdout'); }, get stderr() { return output.get('stderr'); },
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
