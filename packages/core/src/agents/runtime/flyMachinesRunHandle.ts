import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer } from '../impl/utils/boundedProviderOutput.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionAbortError, getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { settleTimeoutStop } from '../../claude/docker/dockerExecutionSettlement.js';
import { startLiveOutputStreaming } from '../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine, type SessionLineInspectionContext } from '../../claude/docker/dockerSessionOutput.js';
import { resolveAgentRunNetworkPolicy } from '../../network/egressExecution.js';
import logger from '../../utils/logger.js';
import { AgentRunStoppedError, LazyOutputStreams, UNRELEASED_RUN_REMOVAL_MS, type AgentRunOptions } from './dockerRuntime.js';
import { flyMachineExitCode, type FlyMachine, type FlyMachinesClient, type FlyRequestOptions } from './flyMachinesApi.js';
import { FlyMachineCreation } from './flyMachinesCreation.js';
import { confinedCredentialPath, readConfinedMachineFile, readMachineFile, type ExecRead } from './flyMachinesFileRead.js';
import type { FlyMachinesConfig } from './flyMachinesConfig.js';
import { assertFlyNetworkUnrestricted, flyForcedStopCommand, FLY_RUN_FILES, renderFlyMachineRequest } from './flyMachinesLaunch.js';
import { FlyLogStream, pause, pollInterrupt, type PollInterrupt } from './flyMachinesLogStream.js';
import type { AgentRunHandle, AgentRunInspection, AgentRunSpec } from './types.js';

/** How long a Machine create → `started` may take: image pull plus boot. */
const START_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const STOPPED_RUN_SETTLE_MS = 5_000;
/** After a forced kill the launcher drains the output pipes (up to 5 s) before it records the exit status. */
const FORCED_STOP_SETTLE_MS = 15_000;
/**
 * A clone transport wrapper outlives a forced stop of its agent to snapshot
 * the workspace and publish it (push, else a bundle) before the launcher
 * records the exit status; it gets this long before the Machine is destroyed.
 */
const CLONE_FINALIZE_SETTLE_MS = 3 * 60_000;
/** A Machine the handle must destroy (cancelled, or not confirmed stopped) is retried this often, backing off to 10 min. */
const DESTROY_RETRY_MS = 30_000;
const MAX_DESTROY_RETRY_MS = 10 * 60_000;
/** The launcher writes the exit status as a short decimal line. */
const MAX_EXIT_STATUS_BYTES = 64;
/** A run's output is read back from the Machine at most this far from its end (the result keeps 1 MiB of records). */
const MAX_CAPTURE_READ_BYTES = 8 * 1024 * 1024;
/** Exit status / Machine state checks happen every this many log polls. */
const STATUS_CHECK_EVERY_POLLS = 5;

export interface FlyRunTiming {
    /** Create request until the API returned the Machine. */
    createMs?: number;
    /** Create request until the Machine reached `started`: the image pull (cold or cached) plus boot. */
    coldStartMs?: number;
}

export interface FlyRunDependencies {
    client: FlyMachinesClient;
    config: FlyMachinesConfig;
    pollIntervalMs: number;
    now: () => number;
}

function signalNumber(signal: NodeJS.Signals): number {
    return osConstants.signals[signal] ?? osConstants.signals.SIGTERM;
}

/**
 * One run on an ephemeral Fly Machine. The Machine is created when the handle
 * is, streams its output through the logs API while it runs, and stays (the
 * launcher lingers) after the agent exits until the handle has read the exact
 * output and `release()` destroys it. Unreleased Machines are destroyed after
 * {@link UNRELEASED_RUN_REMOVAL_MS}, and destroy themselves at the end of the
 * configured linger unless `retain()` marked them kept.
 *
 * The run settles only once its agent is known to have stopped: it exited
 * (exit status), its Machine ended, or a destroy request succeeded. A Machine
 * the handle has to destroy (a cancelled run, or one whose termination could
 * not be confirmed) keeps being destroyed until a request succeeds, and so
 * does one a failed create may have left ({@link FlyMachineCreation}).
 */
