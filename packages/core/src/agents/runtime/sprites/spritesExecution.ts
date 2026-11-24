import { ExtensionStreamRedactor } from '../../../extensions/extensionOutput.js';
import type { Sprite } from '@fly/sprites';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { registerCostExecution, refuseCostExecution, settleCostCapStop } from '../../../claude/docker/dockerCostCap.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import { startExecutionWatchdog } from '../../../claude/docker/dockerExecutionWatchdog.js';
import { startLiveOutputStreaming } from '../../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine } from '../../../claude/docker/dockerSessionOutput.js';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, boundedProviderOutput } from '../../impl/utils/boundedProviderOutput.js';
import type { LazyOutputStreams } from '../dockerRuntime.js';
import { spriteLauncher, type SpriteLaunch } from './spritesRun.js';

export async function execute(sprite: Sprite, { spec, options, token, inputPath }: SpriteLaunch, output: LazyOutputStreams, signal: AbortSignal): Promise<ExecutionResult> {
    const stop = new AbortController();
    const cancellation = AbortSignal.any([stop.signal, signal]);
    let costMessage: string | undefined;
    const preserve = options.preserveOutputOnTimeout ?? false;
    const cost = registerCostExecution('sprites', [], { ...options, agentRun: { spec } }, message => {
        costMessage = message;
        stop.abort();
    });
    if ('refusal' in cost) return refuseCostExecution(cost.refusal, preserve);
    const { execution } = cost;
    const stdout = new BoundedProviderRecordBuffer();
    const stderr = new BoundedDiagnosticTail();
    const messageTimestamps = new Map<string, string>();
    const watchdog = startExecutionWatchdog(options, () => { stop.abort(); return true; });
    const live = startLiveOutputStreaming({ ...options, onOverflow: () => {}, onActivity: () => watchdog.recordActivity() }, () => stdout.output, () => stderr.value);
    const state = { sessionIdDetected: false };
    const callbacks: Promise<void>[] = [];
    let callbackError: unknown;
    function inspect(line: string) {
        execution?.observeLine(line);
        watchdog.observeLine(line);
        inspectSessionMessageLine(line, new Date().toISOString(), { state, messageTimestamps, onSessionId: options.onSessionId,
            invokeExecutionCallback: cb => callbacks.push(Promise.resolve().then(cb).catch(error => { callbackError = error; stop.abort(); })) });
    }
    let pending = '';
    let exitCode: number | null = null;
    try {
        cancellation.throwIfAborted();
        const command = sprite.spawn('sudo', ['-n', 'setpriv', '--no-new-privs', '/usr/bin/python3', '-I', spriteLauncher, 'launch', inputPath], { cwd: '/' });
        const captureStdout = (chunk: string) => {
            stdout.append(chunk);
            output.write('stdout', chunk);
            live?.stdout(chunk);
            watchdog.recordActivity();
            const lines = (pending + chunk).split('\n');
            pending = boundedProviderOutput(lines.pop() ?? '');
            lines.forEach(inspect);
        };
        const captureStderr = (chunk: string) => {
            stderr.append(chunk);
            output.write('stderr', chunk);
            live?.stderr(chunk);
            watchdog.recordActivity();
        };
        for (const [stream, capture] of [[command.stdout, captureStdout], [command.stderr, captureStderr]] as const) {
            const redactor = new ExtensionStreamRedactor([token]);
            stream.setEncoding('utf8').on('data', (chunk: string) => capture(redactor.push(chunk)));
            stream.once('end', () => capture(redactor.finish()));
        }
        let force: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                abort = () => {
                    command.kill('SIGTERM');
                    force = setTimeout(() => {
                        command.kill('SIGKILL');
                        command.close();
                        resolve(-1);
                    }, 5000);
                    force.unref();
                };
                command.once('spawn', () => command.stdin.end());
                command.on('error', () => reject(new Error('Sprite execution connection failed')));
                command.once('exit', resolve);
                if (cancellation.aborted) abort();
                else cancellation.addEventListener('abort', abort, { once: true });
            });
            if (exitCode < 0 && !cancellation.aborted) throw new Error('Sprite execution disconnected before exit');
        } finally {
            clearTimeout(force);
            if (abort) cancellation.removeEventListener('abort', abort);
            command.close();
        }
        if (pending) inspect(pending);
    } finally {
        watchdog.stop();
        const finalCost = await execution?.finish();
        costMessage ??= finalCost ?? undefined;
        await Promise.all(callbacks);
        await watchdog.settled();
        await live?.close();
    }
    if (callbackError) throw callbackError;
    const result = { exitCode, stdout: stdout.output, stderr: stderr.value, messageTimestamps };
    return new Promise((resolve, reject) => {
        if (costMessage) settleCostCapStop(costMessage, result, { preserveOutput: preserve, resolve, reject });
        else if (watchdog.trip) settleWatchdogStop(watchdog.trip, result, preserve, { resolve, reject });
        else if (signal.reason?.name === 'TimeoutError') settleTimeoutStop(options.timeout ?? 300_000, result, preserve, { resolve, reject });
        else if (signal.aborted) reject(signal.reason);
        else resolve(result);
    });
}
