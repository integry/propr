import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, boundedProviderOutput } from '../../impl/utils/boundedProviderOutput.js';
import { refuseCostExecution, registerCostExecution, settleCostCapStop } from '../../../claude/docker/dockerCostCap.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import { ExecutionAbortedError, getExecutionAbortError } from '../../../claude/docker/dockerExecutionOwnership.js';
import { startExecutionWatchdog } from '../../../claude/docker/dockerExecutionWatchdog.js';
import { startLiveOutputStreaming } from '../../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine } from '../../../claude/docker/dockerSessionOutput.js';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import logger from '../../../utils/logger.js';
import type { AgentRunOptions } from '../dockerRuntime.js';
import type { AgentRunSpec } from '../types.js';
import { SPRITES_FOLLOW_NO_LAUNCHER_EXIT, SPRITES_FOLLOW_SCRIPT, SPRITES_SIGNAL_SCRIPT, type SpritesRunPaths } from './spritesCommand.js';
import type { SpriteCommandLike, SpriteLike, SpritesClientLike } from './spritesSdk.js';

/**
 * Supervises one agent run on a Sprite. The launcher runs in a detachable
 * session (it survives the worker's connection); its stdout and stderr are
 * followed through two plain execs of `tail --pid` that resume from the bytes
 * already received after a dropped connection. Output feeds the executor's
 * capture (session IDs, live log, spend cap, watchdog). The supervisor keeps
 * the Sprite awake, enforces the deadline and cancellation, and fails clearly
 * (never hangs) when the Sprite went cold under the run.
 */

/** Sprite states in which no process survives. */
const STOPPED_SPRITE_STATES = new Set(['cold', 'paused', 'suspended', 'stopped', 'sleeping', 'destroyed', 'deleted']);
export const SPRITES_RECONNECT_ATTEMPTS = 5;
export const SPRITES_RECONNECT_DELAY_MS = 2_000;
const STOP_GRACE_MS = 10_000;
const KEEP_AWAKE_TIMEOUT_MS = 20_000;
const SIGNAL_TIMEOUT_MS = 30_000;
const EXIT_STATUS_SETTLE_ATTEMPTS = 5;

/** The run ended without an exit status because its Sprite paused, restarted or lost the launcher. */
export class SpritesRunInterruptedError extends Error {
    readonly code = 'SPRITES_RUN_INTERRUPTED';
    constructor(message: string) {
        super(message);
        this.name = 'SpritesRunInterruptedError';
    }
}

type StreamName = 'stdout' | 'stderr';
type StopCause = 'timeout' | 'abort' | 'watchdog' | 'cost' | 'interrupted' | 'callback';

export interface SpriteSessionSupervision {
    spec: AgentRunSpec;
    options: AgentRunOptions;
    client: SpritesClientLike;
    sprite: SpriteLike;
    paths: SpritesRunPaths;
    /** The launched session; absent when reattaching to a run another process started. */
    session?: SpriteCommandLike;
    signal: AbortSignal;
    remainingMs: number;
    keepAwakeIntervalMs: number;
    reconnectDelayMs?: number;
    onOutput(stream: StreamName, chunk: string): void;
    /** Called once the launcher is running (or found running). */
    onStarted?(): void;
}

function waitSpawned(command: SpriteCommandLike): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSpawn = () => { command.off('error', onError); resolve(); };
        const onError = (error: Error) => { command.off('spawn', onSpawn); reject(error); };
        command.once('spawn', onSpawn);
        command.once('error', onError);
    });
}

export async function spriteIsStopped(client: SpritesClientLike, name: string): Promise<string | undefined> {
    try {
        const status = (await client.getSprite(name)).status?.trim().toLowerCase();
        return status && STOPPED_SPRITE_STATES.has(status) ? status : undefined;
    } catch {
        return undefined;
    }
}

export async function findRunSession(sprite: SpriteLike, paths: SpritesRunPaths): Promise<string | undefined> {
    const sessions = await sprite.listSessions();
    return sessions.find(session => session.isActive !== false && session.command.includes(paths.root))?.id;
}

function isMissing(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'ENOENT' || /not found|no such file/i.test((error as Error | null)?.message ?? '');
}

