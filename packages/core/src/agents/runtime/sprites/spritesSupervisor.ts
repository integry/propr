import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { refuseCostExecution, registerCostExecution, settleCostCapStop } from '../../../claude/docker/dockerCostCap.js';
import { ExecutionAbortedError, getExecutionAbortError } from '../../../claude/docker/dockerExecutionOwnership.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import { startExecutionWatchdog } from '../../../claude/docker/dockerExecutionWatchdog.js';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { startLiveOutputStreaming } from '../../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine } from '../../../claude/docker/dockerSessionOutput.js';
import logger from '../../../utils/logger.js';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, boundedProviderOutput } from '../../impl/utils/boundedProviderOutput.js';
import type { AgentRunOptions } from '../dockerRuntime.js';
import type { AgentRunSpec } from '../types.js';
import { execOnSprite, type SpriteCommandLike, type SpriteLike } from './spritesSdk.js';
import { SPRITES_LAUNCHER } from './spritesSetup.js';

/**
 * Supervises one agent run on a Sprite. The launcher runs in a detachable
 * session (it survives the worker's connection); its stdout and stderr logs
 * are followed through two plain execs that resume from the bytes already
 * received after a dropped connection. Output feeds the executor's capture
 * (session IDs, live log, spend cap, watchdog). The supervisor enforces the
 * deadline and cancellation and never waits forever for a Sprite that paused
 * or lost the run.
 */

export const SPRITES_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_STOP_GRACE_MS = 10_000;
const CONTROL_TIMEOUT_MS = 60_000;
const SESSION_HEADROOM_MS = 10 * 60_000;
const FOLLOW_NO_LAUNCHER_EXIT = 3;

/** The run ended without an exit status: its Sprite paused or restarted, or its output was lost. */
export class SpritesRunInterruptedError extends Error {
    readonly code = 'SPRITES_RUN_INTERRUPTED';
    constructor(message: string) {
        super(message);
        this.name = 'SpritesRunInterruptedError';
    }
}

type StreamName = 'stdout' | 'stderr';
type StopCause = 'timeout' | 'abort' | 'watchdog' | 'cost' | 'interrupted' | 'callback';
export type SpritesExportState = 'ok' | 'unsafe' | 'none';

export interface SpritesRunSupervision {
    spec: AgentRunSpec;
    options: AgentRunOptions;
    sprite: SpriteLike;
    signal: AbortSignal;
    /** What is left of the run's deadline (queueing and preparation counted against it). */
    remainingMs: number;
    reconnectDelayMs?: number;
    stopGraceMs?: number;
    onOutput(stream: StreamName, chunk: string): void;
    onStarted?(): void;
}

export interface SpritesRunSupervised {
    /** Whether the launcher was started on the Sprite (false: refused before launch, nothing ran there). */
    launched: boolean;
    /** The launcher's recorded exit status; undefined when it recorded none. */
    exitCode?: number;
    /** `ok`: the launcher exported the refreshable credentials after every agent process was gone. */
    exportState?: SpritesExportState;
    /** Whether the launcher and every process of the run are known to be gone. When false the Sprite is destroyed, not restored. */
    terminated: boolean;
    /** The run's outcome as the executor reports it: resolves with the result, or rejects (cancelled, interrupted). */
    settle(): Promise<ExecutionResult>;
}

export function launcherCommand(...args: string[]): [string, string[]] {
    return ['sudo', ['-n', '/bin/bash', SPRITES_LAUNCHER, ...args]];
}

function waitSpawned(command: SpriteCommandLike): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSpawn = () => { command.off('error', onError); resolve(); };
        const onError = (error: Error) => { command.off('spawn', onSpawn); reject(error); };
        command.once('spawn', onSpawn);
        command.once('error', onError);
    });
}

/** `signal KILL` exits 0 only when the launcher and every process of the agent user are gone. */
export async function killSpritesRun(sprite: SpriteLike): Promise<boolean> {
    try {
        return (await execOnSprite(sprite, ...launcherCommand('signal', 'KILL'), { timeout: CONTROL_TIMEOUT_MS })).exitCode === 0;
    } catch {
        return false;
    }
}

