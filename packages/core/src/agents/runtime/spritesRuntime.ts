import { assertNativeLogAdmission } from '../../diagnostics/managedLogRuntime.js';
import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import { extensionLaunchRefusal } from './extensionCapabilities.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { AGENT_EGRESS_RESTRICTED_ENV } from '../../network/egressAllowlist.js';
import { currentNetworkEgressDiagnostics } from '../../network/egressExecution.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import { AgentRunStoppedError, LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { execute } from './sprites/spritesExecution.js';
import { applySpriteNetworkPolicy, spriteNetworkPolicy, SPRITES_RESTRICTED_NETWORK_ENFORCEMENT } from './sprites/spritesNetwork.js';
import { SpritePool, startupStep, type Slot, type SpriteClient } from './sprites/spritesProvisioning.js';
import { prepareSpriteRun, unsupportedMount, validateSpriteRun } from './sprites/spritesRun.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';
import logger from '../../utils/logger.js';
import { LiveOutputLog } from '../impl/utils/liveOutputLog.js';
import { SpriteInventory, type SpritePoolRedis } from './sprites/spritesInventory.js';

// Operator catalog executables are not part of a Sprite: those servers stay refused (explicit) or dropped (auto-applied).
const SPRITES_EXTENSION_CAPABILITIES = Object.freeze({ skills: true, remoteMcp: true, packageMcp: true, catalogMcp: false });