export async function readRecordedExitStatus(sprite: SpriteLike, paths: SpritesRunPaths): Promise<number | undefined> {
    try {
        const recorded = (await sprite.filesystem().readFile(paths.exitStatus, null)).toString('utf8').trim();
        return /^\d+$/.test(recorded) ? Number(recorded) : undefined;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

/** Whether the run's launcher process is alive. */
export async function launcherIsRunning(sprite: SpriteLike, paths: SpritesRunPaths): Promise<boolean> {
    const probe = await sprite.execFile('sudo', ['-n', 'bash', '-c', 'pid="$(cat "$1" 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid"', 'propr-probe', paths.pid], { timeout: SIGNAL_TIMEOUT_MS })
        .catch(error => ({ exitCode: (error as { exitCode?: number }).exitCode ?? 1 }));
    return probe.exitCode === 0;
}

/** TERM goes to the launcher (forwarded to the run's session); KILL kills the run's whole process boundary. */
export function signalLauncher(sprite: SpriteLike, paths: SpritesRunPaths, signal: 'TERM' | 'KILL') {
    return sprite.execFile('sudo', ['-n', 'bash', '-c', SPRITES_SIGNAL_SCRIPT, 'propr-signal', signal, paths.root], { timeout: SIGNAL_TIMEOUT_MS });
}

/**
 * Kills every process of the run and its launcher, and resolves true only once
 * none of them is left: a Sprite is not reused while the run could still act on it.
 */
export async function terminateRunProcesses(sprite: SpriteLike, paths: SpritesRunPaths, attempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const result = await signalLauncher(sprite, paths, 'KILL');
            if (result.exitCode === 0) return true;
            logger.warn({ sprite: sprite.name, run: paths.root, attempt, stderr: String(result.stderr).trim() }, 'Processes of the Sprites run survived SIGKILL');
        } catch (error) {
            logger.warn({ sprite: sprite.name, run: paths.root, attempt, error: (error as Error).message }, 'Could not stop the processes of the Sprites run');
        }
    }
    return false;
}

/** How long a stopped run's launcher gets to finish (forwarding TERM, then exporting credentials) before its processes are killed. */
export const SPRITES_LAUNCHER_SETTLE_MS = STOP_GRACE_MS;
const LAUNCHER_SETTLE_POLL_MS = 250;

async function recordedExitStatus(sprite: SpriteLike, paths: SpritesRunPaths): Promise<number | undefined> {
    return readRecordedExitStatus(sprite, paths).catch(() => undefined);
}

/**
 * Resolves true once the launcher recorded its exit status, which it does only
 * after it returned the refreshable credentials and the workspace result: only
 * then does a missing returned file mean the run refreshed nothing. Supervision
 * can end before that (its output followers gave up while the launcher was
 * still handling TERM), so this waits for the launcher; after `graceMs` it kills
 * the run's processes (the launcher then exports and finishes) and checks once
 * more. Resolves false when the export cannot be confirmed: the launcher is
 * gone without a status (the Sprite paused) or did not finish, or the Sprite
 * cannot be reached.
 */
export async function settleLauncher(sprite: SpriteLike, paths: SpritesRunPaths, graceMs = SPRITES_LAUNCHER_SETTLE_MS): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    let killed = false;
    for (;;) {
        if (await recordedExitStatus(sprite, paths) !== undefined) return true;
        // The launcher may have recorded its status between both checks.
        if (!await launcherIsRunning(sprite, paths)) return await recordedExitStatus(sprite, paths) !== undefined;
        if (Date.now() >= deadline) {
            if (killed) return false;
            killed = true;
            // Kills the run's processes, then waits a few seconds for the launcher to finish.
            await signalLauncher(sprite, paths, 'KILL').catch(() => undefined);
            continue;
        }
        await delay(Math.min(LAUNCHER_SETTLE_POLL_MS, Math.max(1, deadline - Date.now())));
    }
}