async function readRunStatus(sprite: SpriteLike): Promise<{ running: boolean; exitCode?: number; exportState?: SpritesExportState }> {
    const result = await execOnSprite(sprite, ...launcherCommand('status'), { timeout: CONTROL_TIMEOUT_MS });
    const field = (name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(result.stdout)?.[1]?.trim() ?? '';
    const exit = field('exit');
    const exported = field('export');
    return {
        running: field('running') !== '0',
        ...(/^\d+$/.test(exit) ? { exitCode: Number(exit) } : {}),
        ...(exported === 'ok' || exported === 'unsafe' || exported === 'none' ? { exportState: exported } : {}),
    };
}

// eslint-disable-next-line complexity -- one run's streaming, stop, reconnect and settlement share its state
export async function superviseSpritesRun(input: SpritesRunSupervision): Promise<SpritesRunSupervised> {
    const { spec, options, sprite } = input;
    const timeoutMs = options.timeout ?? 300_000;
    const preserveOutput = options.preserveOutputOnTimeout ?? false;
    const reconnectDelayMs = input.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const stopGraceMs = input.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    // Written from callbacks and timers, so kept in one object.
    const run: { stopCause: StopCause | null; interruption: Error | null; costMessage: string | null; callbackFailure?: { error: unknown }; killed?: Promise<boolean> } = {
        stopCause: null, interruption: null, costMessage: null,
    };
    const followers = new Set<SpriteCommandLike>();
    const timers: NodeJS.Timeout[] = [];
    // Resolved when the run stops following its launcher: every pending connection wait ends then.
    let abandonFollowing!: () => void;
    const followingAbandoned = new Promise<void>(resolve => { abandonFollowing = resolve; });
    const untilAbandoned = <T>(promise: Promise<T>, abandoned: T): Promise<T> => Promise.race([promise, followingAbandoned.then(() => abandoned)]);
    const interrupt = (error: Error): void => {
        if (run.interruption) return;
        run.interruption = error;
        requestStop('interrupted');
        for (const follower of followers) follower.close();
        abandonFollowing();
    };
    const kill = (): Promise<boolean> => run.killed ??= killSpritesRun(sprite);
    function requestStop(cause: StopCause): void {
        if (run.stopCause) return;
        run.stopCause = cause;
        void execOnSprite(sprite, ...launcherCommand('signal', 'TERM'), { timeout: CONTROL_TIMEOUT_MS })
            .catch(error => logger.warn({ run: spec.name, sprite: sprite.name, error: (error as Error).message }, 'Could not signal the Sprites run'));
        // TERM lets the clone wrapper return the workspace; after the grace period everything is killed.
        const force = setTimeout(() => { void kill(); }, stopGraceMs);
        // The followers end when the launcher exits; nothing confirms that it will, so the wait is bounded.
        const settlement = setTimeout(() => interrupt(new SpritesRunInterruptedError(
            `Agent run ${spec.name} on Sprite ${sprite.name} did not stop within ${stopGraceMs + CONTROL_TIMEOUT_MS}ms of its ${cause} stop request`,
        )), stopGraceMs + CONTROL_TIMEOUT_MS);
        timers.push(force, settlement);
    }

    const cost = registerCostExecution('sprites', [], { model: options.model, costCapExempt: options.costCapExempt, agentRun: { spec } }, message => {
        run.costMessage ??= message;
        requestStop('cost');
    });
    if ('refusal' in cost) return { launched: false, terminated: true, settle: () => refuseCostExecution(cost.refusal, preserveOutput) };
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

    /** Follow one log until the launcher exits; resumes from `received` after a dropped connection. */
    const follow = async (stream: StreamName): Promise<'done' | 'no-launcher' | 'lost'> => {
        for (let failures = 0; ;) {
            if (run.interruption) return 'lost';
            const before = received[stream];
            const command = sprite.spawn(...launcherCommand('follow', stream, String(received[stream] + 1)), {});
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
                if (await untilAbandoned(waitSpawned(command).then(() => true), false)) code = await untilAbandoned(command.wait(), -1);
            } catch (error) {
                logger.warn({ run: spec.name, sprite: sprite.name, stream, error: (error as Error).message }, 'Could not follow the Sprites run output');
            } finally {
                followers.delete(command);
            }
            if (code === 0) return 'done';
            if (code === FOLLOW_NO_LAUNCHER_EXIT) return 'no-launcher';
            if (run.interruption) return 'lost';
            // A connection that delivered output was a working one: only consecutive failures count.
            failures = received[stream] > before ? 1 : failures + 1;
            if (failures >= SPRITES_RECONNECT_ATTEMPTS) {
                interrupt(new SpritesRunInterruptedError(`Lost the output of agent run ${spec.name} on Sprite ${sprite.name} and could not reconnect after ${SPRITES_RECONNECT_ATTEMPTS} attempts`));
                return 'lost';
            }
            logger.warn({ run: spec.name, sprite: sprite.name, stream, exitCode: code, receivedBytes: received[stream] }, 'Sprites run output connection dropped; reconnecting');
            await delay(reconnectDelayMs);
        }
    };

    const onAbort = () => requestStop('abort');
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
    // Not unref'd: a run in progress keeps its worker alive, as a container's child process does.
    timers.push(setTimeout(() => requestStop('timeout'), Math.max(0, input.remainingMs)));

    let exitCode: number | undefined;
    let exportState: SpritesExportState | undefined;
    let terminated = false;
    const session = sprite.createSession(...launcherCommand('run'), {
        cwd: '/', maxRunAfterDisconnect: `${Math.ceil((timeoutMs + SESSION_HEADROOM_MS) / 1000)}s`,
    });
    try {
        // The session's own (TTY) stream carries nothing the run needs; drain it so it never buffers.
        session.stdout.resume();
        session.stderr.resume();
        session.on('error', (error: Error) => logger.debug({ run: spec.name, error: error.message }, 'Sprite session connection error'));
        if (!await untilAbandoned(waitSpawned(session).then(() => true), false)) throw run.interruption ?? new SpritesRunInterruptedError(`The session of agent run ${spec.name} did not start`);
        session.stdin.end();
        input.onStarted?.();
        const outcomes = await Promise.all([follow('stdout'), follow('stderr')]);
        let status = await readRunStatus(sprite).catch(() => undefined);
        if (!status || status.running) {
            // Not known to be gone: kill everything, and take the status the launcher records once its command is dead.
            terminated = await kill();
            if (terminated) status = await readRunStatus(sprite).catch(() => undefined);
        }
        ({ exitCode, exportState } = status ?? {});
        terminated = !!status && !status.running && exitCode !== undefined;
        if (!run.interruption && exitCode === undefined) {
            interrupt(new SpritesRunInterruptedError(outcomes.includes('no-launcher')
                ? `The launcher of agent run ${spec.name} did not start on Sprite ${sprite.name} (passwordless sudo and the ProPR setup are required)`
                : `Agent run ${spec.name} on Sprite ${sprite.name} ended without an exit status (the Sprite paused or restarted under it)`));
        }
    } catch (error) {
        interrupt(error instanceof Error ? error : new Error(String(error)));
    } finally {
        for (const timer of timers) clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        watchdog.stop();
        session.close();
    }
    // Still not known to be gone: only a kill that reports no survivors lets the Sprite be restored instead of destroyed.
    if (!terminated) terminated = await (run.killed = killSpritesRun(sprite));
    emit('stdout', decoders.stdout.end());
    emit('stderr', decoders.stderr.end());
    inspectLines('', true);
    const finalCost = await cost.execution?.finish().catch(() => null);
    if (finalCost && !run.costMessage && !run.stopCause) run.costMessage = finalCost;
    await Promise.allSettled([...pendingCallbacks]);
    await watchdog.settled();
    try { await liveOutput?.close(); } catch (error) { logger.warn({ error: (error as Error).message, taskId: options.taskId }, 'Failed to publish final live output'); }

    const result: ExecutionResult = { exitCode: exitCode ?? null, stdout: stdoutBuffer.output, stderr: stderrTail.value, messageTimestamps };
    const settle = async (): Promise<ExecutionResult> => {
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
    };
    return { launched: true, ...(exitCode === undefined ? {} : { exitCode }), ...(exportState ? { exportState } : {}), terminated, settle };
}
