import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import {
    WORKSPACE_RESULT_BUNDLE_FILE, WORKSPACE_RESULT_STATUS_FILE, WORKSPACE_TRANSPORT_RESULT_DIR,
} from '../../git/workspaceTransportScript.js';
import logger from '../../utils/logger.js';
import type { ReturnedCredentialFile } from '../credentials/broker.js';
import { credentialRunRoot, STAGING_RETAINED_FILE } from '../credentials/hostCredentialStaging.js';
import type { AgentType } from '../types.js';
import { AgentRunStoppedError, LazyOutputStreams } from './agentRunOutput.js';
import type { AgentRunOptions } from './dockerRuntime.js';
import {
    applySpritesClientSignalsDefault, redactSpritesToken, resolveSpritesRuntimeConfig, type SpritesRuntimeConfig,
} from './sprites/spritesConfig.js';
import { readSpriteCredentialExport, readSpriteExportFile } from './sprites/spritesExport.js';
import { SpritePool, type SpriteAcquisitionTimings, type SpriteLease, type SpriteRecycleOutcome } from './sprites/spritesPool.js';
import {
    buildSpritesPayload, materializeSpritesCredentials, planSpritesRun, spritesCliVersionRefusal, spritesMountRefusal,
    SPRITES_EXPORT_DIR, SPRITES_PAYLOAD, SPRITES_RESULT_DIR, type SpritesRunCredentials,
} from './sprites/spritesRunPlan.js';
import { defaultSpritesClientFactory, type SpritesClientFactory, type SpritesClientLike } from './sprites/spritesSdk.js';
import { readSpritesSetupBundle, type SpritesSetupBundle } from './sprites/spritesSetup.js';
import { superviseSpritesRun, type SpritesRunSupervised } from './sprites/spritesSupervisor.js';
import type {
    AgentRunConfigSelection, AgentRunHandle, AgentRunInspection, AgentRunMount, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities,
} from './types.js';

export { SpritesRunInterruptedError } from './sprites/spritesSupervisor.js';
export { SpritesConfigurationError } from './sprites/spritesConfig.js';

export const SPRITES_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = Object.freeze({
    // Host paths never reach a Sprite: credentials and small read-only files are copied in instead.
    supportsBindMounts: false,
    // Restricted runs are refused before launch rather than run with open egress.
    supportsRestrictedNetwork: false,
    supportsMcpPrivateNetwork: false,
    supportsMcpReachableUrl: true,
    // A run is followed by the worker that started it; its Sprite is restored before any other run.
    reattach: false,
    workspaceTransports: Object.freeze(['clone'] as const),
});

/** The clone transport's bundle fallback is held in memory until the run is released. */
export const MAX_SPRITES_RESULT_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_RESULT_STATUS_BYTES = 4096;

export interface SpritesRuntimeDependencies {
    createClient?: SpritesClientFactory;
    config?: () => SpritesRuntimeConfig;
    setupBundle?: () => SpritesSetupBundle;
    environment?: NodeJS.ProcessEnv;
    /** Tests shorten these. */
    reconnectDelayMs?: number;
    stopGraceMs?: number;
    lockPollMs?: number;
}

/** Where a run's startup time went, logged once the agent starts, plus the restore that follows the run. */
export interface SpritesRunTimings extends SpriteAcquisitionTimings {
    /** Building and uploading the run's payload (credentials included) in one archive. */
    credentialSyncMs?: number;
    /** From `start()` until the launcher was running. */
    totalMs?: number;
    /** Reading the export and writing refreshed credentials back. */
    credentialWriteBackMs?: number;
    /** The restore (or replacement) after the run. */
    recycleMs?: number;
    recycleAction?: SpriteRecycleOutcome['action'];
}

class SpritesRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly cancellation = new AbortController();
    private readonly result: Promise<ExecutionResult>;
    readonly timings: SpritesRunTimings = {};
    private lease?: SpriteLease;
    private started = false;
    private settled = false;
    /** The workspace result files, read before the Sprite is restored and kept until release. */
    private readonly resultFiles = new Map<string, Buffer>();
    /** The Sprite's return to its clean checkpoint: begun when the run ends, whatever its outcome. */
    private recycled?: Promise<void>;
    private released?: Promise<void>;

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions, private readonly runtime: SpritesRuntime) {
        const ownership = getExecutionOwnershipContext()?.signal;
        const signal = AbortSignal.any([this.cancellation.signal, ...(options.signal ? [options.signal] : []), ...(ownership ? [ownership] : [])]);
        this.result = this.run(options, signal);
        const settle = (): void => {
            this.settled = true;
            this.output.end();
        };
        this.result.then(settle, settle);
    }

    get stdout(): Readable { return this.output.get('stdout'); }
    get stderr(): Readable { return this.output.get('stderr'); }
    wait(): Promise<ExecutionResult> { return this.result; }

    private stoppedOr(error: unknown): unknown {
        return this.cancellation.signal.aborted ? new AgentRunStoppedError(this.spec.name) : error;
    }

    private async run(options: AgentRunOptions, signal: AbortSignal): Promise<ExecutionResult> {
        const requested = Date.now();
        const timeoutMs = options.timeout ?? 300_000;
        const { spec } = this;
        const config = this.runtime.config();
        if (options.extraMounts?.length) throw new Error(`Agent runtime "sprites" cannot provide extra host mounts for ${spec.name}`);
        // Validated before a Sprite is taken: an unsupported spec never reaches one.
        const plan = planSpritesRun(spec, { ...process.env, ...options.extraEnvVars }, config.token);
        if (plan.withheld.length > 0) logger.warn({ run: spec.name, variables: plan.withheld }, 'Withheld variables carrying the Sprites token from the agent run');
        const admitted = admitCostExecution('sprites', [], { costCapExempt: options.costCapExempt, agentRun: { spec } });
        const refusal = admitted ? await admitted : null;
        if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);

        let supervised: SpritesRunSupervised | undefined;
        let credentials: SpritesRunCredentials | undefined;
        try {
            try {
                this.lease = await this.runtime.pool.acquire(signal, this.timings);
            } catch (error) {
                throw this.stoppedOr(error);
            }
            const { sprite } = this.lease;
            const uploadStarted = Date.now();
            credentials = materializeSpritesCredentials(plan, { environment: this.runtime.environment, orgToken: config.token });
            for (const store of credentials?.bundle.stores ?? []) {
                if (store.skipped.length > 0) logger.info({ run: spec.name, store: store.id, skipped: store.skipped }, 'Credential broker skipped store entries');
            }
            const payload = buildSpritesPayload(plan, { credentials, stdinData: options.stdinData, stdin: spec.stdin });
            signal.throwIfAborted();
            await sprite.filesystem().writeFile(SPRITES_PAYLOAD, payload, { mode: 0o600 });
            this.timings.credentialSyncMs = Date.now() - uploadStarted;
            signal.throwIfAborted();
            this.started = true;
            supervised = await superviseSpritesRun({
                spec, options, sprite, signal,
                remainingMs: timeoutMs - (Date.now() - requested),
                reconnectDelayMs: this.runtime.dependencies.reconnectDelayMs,
                stopGraceMs: this.runtime.dependencies.stopGraceMs,
                onOutput: (stream, chunk) => this.output.write(stream, chunk),
                onStarted: () => {
                    this.timings.totalMs = Date.now() - requested;
                    logger.info({ run: spec.name, sprite: sprite.name, timings: { ...this.timings } }, 'Sprites run started');
                },
            });
            // Before the Sprite is restored: the refreshed credentials, then the workspace result.
            const returned = (what: string) => (error: unknown) => {
                logger.error({ run: spec.name, sprite: sprite.name, error: this.message(error) }, `Could not read the ${what} the Sprites run returned`);
            };
            if (credentials && supervised.launched) await this.writeBackCredentials(credentials, supervised).catch(returned('credentials'));
            if (supervised.launched) await this.readWorkspaceResult(supervised).catch(returned('workspace result'));
        } catch (error) {
            if (!supervised) throw this.stoppedOr(this.redacted(error));
            throw error;
        } finally {
            this.recycle(supervised);
        }
        return supervised!.settle();
    }

    private message(error: unknown): string {
        return redactSpritesToken((error as Error)?.message ?? String(error), this.runtime.config().token);
    }

    /** The same error with the org token removed from its message, should an SDK error ever quote it. */
    private redacted(error: unknown): unknown {
        if (error instanceof Error) {
            const message = this.message(error);
            if (message !== error.message) error.message = message;
        }
        return error;
    }

    /**
     * Returns refreshed tokens to their canonical stores through the launcher's
     * export directory only. Anything that is not a plain regular file within
     * the size limit is refused; a failed write-back keeps the tokens on the
     * worker (never on the Sprite, which is restored either way).
     */
    private async writeBackCredentials(credentials: SpritesRunCredentials, supervised: SpritesRunSupervised): Promise<void> {
        const started = Date.now();
        const { spec } = this;
        if (supervised.exportState !== 'ok') {
            // `none`: the launcher refused to start the command, so the provider never ran.
            if (supervised.exportState !== 'none') {
                logger.error({ run: spec.name, sprite: this.lease?.name, exportState: supervised.exportState ?? 'unknown' },
                    'The Sprites run did not export its credentials; a token the provider refreshed during the run is lost and the account may need a new login');
            }
            return;
        }
        const filesystem = this.lease!.sprite.filesystem();
        const returned: ReturnedCredentialFile[] = [];
        for (const [index, output] of credentials.outputs.entries()) {
            const exported = await readSpriteCredentialExport(filesystem, SPRITES_EXPORT_DIR, index);
            if (typeof exported === 'string') {
                if (exported !== 'missing') logger.warn({ run: spec.name, store: output.storeId, path: output.path, reason: exported }, 'Refused an exported credential');
                continue;
            }
            returned.push({ storeId: output.storeId, path: output.path, content: exported.content, mtimeMs: exported.mtimeMs });
        }
        try {
            const results = await credentials.broker.commit(credentials.bundle, returned);
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials');
        } catch (error) {
            this.retainReturnedCredentials(credentials, returned, this.message(error));
        }
        this.timings.credentialWriteBackMs = Date.now() - started;
    }

    /** Keeps refreshed tokens that could not be written back in a retained staging directory on the worker, as the Docker runtime does. */
    private retainReturnedCredentials(credentials: SpritesRunCredentials, returned: readonly ReturnedCredentialFile[], error: string): void {
        const { spec } = this;
        try {
            const root = credentialRunRoot(this.runtime.environment);
            const directory = path.join(root, `${spec.name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-80)}-${randomBytes(6).toString('hex')}`);
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const files = returned.map(file => {
                const staged = path.join(directory, file.storeId, file.path);
                fs.mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 });
                fs.writeFileSync(staged, file.content, { mode: 0o600 });
                const canonicalRoot = credentials.bundle.stores.find(store => store.id === file.storeId)!.canonicalRoot;
                return { staged, canonical: path.join(canonicalRoot, file.path) };
            });
            fs.writeFileSync(path.join(directory, STAGING_RETAINED_FILE), `${JSON.stringify({ retainedAt: new Date().toISOString(), error, files }, null, 2)}\n`, { mode: 0o600 });
            logger.error({ run: spec.name, stagingDir: directory, error, files },
                'Credential broker could not write back refreshed credentials; kept them on the worker. Restore each staged file that is newer than its canonical file, then delete the directory');
        } catch (retainError) {
            logger.error({ run: spec.name, error, retainError: this.message(retainError) }, 'Credential broker could not write back refreshed credentials, and they could not be kept on the worker');
        }
    }

    /** Reads the clone transport's result (its status, and the bundle fallback when it left one) off the Sprite. */
    private async readWorkspaceResult(supervised: SpritesRunSupervised): Promise<void> {
        if (!supervised.terminated) return;
        const filesystem = this.lease!.sprite.filesystem();
        const status = await readSpriteExportFile(filesystem, SPRITES_RESULT_DIR, WORKSPACE_RESULT_STATUS_FILE, MAX_RESULT_STATUS_BYTES);
        if (status.ok) this.resultFiles.set(WORKSPACE_RESULT_STATUS_FILE, status.content);
        const state = status.ok ? status.content.toString('utf8').trim().split(/\s+/)[0] : undefined;
        // A pushed result is on the repository; a failed run left none.
        if (state === 'pushed' || state === 'failed') return;
        const bundle = await readSpriteExportFile(filesystem, SPRITES_RESULT_DIR, WORKSPACE_RESULT_BUNDLE_FILE, MAX_SPRITES_RESULT_BUNDLE_BYTES);
        if (bundle.ok) this.resultFiles.set(WORKSPACE_RESULT_BUNDLE_FILE, bundle.content);
        else if (bundle.reason !== 'missing') logger.error({ run: this.spec.name, sprite: this.lease!.name, reason: bundle.reason }, 'Refused the workspace result bundle of the Sprites run');
    }

    /**
     * Gives the Sprite back: always through the pool's restore (or, when the
     * run's processes are not known to be gone or the launcher found the
     * Sprite unclean, its destroy-and-provision). Runs once, as soon as the
     * run ends, so the next run's startup does not pay for it.
     */
    private recycle(supervised?: SpritesRunSupervised): void {
        const lease = this.lease;
        if (!lease || this.recycled) return;
        // `none`: the launcher refused the Sprite (it was not at its clean checkpoint) or could not install the run.
        const unclean = this.started && (!supervised || (supervised.launched && (!supervised.terminated || supervised.exportState === 'none')));
        this.recycled = this.runtime.pool.recycle(lease, unclean ? { destroy: true, reason: 'the run could not be confirmed stopped, or the launcher refused the Sprite' } : {})
            .then(outcome => {
                this.timings.recycleMs = outcome.durationMs;
                this.timings.recycleAction = outcome.action;
                logger.info({ run: this.spec.name, sprite: lease.name, action: outcome.action, durationMs: outcome.durationMs }, 'Sprite returned to its clean checkpoint after the run');
            });
    }

    private async settlesWithin(ms: number): Promise<boolean> {
        if (this.settled) return true;
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
        try { return await Promise.race([this.result.then(() => true, () => true), expired]); }
        finally { clearTimeout(timer); }
    }

    /** Cancels a launch still preparing; a started run is stopped (TERM, then KILL). Resolves once the run settled. */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 10_000): Promise<void> {
        if (this.settled) return;
        logger.info({ run: this.spec.name, sprite: this.lease?.name, signal }, 'Stopping Sprites run');
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        if (!await this.settlesWithin(timeoutMs + 3 * 60_000)) throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
    }

    async inspect(): Promise<AgentRunInspection> {
        const name = this.spec.name;
        if (this.settled) return { liveness: 'stopped', name };
        return { liveness: this.started ? 'running' : 'not_found', ...(this.lease ? { id: this.lease.name } : {}), name };
    }

    async isAlive(): Promise<boolean> { return (await this.inspect()).liveness === 'running'; }

    /** The workspace result files, as read off the Sprite when the run ended. */
    async readFile(filePath: string): Promise<Buffer | null> {
        if (!this.settled || this.released) return null;
        const relative = path.posix.relative(WORKSPACE_TRANSPORT_RESULT_DIR, filePath);
        return this.resultFiles.get(relative) ?? null;
    }

    /** The result files are the worker's own copy and stay until {@link release}; the Sprite is restored regardless. */
    retain(): void { /* nothing is removed before release */ }

    /**
     * Stops the run if it is still going, waits until its Sprite is back at
     * its clean checkpoint (restored, or destroyed and provisioned anew) and
     * drops the result files. The restore itself never depends on this call.
     */
    release(): Promise<void> {
        this.released ??= (async () => {
            if (!this.settled) {
                await this.stop().catch(error => logger.warn({ run: this.spec.name, error: (error as Error).message }, 'Sprites run is still settling after its stop'));
                await this.result.then(() => undefined, () => undefined);
            }
            await this.recycled;
            this.resultFiles.clear();
        })();
        return this.released;
    }
}

