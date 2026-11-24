import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer } from '../impl/utils/boundedProviderOutput.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionAbortError, getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { settleTimeoutStop } from '../../claude/docker/dockerExecutionSettlement.js';
import { startLiveOutputStreaming } from '../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine, type SessionLineInspectionContext } from '../../claude/docker/dockerSessionOutput.js';
import logger from '../../utils/logger.js';
import { AgentRunStoppedError, LazyOutputStreams, UNRELEASED_RUN_REMOVAL_MS, type AgentRunOptions } from './dockerRuntime.js';
import { flyMachineExitCode, parseFlyStat, type FlyMachine, type FlyMachinesClient } from './flyMachinesApi.js';
import type { FlyMachinesConfig } from './flyMachinesConfig.js';
import { FLY_RUN_FILES, parseFlyLogLine, renderFlyMachineRequest } from './flyMachinesLaunch.js';
import type { AgentRunFileRead, AgentRunHandle, AgentRunInspection, AgentRunSpec } from './types.js';

/** How long a Machine create → `started` may take: image pull plus boot. */
const START_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const STOPPED_RUN_SETTLE_MS = 5_000;
/** After a forced kill the launcher drains the output pipes (up to 5 s) before it records the exit status. */
const FORCED_STOP_SETTLE_MS = 15_000;
/** A Machine the handle must destroy (cancelled, or not confirmed stopped) is retried this often, backing off to 10 min. */
const DESTROY_RETRY_MS = 30_000;
const MAX_DESTROY_RETRY_MS = 10 * 60_000;
/** The launcher writes the exit status as a short decimal line. */
const MAX_EXIT_STATUS_BYTES = 64;
/** A run's output is read back from the Machine at most this far from its end (the result keeps 1 MiB of records). */
const MAX_CAPTURE_READ_BYTES = 8 * 1024 * 1024;
const EXEC_READ_CHUNK_BYTES = 3 * 1024 * 1024;
/** Exit status / Machine state checks happen every this many log polls. */
const STATUS_CHECK_EVERY_POLLS = 5;

type ExecRead = AgentRunFileRead | 'oversized' | null;

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