export class FlyMachineRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly cancellation = new AbortController();
    private readonly result: Promise<ExecutionResult>;
    private machineId?: string;
    /** The agent's exit status once known (null: the Machine ended without reporting one). */
    private exitCode?: number | null;
    /** The Machine is confirmed ended or destroyed: no result files to read, nothing left running. */
    private machineGone = false;
    /** The handle decided to destroy the Machine (cancelled, or its termination not confirmed): nothing is read from it. */
    private discarding = false;
    private destroyRetryMs = DESTROY_RETRY_MS;
    /** The retain marker being written (true once it is in the Machine); cleared after a failure so a later retain() retries. */
    private retaining?: Promise<boolean>;
    /** `release()` was called: the Machine must be destroyed, retained or not, and failed destroys are retried. */
    private releaseRequested = false;
    private settled = false;
    private released?: Promise<void>;
    private releaseTimer?: NodeJS.Timeout;
    private retained = false;
    private readonly logs: FlyLogStream;
    private readonly creation: FlyMachineCreation;
    private readonly messageTimestamps = new Map<string, string>();
    readonly timing: FlyRunTiming = {};

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions, private readonly deps: FlyRunDependencies) {
        this.logs = new FlyLogStream(deps.client, spec.name, {
            output: (stream, text) => this.output.write(stream, text),
            exit: code => { this.exitCode ??= code; },
        });
        this.creation = new FlyMachineCreation(deps.client, spec.name, deps.now);
        const ownership = getExecutionOwnershipContext()?.signal;
        const signals = [this.cancellation.signal, options.signal, ownership].filter((signal): signal is AbortSignal => !!signal);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        this.result = this.run(options, signal);
        const settle = (): void => {
            this.settled = true;
            this.output.end();
            if (this.released) return;
            // A create whose response was lost may have left a Machine: it is looked for and destroyed.
            if (this.creation.unresolved) this.scheduleRelease(this.destroyRetryMs);
            if (!this.machineId || this.machineGone) return;
            if (this.discarding) this.scheduleRelease(this.destroyRetryMs);
            else if (!this.retained) this.scheduleRelease(UNRELEASED_RUN_REMOVAL_MS);
        };
        this.result.then(settle, settle);
    }

    get stdout(): Readable { return this.output.get('stdout'); }
    get stderr(): Readable { return this.output.get('stderr'); }
    /** The Machine's id once it was created. */
    get id(): string | undefined { return this.machineId; }

    wait(): Promise<ExecutionResult> {
        return this.result;
    }

    private async run(options: AgentRunOptions, signal: AbortSignal): Promise<ExecutionResult> {
        const { config, now } = this.deps;
        const timeoutMs = options.timeout ?? 300_000;
        const startedAt = now();
        const deadline = startedAt + timeoutMs;
        // A Machine cannot confine egress. Refused before one exists, also when the runtime is used directly:
        // a restricted spec, and an open one launched under a restricted policy (the run's network policy
        // scope, else the enforced instance policy; an exemption lifts only that one, as at dispatch).
        assertFlyNetworkUnrestricted(this.spec);
        assertFlyNetworkUnrestricted(this.spec, await resolveAgentRunNetworkPolicy(options.networkPolicyExempt));
        const request = renderFlyMachineRequest(this.spec, {
            config, launchEnvironment: { ...process.env, ...options.extraEnvVars }, stdinData: options.stdinData, creationId: this.creation.id,
        });
        this.throwIfAborted(signal);
        // Never aborted: a create the API completes after an abort would leave a Machine no one destroys. One
        // that fails without a definitive answer leaves an obligation to find and destroy its Machine.
        const machine = await this.creation.create(request);
        this.machineId = machine.id;
        this.timing.createMs = now() - startedAt;
        let live: ReturnType<typeof startLiveOutputStreaming> | undefined;
        try {
            if (signal.aborted) {
                await this.discardMachine('cancelled');
                this.throwIfAborted(signal);
            }
            live = startLiveOutputStreaming({
                ...options, onOverflow: error => logger.warn({ run: this.spec.name, error: error.message }, 'Live output unavailable; continuing agent execution'),
            }, () => this.logs.stdout.output, () => this.logs.stderr.value);
            return await this.execute(machine, options, signal, { startedAt, deadline, timeoutMs, live });
        } catch (error) {
            // Never settle while the agent may still be running: destroy a Machine whose agent was not seen to
            // stop. One whose destroy already failed is retried by the cleanup timer the settlement schedules.
            if (this.exitCode === undefined && !this.machineGone && !this.discarding) await this.discardMachine('failed');
            throw error;
        } finally {
            live?.close();
        }
    }

    private async execute(
        machine: FlyMachine, options: AgentRunOptions, signal: AbortSignal,
        run: { startedAt: number; deadline: number; timeoutMs: number; live: ReturnType<typeof startLiveOutputStreaming> },
    ): Promise<ExecutionResult> {
        const { now } = this.deps;
        const { startedAt, deadline, timeoutMs, live } = run;
        const sessionContext: SessionLineInspectionContext = {
            messageTimestamps: this.messageTimestamps, state: { sessionIdDetected: false }, onSessionId: options.onSessionId,
            invokeExecutionCallback: callback => { void Promise.resolve().then(callback).catch(error => logger.warn({ run: this.spec.name, error: (error as Error).message }, 'Agent run callback failed')); },
        };
        if (options.onContainerId) sessionContext.invokeExecutionCallback(() => options.onContainerId!(machine.id, this.spec.name));
        await this.awaitStarted(machine, signal, Math.min(deadline, startedAt + START_TIMEOUT_MS));
        if (!signal.aborted) {
            this.timing.coldStartMs = now() - startedAt;
            logger.info({ run: this.spec.name, machine: machine.id, region: machine.region, ...this.timing }, 'Fly Machine started for agent run');
        }
        let timedOut = false;
        for (let poll = 0; this.exitCode === undefined; poll++) {
            if (signal.aborted) break;
            if (now() >= deadline) { timedOut = true; break; }
            const interrupt = pollInterrupt(signal, deadline, now, this.deps.pollIntervalMs);
            try {
                await this.pollLogs(sessionContext, live, interrupt);
                // At the deadline too: the timeout stop checks the status again before it escalates.
                if (this.exitCode === undefined && !interrupt.signal.aborted && poll % STATUS_CHECK_EVERY_POLLS === STATUS_CHECK_EVERY_POLLS - 1) await this.checkStatus(interrupt.signal);
            } finally {
                interrupt.dispose();
            }
            if (this.exitCode === undefined) await pause(this.deps.pollIntervalMs, signal);
        }
        if (timedOut && !signal.aborted) await this.stopAfterTimeout(sessionContext, live, signal);
        // Cancelled while running, or while the timeout stop waited for the agent: the Machine is destroyed.
        if (signal.aborted) {
            await this.discardMachine('cancelled');
            this.throwIfAborted(signal);
        }
        const result = await this.collect(sessionContext);
        if (!timedOut) return result;
        return await new Promise<ExecutionResult>((resolve, reject) => settleTimeoutStop(timeoutMs, result, options.preserveOutputOnTimeout ?? false, { resolve, reject }));
    }

    private throwIfAborted(signal: AbortSignal): void {
        const aborted = getExecutionAbortError(signal);
        if (aborted) throw aborted;
    }

    /**
     * Destroy the Machine because the run is being given up. It counts as gone
     * only once a destroy request succeeded (a missing Machine counts); after a
     * failure it stays eligible for cleanup, which retries the destroy.
     */
    private async discardMachine(reason: 'cancelled' | 'failed' | 'timed-out'): Promise<void> {
        this.discarding = true;
        if (!this.machineId || this.machineGone) return;
        try {
            await this.deps.client.destroyMachine(this.machineId);
            this.machineGone = true;
        } catch (error) {
            logger.warn({ run: this.spec.name, machine: this.machineId, error: (error as Error).message }, `Could not destroy the Fly Machine of a ${reason} run; retrying`);
        }
    }

    private scheduleRelease(ms: number): void {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = setTimeout(() => {
            this.releaseTimer = undefined;
            // A failed destroy schedules its own retry (see destroy()).
            void this.destroy().catch(() => undefined);
        }, ms);
        this.releaseTimer.unref();
    }

    private async awaitStarted(machine: FlyMachine, signal: AbortSignal, deadline: number): Promise<void> {
        const { client, now } = this.deps;
        if (machine.state === 'started') return;
        while (!signal.aborted) {
            const remainingSeconds = Math.ceil((deadline - now()) / 1000);
            if (remainingSeconds <= 0) throw new Error(`Fly Machine ${machine.id} for ${this.spec.name} did not start in time (image pull and boot)`);
            // Both requests give way to a cancellation, which destroys the Machine instead.
            const reached = await client.waitForState(machine.id, 'started', Math.min(60, remainingSeconds), { instanceId: machine.instance_id, signal }).catch(() => false);
            if (reached || signal.aborted) return;
            let current: FlyMachine | null;
            try {
                current = await client.getMachine(machine.id, { signal });
            } catch (error) {
                if (signal.aborted) return;
                throw error;
            }
            if (current?.state === 'started') return;
            if (!current || ['stopped', 'destroyed', 'destroying', 'failed'].includes(current.state ?? '')) {
                // It ran and ended before we saw it start (e.g. the launcher could not run): report what Fly recorded.
                this.machineGone = true;
                this.exitCode = flyMachineExitCode(current);
                return;
            }
        }
    }

    private pollLogs(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>, interrupt: PollInterrupt): Promise<void> {
        return this.machineId ? this.logs.poll(this.machineId, context, live, interrupt) : Promise.resolve();
    }

    /**
     * The exit status file (the launcher writes it before lingering), else
     * whether the Machine ended. `signal` aborts the check: the run's
     * cancellation (the Machine is destroyed instead) or, in the run loop, its
     * deadline. A stop window does not: this is the evidence its forced stop
     * or destroy is decided on. `stop()` checks without a signal: the check
     * decides whether it may cancel the run.
     */
    private async checkStatus(signal?: AbortSignal): Promise<void> {
        const status = await this.execRead(FLY_RUN_FILES.exitStatus, { limit: MAX_EXIT_STATUS_BYTES, signal }).catch(() => undefined);
        if (status && status !== 'oversized') {
            const code = Number(status.content.toString('utf8').trim());
            if (Number.isInteger(code)) { this.exitCode ??= code; return; }
        }
        if (signal?.aborted) return;
        const machine = await this.deps.client.getMachine(this.machineId!, { signal }).catch(() => undefined);
        if (machine === undefined) return;
        if (!machine || !['started', 'starting', 'created', 'replacing'].includes(machine.state ?? '')) {
            this.machineGone = true;
            this.exitCode ??= flyMachineExitCode(machine);
        }
    }

    /**
     * Deadline: TERM the agent (the launcher forwards it, never to a clone
     * transport wrapper, which outlives its agent and keeps finalizing) and
     * give it the stop window; then KILL it ({@link flyForcedStopCommand}),
     * so the launcher records the exit and the Machine keeps the partial
     * output and result files. A clone transport wrapper is spared and given
     * time to snapshot and publish the workspace first, also when it already
     * was finalizing at the deadline. Failing that, destroy the Machine.
     * Throws when none of these is confirmed: the run must not settle while
     * its agent may still be running. Returns early when the run is cancelled
     * meanwhile: the caller then destroys the Machine.
     */
    private async stopAfterTimeout(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>, signal: AbortSignal): Promise<void> {
        await this.deps.client.signal(this.machineId!, signalNumber('SIGTERM'), { signal }).catch(() => undefined);
        await this.awaitExit(context, live, DEFAULT_STOP_TIMEOUT_MS, signal);
        if (this.exitCode !== undefined || signal.aborted) return;
        const clone = Boolean(this.spec.workspace.clone?.resultDir);
        const killed = await this.deps.client.exec(this.machineId!, flyForcedStopCommand(this.spec), 30, { signal })
            .catch(error => ({ exit_code: -1, stdout: '', stderr: (error as Error).message }));
        if (signal.aborted) return;
        if (killed.exit_code !== 0) logger.warn({ run: this.spec.name, machine: this.machineId, error: killed.stderr.trim() || `exit ${killed.exit_code}` }, 'Could not kill the timed-out agent in its Fly Machine; destroying the Machine');
        else await this.awaitExit(context, live, clone ? CLONE_FINALIZE_SETTLE_MS : FORCED_STOP_SETTLE_MS, signal);
        if (this.exitCode !== undefined || signal.aborted) return;
        await this.discardMachine('timed-out');
        if (!this.machineGone) throw new Error(`Agent run ${this.spec.name} timed out and its Fly Machine ${this.machineId} could not be stopped`);
        // Destroyed: the streamed output is all that is left of it.
        this.exitCode = null;
    }

    /**
     * Polls until the agent's exit is known, the window ends or the run is
     * cancelled. Log polling ends with the window; the status check after it
     * still runs, so the exit status is looked for before the caller escalates.
     */
    private async awaitExit(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>, windowMs: number, signal: AbortSignal): Promise<void> {
        const until = this.deps.now() + windowMs;
        while (this.exitCode === undefined && !signal.aborted && this.deps.now() < until) {
            await pause(this.deps.pollIntervalMs, signal);
            const interrupt = pollInterrupt(signal, until, this.deps.now, this.deps.pollIntervalMs);
            try {
                await this.pollLogs(context, live, interrupt);
            } finally {
                interrupt.dispose();
            }
            if (this.exitCode === undefined && !signal.aborted) await this.checkStatus(signal);
        }
    }

    /** The exact output from the Machine's capture files, falling back to what the logs streamed. */
    private async collect(context: SessionLineInspectionContext): Promise<ExecutionResult> {
        let stdout = this.logs.stdout.output;
        let stderr = this.logs.stderr.value;
        if (!this.machineGone && this.machineId) {
            const [capturedRead, capturedErrRead] = await Promise.all([
                this.execRead(FLY_RUN_FILES.stdout, { tail: MAX_CAPTURE_READ_BYTES }).catch(() => undefined),
                this.execRead(FLY_RUN_FILES.stderr, { tail: MAX_CAPTURE_READ_BYTES }).catch(() => undefined),
            ]);
            const captured = capturedRead && capturedRead !== 'oversized' ? capturedRead.content : undefined;
            const capturedErr = capturedErrRead && capturedErrRead !== 'oversized' ? capturedErrRead.content : undefined;
            if (captured) {
                const buffer = new BoundedProviderRecordBuffer();
                buffer.append(captured.toString('utf8'));
                stdout = buffer.output;
                const timestamp = new Date().toISOString();
                // Records the logs missed still get a timestamp; streamed ones keep theirs.
                const missing: SessionLineInspectionContext = { ...context, messageTimestamps: new Map() };
                for (const line of stdout.split('\n')) inspectSessionMessageLine(line, timestamp, missing);
                for (const [id, at] of missing.messageTimestamps) if (!this.messageTimestamps.has(id)) this.messageTimestamps.set(id, at);
            }
            if (capturedErr) {
                const tail = new BoundedDiagnosticTail();
                tail.append(capturedErr.toString('utf8'));
                stderr = tail.value;
            }
        }
        return { stdout, stderr, exitCode: this.exitCode ?? null, messageTimestamps: this.messageTimestamps };
    }

    private execRead(filePath: string, bounds: FlyRequestOptions & { tail?: number; limit?: number } = {}): Promise<ExecRead> {
        return readMachineFile(this.deps.client, this.machineId!, filePath, bounds);
    }

    private async settlesWithin(ms: number): Promise<boolean> {
        if (this.settled) return true;
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
        try {
            return await Promise.race([this.result.then(() => true, () => true), expired]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * A started agent gets `signal` (forwarded by the launcher, which spares
     * a clone transport wrapper) and settles with its exit status. An agent
     * that already exited (its exit status recorded, also when the run has
     * not seen it yet) is never cancelled: `stop()` waits for the run to
     * collect its result from the Machine. A launch still creating its
     * Machine, or an agent that does not exit within `timeoutMs`, is
     * cancelled: its Machine is destroyed and `wait()` rejects with
     * {@link AgentRunStoppedError}.
     */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
        if (this.settled) return;
        if (this.machineId && this.exitCode === undefined) {
            try {
                await this.deps.client.signal(this.machineId, signalNumber(signal));
                if (await this.settlesWithin(timeoutMs + STOPPED_RUN_SETTLE_MS)) return;
            } catch (error) {
                logger.warn({ run: this.spec.name, machine: this.machineId, error: (error as Error).message }, 'Could not signal the Fly Machine; cancelling the run');
            }
            // Not settled is not "still running": the run may only be waiting on a logs page. The recorded
            // exit status (or the Machine's end) decides, before a cancellation destroys the Machine.
            if (this.exitCode === undefined && !this.settled && !this.discarding && !this.cancellation.signal.aborted) await this.checkStatus();
        }
        // The agent exited: the run is collecting its output and result from the Machine. It settles once its
        // pending requests (each bounded by its request timeout) answer; cancelling it would destroy the
        // completed workspace and the refreshed credentials.
        if (this.exitCode !== undefined && !this.discarding && !this.cancellation.signal.aborted) { await this.result.catch(() => undefined); return; }
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        if (!await this.settlesWithin(timeoutMs + STOPPED_RUN_SETTLE_MS)) throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
    }

    async inspect(): Promise<AgentRunInspection> {
        const name = this.spec.name;
        if (!this.machineId) return { liveness: 'not_found', name };
        let machine: FlyMachine | null;
        try {
            machine = await this.deps.client.getMachine(this.machineId);
        } catch {
            return { liveness: 'unavailable', id: this.machineId, name };
        }
        if (!machine || machine.state === 'destroyed' || machine.state === 'destroying') return { liveness: 'not_found', id: this.machineId, name };
        const running = ['started', 'starting', 'created', 'replacing'].includes(machine.state ?? '') && this.exitCode === undefined;
        return { liveness: running ? 'running' : 'stopped', id: this.machineId, name };
    }

    async isAlive(): Promise<boolean> {
        return (await this.inspect()).liveness === 'running';
    }

    /** A file the finished run left, read from its lingering Machine. */
    async readFile(filePath: string): Promise<Buffer | null> {
        const read = await this.readFileWithStat(filePath, {});
        return read && read !== 'oversized' ? read.content : null;
    }

    async readFileWithStat(filePath: string, options: { maxBytes?: number }): Promise<ExecRead> {
        if (!this.readable()) return null;
        await this.retaining;
        if (!this.readable()) return null;
        return this.execRead(filePath, { limit: options.maxBytes });
    }

    async readCredentialFile(root: string, relative: string, options: { maxBytes: number }): Promise<ExecRead> {
        const target = confinedCredentialPath(root, relative, options.maxBytes);
        if (!this.readable()) return null;
        await this.retaining;
        if (!this.readable()) return null;
        const read = await readConfinedMachineFile(this.deps.client, this.machineId!, target, options.maxBytes);
        if (read === 'refused') {
            logger.warn({ run: this.spec.name, machine: this.machineId, store: root, file: relative }, 'Refusing a credential output that is a symlink, leads through one, or is not a regular file');
            return null;
        }
        return read;
    }

    private readable(): boolean {
        return this.settled && !this.released && !this.machineGone && !this.discarding && !!this.machineId;
    }

    /**
     * Keeps the Machine until `release()`: cancels the worker's removal timer
     * and marks the run retained inside the Machine, so the launcher does not
     * exit (and auto-destroy the Machine) when its linger ends. Reads wait for
     * the mark, so a caller retrieving a result after `retain()` does so from
     * a Machine that stays.
     *
     * Resolves true once the mark is in the Machine, false when it could not
     * be written (the Machine is gone, being discarded, or the exec failed):
     * then the Machine still destroys itself when its linger ends. A later
     * call retries a failed mark. Never rejects.
     */
    retain(): Promise<boolean> {
        this.retained = true;
        if (this.releaseTimer && !this.discarding && !this.releaseRequested) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = undefined;
        }
        if (!this.machineId || this.machineGone || this.discarding) return Promise.resolve(false);
        this.retaining ??= this.markRetained().then(marked => {
            if (!marked) this.retaining = undefined;
            return marked;
        });
        return this.retaining;
    }

    private async markRetained(): Promise<boolean> {
        let failure = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const marked = await this.deps.client.exec(this.machineId!, ['/bin/sh', '-c', ': > "$1"', 'sh', FLY_RUN_FILES.retain], 30);
                if (marked.exit_code === 0) return true;
                failure = marked.stderr.trim() || `exit ${marked.exit_code}`;
            } catch (error) {
                failure = (error as Error).message;
            }
            if (this.machineGone || this.released) break;
            if (attempt < 3) await pause(Math.min(this.deps.pollIntervalMs * attempt, 5_000));
        }
        logger.error({ run: this.spec.name, machine: this.machineId, error: failure }, 'Could not mark the Fly Machine retained; it destroys itself when its result linger ends');
        return false;
    }

    /**
     * Destroys the Machine, retained or not. Idempotent once it succeeded. A
     * failed destroy rejects and is retried with backoff (10 min at most)
     * until one succeeds; a later call retries it at once.
     */
    release(): Promise<void> {
        this.releaseRequested = true;
        return this.destroy();
    }

    private destroy(): Promise<void> {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
        this.released ??= (async () => {
            if (!this.settled) {
                await this.stop().catch(() => undefined);
                // stop() gives up after its settle window, but a create request still in flight (up to 2 min)
                // may yet return a Machine: only a settled run says whether one exists and is still to destroy.
                await this.result.catch(() => undefined);
            }
            // Rejects while a Machine of a create whose response was lost cannot be ruled out: retried below.
            await this.creation.reconcile();
            if (this.machineId && !this.machineGone) {
                await this.deps.client.destroyMachine(this.machineId);
                this.machineGone = true;
            }
        })().catch(error => {
            this.released = undefined;
            // An automatic removal that lost the race with retain() leaves the Machine to its holder.
            if (this.releaseRequested || this.discarding || !this.retained || this.creation.unresolved) {
                logger.warn({ run: this.spec.name, machine: this.machineId, error: (error as Error).message }, 'Could not destroy the Fly Machine of an agent run; retrying');
                this.destroyRetryMs = Math.min(this.destroyRetryMs * 2, MAX_DESTROY_RETRY_MS);
                if (!this.releaseTimer) this.scheduleRelease(this.destroyRetryMs);
            }
            throw error;
        });
        return this.released;
    }
}
