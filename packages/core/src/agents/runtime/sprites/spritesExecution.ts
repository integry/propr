import type { Sprite, SpriteCommand } from '@fly/sprites';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { settleCostCapStop } from '../../../claude/docker/dockerCostCap.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import { getExecutionOwnershipContext } from '../../../claude/docker/dockerExecutionOwnership.js';
import type { LazyOutputStreams } from '../dockerRuntime.js';
import { startRunPipeline, type RunPipeline } from '../runPipeline.js';
import { startupStep } from './spritesProvisioning.js';
import { spriteLauncher, type SpriteLaunch, type prepareSpriteRun } from './spritesRun.js';

function waitForConnection(command: SpriteCommand, signal: AbortSignal, pipeline: RunPipeline, onSpawn: () => void) {
    let force: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void;
    const stdout = (data: Buffer) => pipeline.write('stdout', data);
    const stderr = (data: Buffer) => pipeline.write('stderr', data);
    command.stdout.on('data', stdout);
    command.stderr.on('data', stderr);
    return new Promise<number>(resolve => {
        abort = () => {
            command.kill('SIGTERM');
            force = setTimeout(() => { command.kill('SIGKILL'); resolve(-1); }, 5000);
            force.unref();
        };
        command.once('spawn', () => { onSpawn(); command.stdin.end(); });
        command.on('error', () => resolve(-1));
        command.once('exit', resolve);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    }).finally(() => {
        clearTimeout(force);
        signal.removeEventListener('abort', abort);
        command.stdout.off('data', stdout);
        command.stderr.off('data', stderr);
        command.close();
    });
}

interface SpriteExecution {
    output: LazyOutputStreams;
    signal: AbortSignal;
    prepared: ReturnType<typeof prepareSpriteRun>;
    onSpawn: () => void;
}

export async function execute(sprite: Sprite, launch: SpriteLaunch, { output, signal, prepared, onSpawn }: SpriteExecution): Promise<ExecutionResult> {
    const { spec, options, token, inputPath } = launch;
    const stop = new AbortController();
    const cancellation = AbortSignal.any([stop.signal, signal]);
    let costMessage: string | undefined;
    const preserve = options.preserveOutputOnTimeout ?? false;
    const runOptions = { ...options, agentRun: { spec, onOutput: output.write.bind(output) } };
    const callbacks = new Set<Promise<void>>();
    let callbackError: unknown;
    const started = startRunPipeline(runOptions, {
        markerArgs: prepared.markerArgs, diagnosticArgs: prepared.markerArgs, environment: prepared.environment,
        attempt: getExecutionOwnershipContext()?.attemptGeneration, secrets: [token],
        stopForWatchdog: () => { if (cancellation.aborted) return false; stop.abort(); return true; },
        command: 'sprites', stopForCostCap: message => { costMessage = message; stop.abort(); },
        invokeExecutionCallback: cb => {
            const pending = Promise.resolve().then(cb).catch(error => { callbackError = error; stop.abort(); });
            callbacks.add(pending);
            void pending.finally(() => callbacks.delete(pending));
        },
    });
    if (started.refusal) return started.refusal;
    const { pipeline } = started;
    let exitCode: number | null = null;
    try {
        cancellation.throwIfAborted();
        // Keep the non-TTY streams separate for workflow reports. Only this launch
        // uses the inbox as its working directory on the exclusively leased Sprite.
        const cwd = '/opt/propr/inbox';
        const command = sprite.spawn('sudo', ['-n', 'unshare', '--mount', '--propagation', 'private', 'setpriv', '--no-new-privs', '/usr/bin/python3', '-I', spriteLauncher, 'launch', inputPath],
            { cwd, detachable: true, maxRunAfterDisconnect: '60s' });
        exitCode = await waitForConnection(command, cancellation, pipeline, onSpawn);
        if (exitCode < 0 && !cancellation.aborted) {
            const sessions = await startupStep(cancellation, () => sprite.listSessions());
            const matching = sessions.filter(session => session.workdir === cwd && !session.tty);
            if (matching.length === 1 && !cancellation.aborted) {
                // The SDK switches to the session endpoint when sessionId is set.
                const attached = sprite.spawn('', [], { sessionId: matching[0].id });
                exitCode = await waitForConnection(attached, cancellation, pipeline, onSpawn);
            }
            if (exitCode < 0 && !cancellation.aborted) throw new Error('Sprite execution disconnected before exit');
        }
    } catch (error) {
        if (!cancellation.aborted) throw error;
    } finally {
        pipeline.finishOutput();
        const finalCost = await pipeline.finishCost();
        costMessage ??= finalCost ?? undefined;
        await Promise.all(callbacks);
        await pipeline.watchdog.settled();
        await pipeline.closeLive();
    }
    if (callbackError) throw callbackError;
    const result = pipeline.result(exitCode);
    return new Promise((resolve, reject) => {
        if (costMessage) settleCostCapStop(costMessage, result, { preserveOutput: preserve, resolve, reject });
        else if (pipeline.watchdog.trip) settleWatchdogStop(pipeline.watchdog.trip, result, preserve, { resolve, reject });
        else if (signal.reason?.name === 'TimeoutError') settleTimeoutStop(options.timeout ?? 300_000, result, preserve, { resolve, reject });
        else if (signal.aborted) reject(signal.reason);
        else resolve(result);
    });
}