/** Resolves after `ms`, or early when `signal` aborts (never rejects). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done(): void { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
    });
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
 * not be confirmed) keeps being destroyed until a request succeeds.
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
    private retaining?: Promise<void>;
    private settled = false;
    private released?: Promise<void>;
    private releaseTimer?: NodeJS.Timeout;
    private retained = false;
    private logToken?: string;
    private logWarned = false;
    private readonly liveStdout = new BoundedProviderRecordBuffer();
    private readonly liveStderr = new BoundedDiagnosticTail();
    private readonly messageTimestamps = new Map<string, string>();
    readonly timing: FlyRunTiming = {};

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions, private readonly deps: FlyRunDependencies) {
        const ownership = getExecutionOwnershipContext()?.signal;
        const signals = [this.cancellation.signal, options.signal, ownership].filter((signal): signal is AbortSignal => !!signal);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        this.result = this.run(options, signal);
        const settle = (): void => {
            this.settled = true;
            this.output.end();
            if (this.released || !this.machineId || this.machineGone) return;
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
        const { client, config, now } = this.deps;
        const timeoutMs = options.timeout ?? 300_000;
        const startedAt = now();
        const deadline = startedAt + timeoutMs;
        const request = renderFlyMachineRequest(this.spec, {
            config, launchEnvironment: { ...process.env, ...options.extraEnvVars }, stdinData: options.stdinData,
        });
        this.throwIfAborted(signal);
        const machine = await client.createMachine(request);
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
            }, () => this.liveStdout.output, () => this.liveStderr.value);
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
        this.timing.coldStartMs = now() - startedAt;
        logger.info({ run: this.spec.name, machine: machine.id, region: machine.region, ...this.timing }, 'Fly Machine started for agent run');
        let timedOut = false;
        for (let poll = 0; this.exitCode === undefined; poll++) {
            if (signal.aborted) break;
            if (now() >= deadline) { timedOut = true; break; }
            await this.pollLogs(sessionContext, live);
            if (this.exitCode === undefined && poll % STATUS_CHECK_EVERY_POLLS === STATUS_CHECK_EVERY_POLLS - 1) await this.checkStatus();
            if (this.exitCode === undefined) await pause(this.deps.pollIntervalMs, signal);
        }
        if (signal.aborted) {
            await this.discardMachine('cancelled');
            this.throwIfAborted(signal);
        }
        if (timedOut) await this.stopAfterTimeout(sessionContext, live);
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
            void this.release().catch(error => {
                logger.warn({ run: this.spec.name, machine: this.machineId, error: (error as Error).message }, 'Could not destroy the Fly Machine of an agent run; retrying');
                if (!this.discarding && this.retained) return;
                this.destroyRetryMs = Math.min(this.destroyRetryMs * 2, MAX_DESTROY_RETRY_MS);
                this.scheduleRelease(this.destroyRetryMs);
            });
        }, ms);
        this.releaseTimer.unref();
    }

    private async awaitStarted(machine: FlyMachine, signal: AbortSignal, deadline: number): Promise<void> {
        const { client, now } = this.deps;
        if (machine.state === 'started') return;
        while (!signal.aborted) {
            const remainingSeconds = Math.ceil((deadline - now()) / 1000);
            if (remainingSeconds <= 0) throw new Error(`Fly Machine ${machine.id} for ${this.spec.name} did not start in time (image pull and boot)`);
            const reached = await client.waitForState(machine.id, 'started', Math.min(60, remainingSeconds), machine.instance_id).catch(() => false);
            if (reached) return;
            const current = await client.getMachine(machine.id);
            if (current?.state === 'started') return;
            if (!current || ['stopped', 'destroyed', 'destroying', 'failed'].includes(current.state ?? '')) {
                // It ran and ended before we saw it start (e.g. the launcher could not run): report what Fly recorded.
                this.machineGone = true;
                this.exitCode = flyMachineExitCode(current);
                return;
            }
        }
    }

    private async pollLogs(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>): Promise<void> {
        if (!this.machineId) return;
        try {
            for (let pages = 0; pages < 20; pages++) {
                const page = await this.deps.client.logs(this.machineId, this.logToken);
                if (page.nextToken) this.logToken = page.nextToken;
                for (const line of page.lines) {
                    const parsed = parseFlyLogLine(line.message);
                    if (!parsed) continue;
                    if ('exitCode' in parsed) { this.exitCode ??= parsed.exitCode; continue; }
                    if (parsed.stream === 'stdout') {
                        this.liveStdout.append(parsed.text);
                        inspectSessionMessageLine(parsed.text, line.timestamp || new Date().toISOString(), context);
                        live?.stdout(parsed.text);
                    } else {
                        this.liveStderr.append(parsed.text);
                        live?.stderr(parsed.text);
                    }
                    this.output.write(parsed.stream, parsed.text);
                }
                if (page.lines.length === 0 || !page.nextToken) return;
            }
        } catch (error) {
            if (!this.logWarned) logger.warn({ run: this.spec.name, machine: this.machineId, error: (error as Error).message }, 'Fly logs unavailable; the run output is read from the Machine when it finishes');
            this.logWarned = true;
        }
    }

    /** The exit status file (the launcher writes it before lingering), else whether the Machine ended. */
    private async checkStatus(): Promise<void> {
        const status = await this.execRead(FLY_RUN_FILES.exitStatus, { limit: MAX_EXIT_STATUS_BYTES }).catch(() => undefined);
        if (status && status !== 'oversized') {
            const code = Number(status.content.toString('utf8').trim());
            if (Number.isInteger(code)) { this.exitCode ??= code; return; }
        }
        const machine = await this.deps.client.getMachine(this.machineId!).catch(() => undefined);
        if (machine === undefined) return;
        if (!machine || !['started', 'starting', 'created', 'replacing'].includes(machine.state ?? '')) {
            this.machineGone = true;
            this.exitCode ??= flyMachineExitCode(machine);
        }
    }

    /**
     * Deadline: TERM the agent (the launcher forwards it) and give it the stop
     * window; then KILL its whole process group, so the launcher records the
     * exit and the Machine keeps the partial output and result files; failing
     * that, destroy the Machine. Throws when none of these is confirmed: the
     * run must not settle while its agent may still be running.
     */
    private async stopAfterTimeout(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>): Promise<void> {
        await this.deps.client.signal(this.machineId!, signalNumber('SIGTERM')).catch(() => undefined);
        await this.awaitExit(context, live, DEFAULT_STOP_TIMEOUT_MS);
        if (this.exitCode !== undefined) return;
        const killed = await this.deps.client.exec(this.machineId!, [
            '/bin/sh', '-c', 'pid=$(cat "$1") && { kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid"; }', 'sh', FLY_RUN_FILES.pid,
        ], 30).catch(error => ({ exit_code: -1, stdout: '', stderr: (error as Error).message }));
        if (killed.exit_code !== 0) logger.warn({ run: this.spec.name, machine: this.machineId, error: killed.stderr.trim() || `exit ${killed.exit_code}` }, 'Could not kill the timed-out agent in its Fly Machine; destroying the Machine');
        else await this.awaitExit(context, live, FORCED_STOP_SETTLE_MS);
        if (this.exitCode !== undefined) return;
        await this.discardMachine('timed-out');
        if (!this.machineGone) throw new Error(`Agent run ${this.spec.name} timed out and its Fly Machine ${this.machineId} could not be stopped`);
        // Destroyed: the streamed output is all that is left of it.
        this.exitCode = null;
    }

    private async awaitExit(context: SessionLineInspectionContext, live: ReturnType<typeof startLiveOutputStreaming>, windowMs: number): Promise<void> {
        const until = this.deps.now() + windowMs;
        while (this.exitCode === undefined && this.deps.now() < until) {
            await pause(this.deps.pollIntervalMs);
            await this.pollLogs(context, live);
            if (this.exitCode === undefined) await this.checkStatus();
        }
    }

    /** The exact output from the Machine's capture files, falling back to what the logs streamed. */
    private async collect(context: SessionLineInspectionContext): Promise<ExecutionResult> {
        let stdout = this.liveStdout.output;
        let stderr = this.liveStderr.value;
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

    /**
     * A file from the Machine through the exec API (base64, in chunks), with
     * its modification time; null when it does not exist. `tail` reads only
     * the file's last bytes; a file larger than `limit` is refused right
     * after the stat, before any content is transferred.
     */
    private async execRead(filePath: string, bounds: { tail?: number; limit?: number } = {}): Promise<ExecRead> {
        const { client } = this.deps;
        const id = this.machineId!;
        const sized = await client.exec(id, ['/bin/sh', '-c', '[ -f "$1" ] || exit 3; stat -c "%s %Y %y" "$1"', 'sh', filePath], 30);
        if (sized.exit_code === 3) return null;
        const stat = parseFlyStat(sized.stdout);
        if (sized.exit_code !== 0 || !stat) throw new Error(`Could not stat ${filePath} in Fly Machine ${id}: ${sized.stderr.trim() || `exit ${sized.exit_code}`}`);
        const { size, mtimeMs } = stat;
        if (bounds.limit !== undefined && size > bounds.limit) return 'oversized';
        const chunks: Buffer[] = [];
        let total = 0;
        for (let offset = bounds.tail && size > bounds.tail ? size - bounds.tail : 0; offset < size; offset += EXEC_READ_CHUNK_BYTES) {
            const length = Math.min(EXEC_READ_CHUNK_BYTES, size - offset);
            const read = await client.exec(id, ['/bin/sh', '-c', 'tail -c +"$(($2 + 1))" "$1" | head -c "$3" | base64 | tr -d "\\n"', 'sh', filePath, String(offset), String(length)], 60);
            if (read.exit_code !== 0) throw new Error(`Could not read ${filePath} from Fly Machine ${id}: ${read.stderr.trim() || `exit ${read.exit_code}`}`);
            const chunk = Buffer.from(read.stdout.trim(), 'base64');
            total += chunk.length;
            // The file may have grown since the stat: never hold more than it reported.
            if (bounds.limit !== undefined && total > bounds.limit) return 'oversized';
            chunks.push(chunk);
        }
        return { content: Buffer.concat(chunks), mtimeMs };
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
     * A started agent gets `signal` (forwarded by the launcher) and settles
     * with its exit status. A launch still creating its Machine, or an agent
     * that does not exit within `timeoutMs`, is cancelled: its Machine is
     * destroyed and `wait()` rejects with {@link AgentRunStoppedError}.
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
        }
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        if (!await this.settlesWithin(timeoutMs + STOPPED_RUN_SETTLE_MS)) {
            throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
        }
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

    private readable(): boolean {
        return this.settled && !this.released && !this.machineGone && !this.discarding && !!this.machineId;
    }

    /**
     * Keeps the Machine until `release()`: cancels the worker's removal timer
     * and marks the run retained inside the Machine, so the launcher does not
     * exit (and auto-destroy the Machine) when its linger ends. Reads wait for
     * the mark, so a caller retrieving a result after `retain()` does so from
     * a Machine that stays.
     */
    retain(): void {
        this.retained = true;
        if (this.releaseTimer && !this.discarding) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = undefined;
        }
        if (!this.retaining && this.machineId && !this.machineGone && !this.discarding) this.retaining = this.markRetained();
    }

    private async markRetained(): Promise<void> {
        let failure = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const marked = await this.deps.client.exec(this.machineId!, ['/bin/sh', '-c', ': > "$1"', 'sh', FLY_RUN_FILES.retain], 30);
                if (marked.exit_code === 0) return;
                failure = marked.stderr.trim() || `exit ${marked.exit_code}`;
            } catch (error) {
                failure = (error as Error).message;
            }
            if (this.machineGone || this.released) return;
            await pause(Math.min(this.deps.pollIntervalMs * attempt, 5_000));
        }
        logger.error({ run: this.spec.name, machine: this.machineId, error: failure }, 'Could not mark the Fly Machine retained; it destroys itself when its result linger ends');
    }

    /** Destroys the Machine. Idempotent once it succeeded; a failed destroy leaves it eligible and is retried by the next call. */
    release(): Promise<void> {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
        this.released ??= (async () => {
            if (!this.settled) await this.stop().catch(() => undefined);
            if (this.machineId && !this.machineGone) {
                await this.deps.client.destroyMachine(this.machineId);
                this.machineGone = true;
            }
        })().catch(error => {
            this.released = undefined;
            throw error;
        });
        return this.released;
    }
}