export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    // Skill bundles travel with the run's upload and URL MCP servers through the extension gateway.
    // Package servers are installed while the Sprite is provisioned, in its clean checkpoint.
    static readonly capabilities = { extensions: SPRITES_EXTENSION_CAPABILITIES, supportsBindMounts: false, supportsRestrictedNetwork: true,
        restrictedNetworkEnforcement: SPRITES_RESTRICTED_NETWORK_ENFORCEMENT, supportsMcpPrivateNetwork: false,
        supportsMcpReachableUrl: true, reattach: false, workspaceTransports: ['clone'] as const };
    readonly capabilities = SpritesRuntime.capabilities;
    readonly unsupportedMount = unsupportedMount;
    private readonly pools = new Map<string, Promise<SpritePool>>();
    private closing?: Promise<void>;
    private startupRetry?: NodeJS.Timeout;

    constructor(private readonly client?: SpriteClient | ((token: string) => Promise<SpriteClient>), private readonly environment = process.env,
        private readonly poolRedis?: SpritePoolRedis) {}

    close(): Promise<void> {
        clearTimeout(this.startupRetry);
        return this.closing ??= Promise.allSettled([...this.pools.values()].map(async pool => (await pool).close())).then(() => {});
    }

    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec) {
        const type = spec.profile.agentType;
        if (!['codex', 'claude', 'antigravity'].includes(type)) return `unsupported agent type ${type}`;
        return spritesCliVersionRefusal({ ...config, type });
    }

    async initialize() {
        const token = this.environment.PROPR_SPRITES_TOKEN || this.environment.SPRITES_TOKEN;
        if (!token || this.closing) return;
        try { await this.getPool(token); }
        catch {
            logger.warn('Sprite pool initialization failed. Will retry in five minutes or at the next launch.');
            if (!this.closing) this.startupRetry = setTimeout(() => void this.initialize(), 5 * 60_000).unref();
        }
    }

    private getPool(token: string) {
        let pool = this.pools.get(token);
        if (!pool) {
            const client = this.client;
            const load = async () => {
                process.env.SPRITES_CLIENT_SIGNALS ??= '0';
                const sdk = typeof client === 'function' ? await client(token) : client ?? new (await import('@fly/sprites')).SpritesClient(token);
                // Embedded clients can supply an already managed Sprite (including the live smoke test).
                const inventory = sdk.listAllSprites && sdk.getSprite
                    ? await SpriteInventory.open({ listAllSprites: sdk.listAllSprites.bind(sdk), getSprite: sdk.getSprite.bind(sdk),
                        deleteSprite: sdk.deleteSprite.bind(sdk) }, this.environment, this.poolRedis)
                    : undefined;
                return new SpritePool(sdk, inventory);
            };
            pool = load();
            this.pools.set(token, pool);
            void pool.catch(() => { if (this.pools.get(token) === pool) this.pools.delete(token); });
        }
        return pool;
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        // Library items arrive filtered for this runtime; refuse a launch that still carries a class it cannot apply.
        const extension = extensionLaunchForRun(this.kind, [], { ...options, agentRun: { spec } });
        const extensionRefusal = extension && extensionLaunchRefusal(this, extension.requires);
        if (extensionRefusal) throw extensionRefusal;
        assertNativeLogAdmission(options.diagnostics);
        const token = this.environment.PROPR_SPRITES_TOKEN || this.environment.SPRITES_TOKEN;
        if (!token) throw new Error('Set PROPR_SPRITES_TOKEN on the worker to run agents on Sprites');
        // Named networks, private MCP endpoints and malformed policies stay refused.
        // URL MCP servers go through the extension gateway: a restricted Sprite allows its host too.
        const networkPolicy = spriteNetworkPolicy(spec, extension?.gatewayUrl ? [extension.gatewayUrl] : []);
        process.env.SPRITES_CLIENT_SIGNALS ??= '0';
        if (this.closing) throw new Error('Sprites runtime is closed');
        const pool = this.getPool(token);
        options = { ...options, extraEnvVars: { ...options.extraEnvVars } };
        const envDefaults = networkPolicy ? AGENT_EGRESS_RESTRICTED_ENV[spec.profile.agentType] : undefined;
        const diagnostics: string[] = [];
        const egressDiagnostics = currentNetworkEgressDiagnostics();
        const recordDiagnostic = (message: string) => {
            diagnostics.push(message);
            egressDiagnostics?.push(message);
        };
        const cancellation = new AbortController();
        const ownership = getExecutionOwnershipContext()?.signal;
        let signal = AbortSignal.any([cancellation.signal,
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
            const launch = { spec, options, token, inputPath, skillFiles: extension?.skillFiles };
            const validated = validateSpriteRun(launch, envDefaults);
            const ready = await startupStep(signal, () => pool);
            const { sprite, prepared, checkedOutAt, queueMs, provisioningMs, restoreMs, packageServerInstallMs } = await startupStep(signal, async () => {
                const acquired = await ready.acquire(signal, () => {
                    diagnostics.push('Waiting for a Sprite');
                    output.write('stderr', 'Waiting for a Sprite\n');
                    logger.info({ taskId: options.taskId, run: spec.name }, 'Waiting for a Sprite');
                    if (options.taskId && options.streamToRedis) {
                        const log = new LiveOutputLog(options.taskId);
                        log.append('Waiting for a Sprite\n', 'stderr');
                        void log.close().catch(() => {});
                    }
                }, extension?.packageInstall);
                const checkedOutAt = Date.now();
                if (acquired.lease) signal = AbortSignal.any([signal, acquired.lease]);
                const waitIndex = diagnostics.indexOf('Waiting for a Sprite');
                if (waitIndex >= 0) diagnostics.splice(waitIndex, 1);
                let prepared: ReturnType<typeof prepareSpriteRun> | undefined;
                try {
                    if (networkPolicy) {
                        await startupStep(AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
                            () => applySpriteNetworkPolicy(acquired.sprite, networkPolicy));
                        acquired.restricted = { policy: networkPolicy, run: spec.name, recordDiagnostic };
                    }
                    signal.throwIfAborted();
                    // The physical launch boundary: revalidates the library items and activates the run's gateway grant.
                    if (extension) await startupStep(signal, () => extension.beforeLaunch());
                    const payload = prepareSpriteRun(launch, validated, envDefaults);
                    prepared = payload;
                    await startupStep(AbortSignal.any([signal, AbortSignal.timeout(60_000)]), () => payload.upload(acquired.sprite));
                    signal.throwIfAborted();
                    slot = acquired;
                    return { sprite: acquired.sprite, prepared: payload, checkedOutAt, queueMs: acquired.queueMs, provisioningMs: acquired.provisioningMs, restoreMs: acquired.restoreMs,
                        packageServerInstallMs: acquired.packageServerInstallMs };
                } catch (error) {
                    // An interrupted policy change or upload can still write to the Sprite.
                    if (prepared || (networkPolicy && !acquired.restricted)) await ready.discard(acquired.sprite);
                    else ready.releaseInBackground(acquired);
                    throw error;
                }
            });
            try {
                signal.throwIfAborted();
                const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeout ?? 300_000)]);
                const executed = await execute(sprite, launch, {
                    output, signal: executionSignal, prepared, onSpawn: () => { commit = () => prepared.commit(sprite); },
                });
                return { ...executed, computeUsage: { runtime: 'sprites', wallTimeMs: Date.now() - checkedOutAt + provisioningMs + restoreMs,
                    queueMs, provisioningMs, restoreMs, ...(packageServerInstallMs !== undefined && { packageServerInstallMs }), cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null,
                    costUsd: null, costSource: null } };
            } finally {
                if (!commit && slot) {
                    ready.releaseInBackground(slot);
                    slot = undefined;
                }
            }
        })().finally(() => { settled = true; output.end(); });
        const release = () => released ??= (async () => {
            await result.catch(() => {});
            if (!slot) return;
            await Promise.allSettled(reads);
            await (await pool).release(slot, commit);
        })();
        // A rejected run has no result for the caller to retrieve.
        void result.catch(() => release()).catch(() => {});
        return {
            get recoveryLocation() { return slot && `Sprite ${slot.sprite.name} at /opt/propr/result`; },
            spec, get stdout() { return output.get('stdout'); }, get stderr() { return output.get('stderr'); },
            wait: () => result, stop: async () => { cancellation.abort(new AgentRunStoppedError(spec.name)); await result.catch(() => {}); },
            inspect: async () => ({ name: spec.name, id: slot?.sprite.name, liveness: settled ? 'stopped' : 'running',
                ...(diagnostics.length ? { diagnostics: [...diagnostics] } : {}) }),
            isAlive: async () => !settled,
            readFile: async file => {
                if (!slot || slot.lease?.aborted || released || !settled) return null;
                const name = ['status', 'result.bundle'].find(n => file === WORKSPACE_TRANSPORT_RESULT_DIR + '/' + n);
                if (!name) return null;
                const read = slot.sprite.filesystem().readFile('/opt/propr/result/' + name, null);
                reads.add(read);
                try {
                    const content = await read;
                    return slot.lease?.aborted ? null : content;
                }
                catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
                finally { reads.delete(read); }
            }, release,
        };
    }
}