/**
 * Runs agents on Fly Sprites through `@fly/sprites`. One run per Sprite at a
 * time; every run starts on the Sprite's clean post-setup checkpoint and the
 * checkpoint is restored when the run ends, so nothing of a run (workspace,
 * logs, scratch, tokens, HOME) can reach the next. See the Agent Runtime reference.
 */
export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = SPRITES_RUNTIME_CAPABILITIES;
    readonly environment: NodeJS.ProcessEnv;
    readonly pool: SpritePool;
    private clientPromise?: Promise<SpritesClientLike>;
    private clientToken?: string;
    private bundle?: SpritesSetupBundle;

    constructor(readonly dependencies: SpritesRuntimeDependencies = {}) {
        this.environment = dependencies.environment ?? process.env;
        applySpritesClientSignalsDefault(this.environment);
        // The SDK reads the switch from the process environment.
        if (this.environment !== process.env) applySpritesClientSignalsDefault();
        this.pool = new SpritePool({ client: () => this.client(), config: () => this.config(), bundle: () => this.setupBundle(), lockPollMs: dependencies.lockPollMs });
    }

    config(): SpritesRuntimeConfig {
        return this.dependencies.config?.() ?? resolveSpritesRuntimeConfig(this.environment);
    }

    setupBundle(): SpritesSetupBundle {
        return this.dependencies.setupBundle?.() ?? (this.bundle ??= readSpritesSetupBundle());
    }

    /** One client per token; a rotated token gets a new one. */
    client(): Promise<SpritesClientLike> {
        const config = this.config();
        if (!this.clientPromise || this.clientToken !== config.token) {
            this.clientToken = config.token;
            this.clientPromise = (this.dependencies.createClient ?? defaultSpritesClientFactory)(config);
            this.clientPromise.catch(() => { this.clientPromise = undefined; });
        }
        return this.clientPromise;
    }

    unsupportedMount(mount: Extract<AgentRunMount, { type: 'bind' }>): string | undefined {
        return spritesMountRefusal(mount);
    }

    /** A CLI version other than the one the setup pins cannot run on a Sprite. */
    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec): string | undefined {
        const type: AgentType = config?.type ?? spec.profile.agentType;
        return spritesCliVersionRefusal({ ...config, type }, this.setupBundle().pins);
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): SpritesRunHandle {
        return new SpritesRunHandle(spec, options, this);
    }
}
