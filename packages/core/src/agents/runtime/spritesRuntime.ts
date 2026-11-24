import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { admitCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../git/workspaceTransportScript.js';
import logger from '../../utils/logger.js';
import { AgentRunStoppedError, LazyOutputStreams, UNRELEASED_RUN_REMOVAL_MS, type AgentRunOptions } from './dockerRuntime.js';
import {
    planSpritesMounts, renderSpritesArgv, resolveSpritesEnvironment, spritesManifest, spritesMountRefusal, spritesRunPaths, spritesRunUser,
    encodeNulList, spritesRunLeftovers, SPRITES_CREDENTIAL_TARGETS, SPRITES_LAUNCHER_SCRIPT, SPRITES_RUN_ROOT, SPRITES_SCRUB_SCRIPT, type SpritesRunPaths,
} from './sprites/spritesCommand.js';
import { applySpritesClientSignalsDefault, resolveSpritesRuntimeConfig, type SpritesRuntimeConfig } from './sprites/spritesConfig.js';
import { prepareSpritesCredentials, type SpritesCredentialSync } from './sprites/spritesCredentials.js';
import { findRunSession, launcherIsRunning, readRecordedExitStatus, superviseSpriteSession } from './sprites/spritesExecution.js';
import { clearCleanMarker, prepareSprite, readSpritesSetupBundle, restoreCleanCheckpoint, spriteName, SpritePool, spriteRunInProgress, wakeSprite, type SpritesSetupBundle } from './sprites/spritesProvisioning.js';
import { defaultSpritesClientFactory, type SpriteCommandLike, type SpriteLike, type SpritesClientFactory, type SpritesClientLike } from './sprites/spritesSdk.js';
import type { AgentRunHandle, AgentRunInspection, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export { SpritesRunInterruptedError } from './sprites/spritesExecution.js';
export { SpritesConfigurationError } from './sprites/spritesConfig.js';

export const SPRITES_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = Object.freeze({
    // Host paths never reach a Sprite: credentials and small read-only files are copied in instead.
    supportsBindMounts: false,
    // Restricted runs are refused before launch rather than run with open egress.
    supportsRestrictedNetwork: false,
    supportsMcpPrivateNetwork: false,
    supportsMcpReachableUrl: true,
    // Runs live in detachable sessions with output logs on the Sprite.
    reattach: true,
    workspaceTransports: Object.freeze(['clone'] as const),
});

/** Startup overhead of one run, logged per run (`Sprites run startup overhead`). */
export interface SpritesStartupTimings {
    /** Waiting for a free Sprite of this worker. */
    queueMs?: number;
    /** Getting the Sprite awake, or creating it. */
    wakeMs?: number;
    created?: boolean;
    /** First-time provisioning (pinned CLIs, entrypoints) including its checkpoint. */
    setupMs?: number;
    /** Restoring the clean post-setup checkpoint. */
    restoreMs?: number;
    /** Uploading the run files and the per-run credential copy. */
    credentialSyncMs?: number;
    /** Session start to the clone transport's "cloned" line. */
    cloneMs?: number;
    /** Request to agent command start. */
    totalMs?: number;
    /** Reading refreshed tokens back and writing them to the canonical stores. */
    credentialWriteBackMs?: number;
}

export interface SpritesRuntimeDependencies {
    createClient?: SpritesClientFactory;
    config?: () => SpritesRuntimeConfig;
    setupBundle?: () => SpritesSetupBundle;
    environment?: NodeJS.ProcessEnv;
    reconnectDelayMs?: number;
}

/** Run id on the Sprite: derived from the (unique) run name, so a restarted worker finds it again. */
export function spritesRunId(spec: Pick<AgentRunSpec, 'name'>): string {
    const id = spec.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 96).replace(/-+$/, '');
    return id || 'run';
}

const CLONED_LINE = 'ProPR workspace transport: cloned';
const SESSION_HEADROOM_MS = 10 * 60_000;

interface Lease { sprite: SpriteLike; name: string; release(): void }

class SpritesRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly cancellation = new AbortController();
    private readonly result: Promise<ExecutionResult>;
    readonly timings: SpritesStartupTimings = {};
    private readonly paths: SpritesRunPaths;
    private lease?: Lease;
    private started = false;
    private settled = false;
    private retainedCredentials = false;
    private retained = false;
    private released?: Promise<void>;
    private releaseTimer?: NodeJS.Timeout;

    constructor(
        readonly spec: AgentRunSpec,
        options: AgentRunOptions,
        private readonly runtime: SpritesRuntime,
        attach?: { lease: Lease },
    ) {
        this.paths = spritesRunPaths(spritesRunId(spec));
        const ownership = getExecutionOwnershipContext()?.signal;
        const signal = AbortSignal.any([this.cancellation.signal, ...(options.signal ? [options.signal] : []), ...(ownership ? [ownership] : [])]);
        this.result = attach ? this.reattach(options, signal, attach.lease) : this.launch(options, signal);
        const settle = (): void => {
            this.settled = true;
            this.output.end();
            if (!this.released && !this.retained) {
                this.releaseTimer = setTimeout(() => { void this.release().catch(() => undefined); }, spec.workspace.mode === 'clone' ? UNRELEASED_RUN_REMOVAL_MS : 0);
                this.releaseTimer.unref();
            }
        };
        this.result.then(settle, settle);
    }

    get stdout(): Readable { return this.output.get('stdout'); }
    get stderr(): Readable { return this.output.get('stderr'); }
    wait(): Promise<ExecutionResult> { return this.result; }

    private async launch(options: AgentRunOptions, signal: AbortSignal): Promise<ExecutionResult> {
        const requested = Date.now();
        const timeoutMs = options.timeout ?? 300_000;
        const config = this.runtime.config();
        const argv = renderSpritesArgv(this.spec);
        const plan = planSpritesMounts(this.spec);
        const admitted = admitCostExecution('sprites', [], { costCapExempt: options.costCapExempt, agentRun: { spec: this.spec } });
        const refusal = admitted ? await admitted : null;
        if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
        const launchEnvironment = { ...process.env, ...options.extraEnvVars };
        const credentials = prepareSpritesCredentials(this.spec, plan, { launchEnvironment: options.extraEnvVars, environment: this.runtime.environment });
        const environment = resolveSpritesEnvironment(this.spec, launchEnvironment);
        for (const [name, value] of Object.entries(credentials?.secretEnv ?? {})) environment.set(name, value);
        const client = await this.runtime.client();
        this.lease = await this.runtime.acquire(client, config, signal, this.timings);
        const { sprite } = this.lease;
        let provisioned = Date.now();
        try {
            const wakeStarted = Date.now();
            const provisioning = await prepareSprite(sprite, this.runtime.setupBundle(), config);
            Object.assign(this.timings, { ...(provisioning.setupMs !== undefined ? { setupMs: provisioning.setupMs } : {}), ...(provisioning.restoreMs !== undefined ? { restoreMs: provisioning.restoreMs } : {}) });
            this.timings.wakeMs = (this.timings.wakeMs ?? 0) + Math.max(0, Date.now() - wakeStarted - (provisioning.setupMs ?? 0) - (provisioning.restoreMs ?? 0));
            signal.throwIfAborted();
            provisioned = Date.now();
            await this.uploadRun(sprite, { argv, environment, plan, credentials, stdinData: options.stdinData });
            this.timings.credentialSyncMs = Date.now() - provisioned;
            signal.throwIfAborted();
        } catch (error) {
            await this.cleanSprite();
            this.lease.release();
            throw signal.aborted && this.cancellation.signal.aborted ? new AgentRunStoppedError(this.spec.name) : error;
        }
        const sessionStarted = Date.now();
        const command = sprite.createSession('sudo', ['-n', '/bin/bash', this.paths.launcher, this.paths.root], {
            cwd: '/', maxRunAfterDisconnect: `${Math.ceil((timeoutMs + SESSION_HEADROOM_MS) / 1000)}s`,
        });
        this.started = true;
        try {
            return await this.supervise({ options, signal, session: command, remainingMs: timeoutMs - (Date.now() - requested), sessionStarted, requested });
        } finally {
            await this.finishCredentials(credentials);
        }
    }

    private async reattach(options: AgentRunOptions, signal: AbortSignal, lease: Lease): Promise<ExecutionResult> {
        this.lease = lease;
        this.started = true;
        const plan = planSpritesMounts(this.spec);
        const credentials = prepareSpritesCredentials(this.spec, plan, { launchEnvironment: options.extraEnvVars, environment: this.runtime.environment });
        // The original baseline was lost with the worker: write a refreshed token back only when it is newer than the canonical one.
        for (const store of credentials?.bundle.stores ?? []) for (const output of store.outputs) store.baseline[output] = 'reattached';
        try {
            return await this.supervise({ options, signal, remainingMs: options.timeout ?? 300_000, sessionStarted: Date.now(), requested: Date.now() });
        } finally {
            await this.finishCredentials(credentials);
        }
    }

    private async supervise({ options, signal, session, remainingMs, sessionStarted, requested }: {
        options: AgentRunOptions; signal: AbortSignal; session?: SpriteCommandLike; remainingMs: number; sessionStarted: number; requested: number;
    }): Promise<ExecutionResult> {
        const { sprite } = this.lease!;
        let pendingStderr = '';
        return superviseSpriteSession({
            spec: this.spec, options, client: await this.runtime.client(), sprite, paths: this.paths, session,
            signal, remainingMs, keepAwakeIntervalMs: this.runtime.config().keepAwakeIntervalMs,
            reconnectDelayMs: this.runtime.reconnectDelayMs,
            onStarted: () => {
                this.timings.totalMs = Date.now() - requested;
                logger.info({ run: this.spec.name, sprite: sprite.name, timings: this.timings }, 'Sprites run startup overhead');
            },
            onOutput: (stream, chunk) => {
                if (stream === 'stderr' && this.timings.cloneMs === undefined) {
                    pendingStderr = (pendingStderr + chunk).slice(-4096);
                    if (pendingStderr.includes(CLONED_LINE)) {
                        this.timings.cloneMs = Date.now() - sessionStarted;
                        logger.info({ run: this.spec.name, sprite: sprite.name, cloneMs: this.timings.cloneMs }, 'Sprites run workspace cloned');
                    }
                }
                this.output.write(stream, chunk);
            },
        });
    }

    private async uploadRun(sprite: SpriteLike, { argv, environment, plan, credentials, stdinData }: {
        argv: string[]; environment: Map<string, string>; plan: ReturnType<typeof planSpritesMounts>;
        credentials?: SpritesCredentialSync; stdinData?: string;
    }): Promise<void> {
        const filesystem = sprite.filesystem();
        const { paths } = this;
        await filesystem.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
        await filesystem.mkdir(SPRITES_RUN_ROOT, { recursive: true, mode: 0o711 });
        await filesystem.mkdir(paths.root, { recursive: true, mode: 0o700 });
        await credentials?.upload(filesystem, paths);
        const records: string[][] = SPRITES_CREDENTIAL_TARGETS.map(target => ['purge', target]);
        records.push(...(credentials?.records ?? []));
        for (const directory of plan.directories) records.push(['dir', directory]);
        let index = 0;
        for (const file of plan.files) {
            const relative = `files/${index++}`;
            await filesystem.mkdir(path.posix.join(paths.root, 'files'), { recursive: true, mode: 0o700 });
            await filesystem.writeFile(path.posix.join(paths.root, relative), await readFile(file.source), { mode: 0o600 });
            records.push(['file', relative, file.target, (file.mode || 0o400).toString(8)]);
        }
        await filesystem.writeFile(paths.manifest, spritesManifest(records), { mode: 0o600 });
        await filesystem.writeFile(paths.argv, encodeNulList(argv), { mode: 0o600 });
        await filesystem.writeFile(paths.env, encodeNulList([...environment].map(([name, value]) => `${name}=${value}`)), { mode: 0o600 });
        await filesystem.writeFile(paths.workdir, this.spec.workdir, { mode: 0o600 });
        await filesystem.writeFile(paths.user, spritesRunUser(this.spec), { mode: 0o600 });
        if (this.spec.stdin) await filesystem.writeFile(paths.stdin, stdinData ?? '', { mode: 0o600 });
        if (this.spec.workspace.mode === 'clone') await filesystem.writeFile(path.posix.join(paths.root, 'clone'), '', { mode: 0o600 });
        await filesystem.writeFile(paths.launcher, SPRITES_LAUNCHER_SCRIPT, { mode: 0o700 });
    }

    private async finishCredentials(credentials?: SpritesCredentialSync): Promise<void> {
        if (!credentials || !this.lease) return;
        const started = Date.now();
        const outcome = await credentials.writeBack(this.lease.sprite.filesystem(), this.paths);
        this.retainedCredentials = outcome.retained;
        this.timings.credentialWriteBackMs = Date.now() - started;
    }

    /**
     * Leaves nothing of the run at rest on the Sprite: restores the clean
     * checkpoint (which also spares the next run its restore), or, without
     * one, removes the run directory and everything the run left outside it.
     */
    private async cleanSprite(): Promise<void> {
        if (!this.lease) return;
        const { sprite, name } = this.lease;
        // A run directory holding the only copy of a rotated token must survive.
        if (!this.retainedCredentials && this.runtime.config().restoreCheckpoint) {
            try {
                const restoreMs = await restoreCleanCheckpoint(sprite, this.runtime.setupBundle());
                if (restoreMs !== undefined) {
                    logger.info({ run: this.spec.name, sprite: name, restoreMs }, 'Restored the Sprite to its clean checkpoint after the run');
                    return;
                }
            } catch (error) {
                logger.warn({ run: this.spec.name, sprite: name, error: (error as Error).message }, 'Could not restore the Sprite after the run; removing the run data instead');
            }
        }
        await this.discardRunDirectory();
    }

    private async discardRunDirectory(): Promise<void> {
        if (!this.lease) return;
        const { sprite, name } = this.lease;
        const warn = (what: string) => (error: unknown) => {
            logger.warn({ run: this.spec.name, sprite: name, error: (error as Error).message }, what);
        };
        await clearCleanMarker(sprite).catch(warn('Could not remove the Sprite clean marker'));
        // Root-owned: the clone workspace, the workspace result and Antigravity's disposable HOME.
        await Promise.resolve()
            .then(() => sprite.execFile('sudo', ['-n', 'bash', '-c', SPRITES_SCRUB_SCRIPT, 'propr-scrub', ...spritesRunLeftovers(this.spec)], { timeout: 120_000 }))
            .then(result => { if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${String(result.stderr).trim()}`); })
            .catch(warn('Could not remove the run data the run left on the Sprite'));
        if (this.retainedCredentials) return;
        await sprite.filesystem().rm(this.paths.root, { recursive: true, force: true }).catch(warn('Could not remove the Sprite run directory'));
    }

    private async settlesWithin(ms: number): Promise<boolean> {
        if (this.settled) return true;
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
        try { return await Promise.race([this.result.then(() => true, () => true), expired]); }
        finally { clearTimeout(timer); }
    }

    /** Cancels a launch still preparing; a started run gets its session stopped. Resolves once the run settled. */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 10_000): Promise<void> {
        if (this.settled) return;
        // The launcher always gets TERM first (KILL after its grace period), whatever signal was asked for.
        logger.info({ run: this.spec.name, sprite: this.lease?.name, signal }, 'Stopping Sprites run');
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        if (!await this.settlesWithin(timeoutMs + 60_000)) throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
    }

    async inspect(): Promise<AgentRunInspection> {
        const name = this.spec.name;
        if (this.settled) return { liveness: 'stopped', name };
        if (!this.started || !this.lease) return { liveness: 'not_found', name };
        try {
            if (await launcherIsRunning(this.lease.sprite, this.paths)) {
                const sessionId = await findRunSession(this.lease.sprite, this.paths).catch(() => undefined);
                return { liveness: 'running', ...(sessionId ? { id: sessionId } : {}), name };
            }
            return { liveness: await readRecordedExitStatus(this.lease.sprite, this.paths) === undefined ? 'not_found' : 'stopped', name };
        } catch {
            return { liveness: 'unavailable', name };
        }
    }

    async isAlive(): Promise<boolean> { return (await this.inspect()).liveness === 'running'; }

    /** The workspace result files, copied by the launcher into the run directory once the run finished. */
    async readFile(filePath: string): Promise<Buffer | null> {
        if (!this.settled || this.released || !this.lease) return null;
        const relative = path.posix.relative(WORKSPACE_TRANSPORT_RESULT_DIR, filePath);
        if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) return null;
        try {
            return await this.lease.sprite.filesystem().readFile(path.posix.join(this.paths.result, relative), null);
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code === 'ENOENT' || /not found|no such file/i.test((error as Error).message)) return null;
            throw error;
        }
    }

    retain(): void {
        this.retained = true;
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
    }

    /**
     * Restores the Sprite to its clean checkpoint (or removes everything the run
     * left, keeping only a run directory with unreturned credentials) and frees
     * the Sprite for the next run.
     */
    release(): Promise<void> {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.released ??= (async () => {
            if (!this.settled) await this.stop();
            await this.cleanSprite();
            this.lease?.release();
        })();
        return this.released;
    }
}

/**
 * Runs agents on Fly Sprites through `@fly/sprites`: one detachable session
 * per run on a worker-owned Sprite, the clone workspace transport, and the
 * credential broker over the filesystem API. See the Agent Runtime reference.
 */
export class SpritesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'sprites';
    readonly capabilities = SPRITES_RUNTIME_CAPABILITIES;
    readonly environment: NodeJS.ProcessEnv;
    private readonly pool = new SpritePool(() => this.config().maxSprites);
    private clientPromise?: Promise<SpritesClientLike>;
    private clientToken?: string;
    private bundle?: SpritesSetupBundle;
    /** Delay between output reconnect attempts (tests shorten it). */
    readonly reconnectDelayMs?: number;

    constructor(private readonly dependencies: SpritesRuntimeDependencies = {}) {
        this.environment = dependencies.environment ?? process.env;
        this.reconnectDelayMs = dependencies.reconnectDelayMs;
        applySpritesClientSignalsDefault(this.environment);
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

    async acquire(client: SpritesClientLike, config: SpritesRuntimeConfig, signal: AbortSignal, timings: SpritesStartupTimings): Promise<Lease> {
        const queued = Date.now();
        const skip = new Set<number>();
        for (;;) {
            const slot = await this.pool.acquireSlot(signal, skip);
            timings.queueMs = Date.now() - queued;
            const name = spriteName(config, slot.slot);
            let lease: Lease;
            try {
                const started = Date.now();
                const { sprite, created } = await wakeSprite(client, name, config);
                timings.wakeMs = Date.now() - started;
                timings.created = created;
                lease = { sprite, name, release: slot.release };
            } catch (error) {
                slot.release();
                throw new Error(`Could not wake or create Sprite ${name}: ${(error as Error).message}`, { cause: error });
            }
            if (timings.created || !await spriteRunInProgress(lease.sprite)) return lease;
            logger.warn({ sprite: name }, 'Sprite is running another process\'s agent run; set PROPR_SPRITES_WORKER_ID per ProPR process on one host');
            slot.release();
            skip.add(slot.slot);
        }
    }

    unsupportedMount(mount: Parameters<NonNullable<AgentRuntime['unsupportedMount']>>[0]): string | undefined {
        return spritesMountRefusal(mount);
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): SpritesRunHandle {
        return new SpritesRunHandle(spec, options, this);
    }

    /** Find the run on this worker's Sprites (after a restart) and follow it to completion. */
    async attach(spec: AgentRunSpec, options: AgentRunOptions = {}): Promise<SpritesRunHandle | null> {
        const config = this.config();
        const client = await this.client();
        const paths = spritesRunPaths(spritesRunId(spec));
        for (let slot = 0; slot < config.maxSprites; slot++) {
            const name = spriteName(config, slot);
            const sprite = client.sprite(name);
            const running = await launcherIsRunning(sprite, paths).catch(() => false);
            const finished = running ? undefined : await readRecordedExitStatus(sprite, paths).catch(() => undefined);
            if (!running && finished === undefined) continue;
            const claim = this.pool.claim(slot);
            if (!claim) continue;
            logger.info({ run: spec.name, sprite: name, running, exitCode: finished }, 'Reattaching to a Sprites run');
            return new SpritesRunHandle(spec, options, this, { lease: { sprite, name, release: claim.release } });
        }
        return null;
    }
}
