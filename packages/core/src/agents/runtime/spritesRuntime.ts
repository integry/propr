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
    encodeNulList, spritesPurgeRecords, spritesRunLeftovers, SPRITES_LAUNCHER_SCRIPT, SPRITES_RUN_ROOT, SPRITES_SCRUB_SCRIPT, type SpritesRunPaths,
} from './sprites/spritesCommand.js';
import { spritesCliVersionRefusal } from './sprites/spritesCliVersions.js';
import { applySpritesClientSignalsDefault, resolveSpritesRuntimeConfig, type SpritesRuntimeConfig } from './sprites/spritesConfig.js';
import { prepareSpritesCredentials, type SpritesCredentialSync } from './sprites/spritesCredentials.js';
import { findRunSession, launcherIsRunning, readRecordedExitStatus, superviseSpriteSession, terminateRunProcesses, SPRITES_STOP_SETTLEMENT_MS } from './sprites/spritesExecution.js';
import { clearCleanMarker, readSpritesSetupBundle, restoreCleanCheckpoint, spriteName, SpritePool, type SpritesSetupBundle } from './sprites/spritesProvisioning.js';
import {
    acquireSprite, clearRecoveryObligation, finishRunCredentials, persistRecoveryObligation, provisionLeasedSprite, spriteHoldsRetainedCredentials,
    startDeadlineResult, untilAborted, SpritesStartDeadlineError, type SpriteRunLease, type SpritesStartupTimings,
} from './sprites/spritesRunLifecycle.js';
import { defaultSpritesClientFactory, type SpriteCommandLike, type SpriteLike, type SpritesClientFactory, type SpritesClientLike } from './sprites/spritesSdk.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunInspection, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export { SpritesRunInterruptedError } from './sprites/spritesExecution.js';
export { SpritesConfigurationError } from './sprites/spritesConfig.js';
export type { SpritesStartupTimings } from './sprites/spritesRunLifecycle.js';

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

export interface SpritesRuntimeDependencies {
    createClient?: SpritesClientFactory;
    config?: () => SpritesRuntimeConfig;
    setupBundle?: () => SpritesSetupBundle;
    environment?: NodeJS.ProcessEnv;
    reconnectDelayMs?: number;
    /** How long a stopped run's launcher gets to export credentials before its processes are killed (tests shorten it). */
    launcherSettleMs?: number;
    /** Bound on a stopped run's settlement when its termination cannot be confirmed (tests shorten it). */
    stopSettlementMs?: number;
}

/** Run id on the Sprite: derived from the (unique) run name, so a restarted worker finds it again. */
export function spritesRunId(spec: Pick<AgentRunSpec, 'name'>): string {
    const id = spec.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 96).replace(/-+$/, '');
    return id || 'run';
}

const CLONED_LINE = 'ProPR workspace transport: cloned';
const SESSION_HEADROOM_MS = 10 * 60_000;

class SpritesRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly cancellation = new AbortController();
    private readonly result: Promise<ExecutionResult>;
    readonly timings: SpritesStartupTimings = {};
    private readonly paths: SpritesRunPaths;
    private lease?: SpriteRunLease;
    /** The run's credential copy: materialized once the run holds its Sprite, finished after the run. */
    private credentials?: SpritesCredentialSync;
    private started = false;
    private settled = false;
    private retainedCredentials = false;
    /** The launcher's credential export was not confirmed: the live copies on the Sprite are the ones to recover. */
    private liveCredentialsRetained = false;
    /** The Sprite must stay out of the pool: its retained credentials have no persisted recovery marker, or the run's processes could not be stopped. */
    private holdSprite = false;
    private retained = false;
    /** The launch's acquisition and preparation, settled; cleanup waits for it so it never races work still running on the Sprite. */
    private preparation: Promise<void> = Promise.resolve();
    private preparationSettled = true;
    /** The one cleanup of this run's Sprite, followed by freeing its slot. */
    private cleanup?: Promise<void>;
    private released?: Promise<void>;
    private releaseTimer?: NodeJS.Timeout;

    constructor(
        readonly spec: AgentRunSpec,
        options: AgentRunOptions,
        private readonly runtime: SpritesRuntime,
        attach?: { lease: SpriteRunLease },
    ) {
        this.paths = spritesRunPaths(spritesRunId(spec));
        const ownership = getExecutionOwnershipContext()?.signal;
        const signal = AbortSignal.any([this.cancellation.signal, ...(options.signal ? [options.signal] : []), ...(ownership ? [ownership] : [])]);
        this.result = attach ? this.reattach(options, signal, attach.lease) : this.launch(options, signal);
        const settle = (): void => {
            this.settled = true;
            this.output.end();
            if (!this.released && !this.cleanup && !this.retained) {
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
        // The deadline covers the whole run: queueing for a Sprite, first-time setup and preparation count against it.
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(new SpritesStartDeadlineError(this.spec.name, timeoutMs)), timeoutMs);
        deadlineTimer.unref();
        const startup = AbortSignal.any([signal, deadline.signal]);
        try {
            const config = this.runtime.config();
            const argv = renderSpritesArgv(this.spec);
            const plan = planSpritesMounts(this.spec);
            const admitted = admitCostExecution('sprites', [], { costCapExempt: options.costCapExempt, agentRun: { spec: this.spec } });
            const refusal = admitted ? await admitted : null;
            if (refusal) return refuseCostExecution(refusal, options.preserveOutputOnTimeout ?? false);
            const launchEnvironment = { ...process.env, ...options.extraEnvVars };
            const environment = resolveSpritesEnvironment(this.spec, launchEnvironment);
            const preparation = this.prepare(config, startup, { argv, environment, plan, extraEnvVars: options.extraEnvVars, stdinData: options.stdinData });
            this.preparationSettled = false;
            // Registered before the race below, so a failed preparation is known as settled when the race sees it.
            const settle = () => { this.preparationSettled = true; };
            this.preparation = preparation.then(settle, settle);
            try {
                await untilAborted(preparation, startup);
                // An expired or cancelled run never reaches the Sprite.
                startup.throwIfAborted();
            } catch (error) {
                const cleanup = this.cleanUp();
                // Abandoned preparation still owns the Sprite: cleanup (and freeing the slot) follows it, but the run settles now.
                if (this.preparationSettled) await cleanup;
                if (signal.aborted) throw this.cancellation.signal.aborted ? new AgentRunStoppedError(this.spec.name) : error;
                if (deadline.signal.aborted) {
                    logger.warn({ run: this.spec.name, sprite: this.lease?.name, timeoutMs, timings: this.timings }, 'Sprites run reached its deadline before it started');
                    return startDeadlineResult(timeoutMs, options.preserveOutputOnTimeout ?? false);
                }
                throw error;
            }
        } finally {
            clearTimeout(deadlineTimer);
        }
        const { sprite } = this.lease!;
        const sessionStarted = Date.now();
        const command = sprite.createSession('sudo', ['-n', '/bin/bash', this.paths.launcher, this.paths.root], {
            cwd: '/', maxRunAfterDisconnect: `${Math.ceil((timeoutMs + SESSION_HEADROOM_MS) / 1000)}s`,
        });
        this.started = true;
        try {
            return await this.supervise({ options, signal, session: command, remainingMs: timeoutMs - (Date.now() - requested), sessionStarted, requested });
        } finally {
            await this.finishCredentials();
        }
    }

    /** Acquires a Sprite and prepares it for the run, stopping at the next step once `signal` aborts. */
    private async prepare(config: SpritesRuntimeConfig, signal: AbortSignal, run: Omit<Parameters<SpritesRunHandle['uploadRun']>[1], 'credentials'> & { extraEnvVars?: Record<string, string> }): Promise<void> {
        const client = await this.runtime.client();
        signal.throwIfAborted();
        this.lease = await this.runtime.acquire(client, config, signal, this.timings);
        signal.throwIfAborted();
        const wakeStarted = Date.now();
        const { lease, provisioning, replaced } = await provisionLeasedSprite({ client, config, bundle: this.runtime.setupBundle() }, this.lease, signal);
        this.lease = lease;
        if (replaced) this.timings.created = true;
        Object.assign(this.timings, { ...(provisioning.setupMs !== undefined ? { setupMs: provisioning.setupMs } : {}), ...(provisioning.restoreMs !== undefined ? { restoreMs: provisioning.restoreMs } : {}) });
        this.timings.wakeMs = (this.timings.wakeMs ?? 0) + Math.max(0, Date.now() - wakeStarted - (provisioning.setupMs ?? 0) - (provisioning.restoreMs ?? 0));
        signal.throwIfAborted();
        const uploadStarted = Date.now();
        // Read from the canonical stores only now that the run holds its Sprite: a copy taken before
        // queueing would go stale while another run on the same account refreshes the token.
        this.credentials = prepareSpritesCredentials(this.spec, run.plan, { launchEnvironment: run.extraEnvVars, environment: this.runtime.environment });
        for (const [name, value] of Object.entries(this.credentials?.secretEnv ?? {})) run.environment.set(name, value);
        await this.uploadRun(this.lease.sprite, { ...run, credentials: this.credentials });
        this.timings.credentialSyncMs = Date.now() - uploadStarted;
    }

    private async reattach(options: AgentRunOptions, signal: AbortSignal, lease: SpriteRunLease): Promise<ExecutionResult> {
        this.lease = lease;
        this.started = true;
        const plan = planSpritesMounts(this.spec);
        try {
            this.credentials = prepareSpritesCredentials(this.spec, plan, { launchEnvironment: options.extraEnvVars, environment: this.runtime.environment });
            // What the run received, as persisted at launch (the canonical store may have moved on since).
            // When it cannot be recovered, the write-back keeps the returned tokens for recovery instead.
            await this.credentials?.recoverBaseline(lease.sprite.filesystem(), this.paths);
            return await this.supervise({ options, signal, remainingMs: options.timeout ?? 300_000, sessionStarted: Date.now(), requested: Date.now() });
        } finally {
            await this.finishCredentials();
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
            reconnectDelayMs: this.runtime.reconnectDelayMs, stopSettlementMs: this.runtime.stopSettlementMs,
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
        // Durable before the credentials reach the Sprite and cleared only after their write-back: a worker that stops mid-run leaves the Sprite quarantined.
        if (credentials && !await persistRecoveryObligation(sprite, paths, this.spec.name, { reason: 'pending-write-back' })) throw new Error(`Could not record the credential recovery marker of run ${this.spec.name} on Sprite ${sprite.name}`);
        await credentials?.upload(filesystem, paths);
        const records = spritesPurgeRecords(plan);
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

    private async finishCredentials(): Promise<void> {
        if (!this.credentials || !this.lease) return;
        const outcome = await finishRunCredentials(this.lease.sprite, this.paths, this.spec.name, { credentials: this.credentials, settleMs: this.runtime.launcherSettleMs });
        ({ retained: this.retainedCredentials, liveCopiesRetained: this.liveCredentialsRetained } = outcome);
        this.holdSprite ||= outcome.holdSprite;
        if (outcome.writeBackMs !== undefined) this.timings.credentialWriteBackMs = outcome.writeBackMs;
    }

    /**
     * Leaves nothing of the run at rest on the Sprite: restores the clean
     * checkpoint (which also spares the next run its restore), or, without
     * one, removes the run directory and everything the run left outside it.
     */
    private async cleanSprite(): Promise<void> {
        if (!this.lease) return;
        const { sprite, name } = this.lease;
        // A run directory (this run's or another's) holding the only copy of a rotated token must survive.
        const quarantined = this.retainedCredentials || await spriteHoldsRetainedCredentials(sprite, this.spec.name);
        if (!quarantined && this.runtime.config().restoreCheckpoint) {
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
        // As root (the clone workspace, the workspace result and Antigravity's disposable HOME are root-owned), with the run's log, scratch and tmpfs directories.
        const leftovers = spritesRunLeftovers(this.spec, { keepLiveCredentials: this.liveCredentialsRetained });
        await Promise.resolve()
            .then(() => sprite.execFile('sudo', ['-n', 'bash', '-c', SPRITES_SCRUB_SCRIPT, 'propr-scrub', ...leftovers], { timeout: 120_000 }))
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

    /**
     * Cancels a launch still preparing; a started run gets its session stopped. Resolves once the run settled: within
     * {@link SPRITES_STOP_SETTLEMENT_MS} plus its credential export, as interrupted when its termination is unconfirmed.
     */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 10_000): Promise<void> {
        if (this.settled) return;
        // The launcher always gets TERM first (KILL after its grace period), whatever signal was asked for.
        logger.info({ run: this.spec.name, sprite: this.lease?.name, signal }, 'Stopping Sprites run');
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        const settlementMs = this.runtime.stopSettlementMs ?? SPRITES_STOP_SETTLEMENT_MS;
        if (!await this.settlesWithin(timeoutMs + settlementMs + 60_000)) throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
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
        if (!this.settled || this.cleanup || !this.lease) return null;
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
     * Stops the run, restores the Sprite to its clean checkpoint (or removes
     * everything the run left, keeping only a run directory with unreturned
     * credentials) and frees the Sprite for the next run.
     */
    release(): Promise<void> {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.released ??= (async () => {
            if (!this.settled) {
                const still = (error: unknown) => logger.warn({ run: this.spec.name, sprite: this.lease?.name, error: (error as Error).message }, 'Sprites run is still settling after its stop; cleaning up its Sprite once it settled');
                await this.stop().catch(still);
                // Cleanup never races the run's own credential export: it follows the run's settlement.
                await this.result.then(() => undefined, () => undefined);
            }
            await this.cleanUp();
        })();
        return this.released;
    }

    /**
     * The run's only cleanup of its Sprite, and the only place its slot is
     * freed: after any preparation still running, after every process of the
     * run is verifiably gone, and after the Sprite was cleaned. Until then no
     * other run can acquire the Sprite, and nothing of this run touches it afterwards.
     */
    private cleanUp(): Promise<void> {
        this.cleanup ??= (async () => {
            await this.preparation;
            const lease = this.lease;
            if (!lease) return;
            // Credentials uploaded for a run that never started were never installed: nothing to recover.
            if (!this.started) await clearRecoveryObligation(lease.sprite, this.paths, this.spec.name);
            if (this.started && !await terminateRunProcesses(lease.sprite, this.paths)) {
                logger.error({ run: this.spec.name, sprite: lease.name }, 'Could not verify that the Sprites run stopped; this worker keeps the Sprite out of use until it restarts');
                return;
            }
            await this.cleanSprite();
            if (this.holdSprite) return;
            lease.release();
        })();
        return this.cleanup;
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
    readonly launcherSettleMs?: number;
    readonly stopSettlementMs?: number;

    constructor(private readonly dependencies: SpritesRuntimeDependencies = {}) {
        this.environment = dependencies.environment ?? process.env;
        ({ reconnectDelayMs: this.reconnectDelayMs, launcherSettleMs: this.launcherSettleMs, stopSettlementMs: this.stopSettlementMs } = dependencies);
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

    acquire(client: SpritesClientLike, config: SpritesRuntimeConfig, signal: AbortSignal, timings: SpritesStartupTimings): Promise<SpriteRunLease> {
        return acquireSprite({ pool: this.pool, client, config }, signal, timings);
    }

    unsupportedMount(mount: Parameters<NonNullable<AgentRuntime['unsupportedMount']>>[0]): string | undefined {
        return spritesMountRefusal(mount);
    }

    /** A CLI version other than the one this setup revision pins cannot run on a Sprite. */
    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec): string | undefined {
        return spritesCliVersionRefusal({ ...config, type: config?.type ?? spec.profile.agentType }, this.setupBundle().pins);
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