// eslint-disable-next-line complexity -- one run's streaming, stop, reconnect and settlement share its state
export async function superviseSpriteSession(input: SpriteSessionSupervision): Promise<ExecutionResult> {
    const { spec, options, sprite, client, paths } = input;
    const timeoutMs = options.timeout ?? 300_000;
    const preserveOutput = options.preserveOutputOnTimeout ?? false;
    const reconnectDelayMs = input.reconnectDelayMs ?? SPRITES_RECONNECT_DELAY_MS;
    // Written from callbacks and timers, so kept in one object.
    const run: { stopCause: StopCause | null; interruption: Error | null; costMessage: string | null; callbackFailure?: { error: unknown } } = {
        stopCause: null, interruption: null, costMessage: null,
    };
    const followers = new Set<SpriteCommandLike>();
    const timers: NodeJS.Timeout[] = [];
    const requestStop = (cause: StopCause): void => {
        if (run.stopCause) return;
        run.stopCause = cause;
        void signalLauncher(sprite, paths, 'TERM').catch(error => {
            logger.warn({ run: spec.name, sprite: sprite.name, error: (error as Error).message }, 'Could not stop the Sprites run');
        });
        const force = setTimeout(() => { void signalLauncher(sprite, paths, 'KILL').catch(() => undefined); }, STOP_GRACE_MS);
        force.unref();
        timers.push(force);
    };
    const cost = registerCostExecution('sprites', [], { model: options.model, costCapExempt: options.costCapExempt, agentRun: { spec } }, message => {
        run.costMessage ??= message;
        requestStop('cost');
    });
    if ('refusal' in cost) return refuseCostExecution(cost.refusal, preserveOutput);
    const stdoutBuffer = new BoundedProviderRecordBuffer();
    const stderrTail = new BoundedDiagnosticTail();
    const messageTimestamps = new Map<string, string>();
    const sessionState = { sessionIdDetected: false };
    const pendingCallbacks = new Set<Promise<void>>();
    const received: Record<StreamName, number> = { stdout: 0, stderr: 0 };
    const decoders: Record<StreamName, StringDecoder> = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let lineBuffer = '';

    const invokeExecutionCallback = (callback: () => void | Promise<void>): void => {
        const promise = Promise.resolve().then(callback).catch(error => {
            run.callbackFailure ??= { error };
            requestStop('callback');
        });
        pendingCallbacks.add(promise);
        void promise.finally(() => pendingCallbacks.delete(promise));
    };
    const watchdog = startExecutionWatchdog(options, () => {
        if (run.stopCause) return false;
        requestStop('watchdog');
        return true;
    });
    const liveOutput = startLiveOutputStreaming({
        ...options,
        onOverflow: error => logger.warn({ error: error.message, taskId: options.taskId }, 'Live output unavailable; continuing agent execution'),
        onActivity: () => watchdog.recordActivity(),
        onTranscriptRecord: watchdog.observeLine,
    }, () => stdoutBuffer.output, () => stderrTail.value);
    const inspectLines = (chunk: string, flush = false): void => {
        const timestamp = new Date().toISOString();
        lineBuffer = boundedProviderOutput(lineBuffer + chunk);
        const lines = lineBuffer.split('\n');
        const remainder = lines.pop() ?? '';
        lineBuffer = flush ? '' : remainder;
        if (flush && remainder) lines.push(remainder);
        for (const line of lines) {
            inspectSessionMessageLine(line, timestamp, { messageTimestamps, state: sessionState, onSessionId: options.onSessionId, invokeExecutionCallback });
            cost.execution?.observeLine(line);
            watchdog.observeLine(line);
        }
    };
    const emit = (stream: StreamName, chunk: string): void => {
        if (!chunk) return;
        watchdog.recordActivity();
        if (stream === 'stdout') { stdoutBuffer.append(chunk); liveOutput?.stdout(chunk); inspectLines(chunk); }
        else { stderrTail.append(chunk); liveOutput?.stderr(chunk); }
        input.onOutput(stream, chunk);
    };
    const stoppedError = (status: string) => new SpritesRunInterruptedError(
        `Sprite ${sprite.name} went ${status} during agent run ${spec.name}; the agent process did not survive the pause. Rerun the task`,
    );
    const interrupt = (error: Error): void => {
        if (run.interruption) return;
        run.interruption = error;
        requestStop('interrupted');
        for (const follower of followers) follower.close();
    };

    /** Follow one log until the launcher exits; resumes from `received` after a dropped connection. */
    const follow = async (stream: StreamName): Promise<'done' | 'no-launcher' | 'lost'> => {
        const log = stream === 'stdout' ? paths.stdoutLog : paths.stderrLog;
        for (let attempt = 0; ; attempt++) {
            if (run.interruption) return 'lost';
            const command = sprite.spawn('bash', ['-c', SPRITES_FOLLOW_SCRIPT, 'propr-follow', String(received[stream] + 1), paths.pid, log], {});
            followers.add(command);
            command.stdout.on('data', (data: Buffer | string) => {
                const bytes = Buffer.from(data);
                received[stream] += bytes.length;
                emit(stream, decoders[stream].write(bytes));
            });
            command.stderr.resume();
            command.on('error', (error: Error) => logger.debug({ run: spec.name, stream, error: error.message }, 'Sprites output follower connection error'));
            let code = -1;
            try {
                await waitSpawned(command);
                code = await command.wait();
            } catch (error) {
                logger.warn({ run: spec.name, sprite: sprite.name, stream, attempt, error: (error as Error).message }, 'Could not follow the Sprites run output');
            } finally {
                followers.delete(command);
            }
            if (code === 0) return 'done';
            if (code === SPRITES_FOLLOW_NO_LAUNCHER_EXIT) return 'no-launcher';
            if (run.interruption) return 'lost';
            const status = await spriteIsStopped(client, sprite.name);
            if (status) { interrupt(stoppedError(status)); return 'lost'; }
            if (attempt + 1 >= SPRITES_RECONNECT_ATTEMPTS) {
                interrupt(new SpritesRunInterruptedError(`Lost the output of agent run ${spec.name} on Sprite ${sprite.name} and could not reconnect after ${SPRITES_RECONNECT_ATTEMPTS} attempts`));
                return 'lost';
            }
            logger.warn({ run: spec.name, sprite: sprite.name, stream, attempt, exitCode: code, receivedBytes: received[stream] }, 'Sprites run output connection dropped; reconnecting');
            await delay(reconnectDelayMs);
        }
    };

    const onAbort = () => requestStop('abort');
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => requestStop('timeout'), Math.max(0, input.remainingMs));
    deadline.unref();
    timers.push(deadline);
    // An open exec keeps a Sprite awake; the renewal also notices a Sprite that paused anyway.
    let renewing = false;
    const keepAwake = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void sprite.execFile('true', [], { timeout: KEEP_AWAKE_TIMEOUT_MS })
            .catch(async error => {
                const status = await spriteIsStopped(client, sprite.name);
                logger.warn({ run: spec.name, sprite: sprite.name, status, error: (error as Error).message }, 'Sprite keep-awake renewal failed');
                if (status) interrupt(stoppedError(status));
            })
            .finally(() => { renewing = false; });
    }, input.keepAwakeIntervalMs);
    keepAwake.unref();

    let exitCode: number | undefined;
    try {
        if (input.session) {
            // The session's own (TTY) stream carries nothing the run needs; drain it so it never buffers.
            input.session.stdout.resume();
            input.session.stderr.resume();
            input.session.on('error', (error: Error) => logger.debug({ run: spec.name, error: error.message }, 'Sprite session connection error'));
            await waitSpawned(input.session);
            input.session.stdin.end();
        }
        input.onStarted?.();
        const outcomes = await Promise.all([follow('stdout'), follow('stderr')]);
        if (!run.interruption) {
            for (let attempt = 0; exitCode === undefined && attempt < EXIT_STATUS_SETTLE_ATTEMPTS; attempt++) {
                exitCode = await readRecordedExitStatus(sprite, paths);
                if (exitCode === undefined) await delay(Math.min(500, reconnectDelayMs));
            }
            if (exitCode === undefined) {
                const status = await spriteIsStopped(client, sprite.name);
                interrupt(status ? stoppedError(status) : new SpritesRunInterruptedError(outcomes.includes('no-launcher')
                    ? `The launcher of agent run ${spec.name} did not start on Sprite ${sprite.name} (passwordless sudo and the ProPR setup are required)`
                    : `Agent run ${spec.name} on Sprite ${sprite.name} ended without an exit status (the Sprite restarted or was restored under it)`));
            }
        }
    } finally {
        for (const timer of timers) clearTimeout(timer);
        clearInterval(keepAwake);
        input.signal.removeEventListener('abort', onAbort);
        watchdog.stop();
        input.session?.close();
    }
    emit('stdout', decoders.stdout.end());
    emit('stderr', decoders.stderr.end());
    inspectLines('', true);
    const finalCost = await cost.execution?.finish().catch(() => null);
    if (finalCost && !run.costMessage && !run.stopCause) run.costMessage = finalCost;
    await Promise.allSettled([...pendingCallbacks]);
    await watchdog.settled();
    try { await liveOutput?.close(); } catch (error) { logger.warn({ error: (error as Error).message, taskId: options.taskId }, 'Failed to publish final live output'); }

    const result: ExecutionResult = { exitCode: exitCode ?? null, stdout: stdoutBuffer.output, stderr: stderrTail.value, messageTimestamps };
    if (run.callbackFailure) throw run.callbackFailure.error;
    if (run.stopCause === 'abort') throw getExecutionAbortError(input.signal) ?? new ExecutionAbortedError();
    if (run.interruption) throw run.interruption;
    const { costMessage, stopCause } = run;
    return new Promise<ExecutionResult>((resolve, reject) => {
        if (costMessage) settleCostCapStop(costMessage, result, { preserveOutput, resolve, reject });
        else if (watchdog.trip) settleWatchdogStop(watchdog.trip, result, preserveOutput, { resolve, reject });
        else if (stopCause === 'timeout') settleTimeoutStop(timeoutMs, result, preserveOutput, { resolve, reject });
        else resolve(result);
    });
}
