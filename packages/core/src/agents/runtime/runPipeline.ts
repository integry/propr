import { registerCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { StringDecoder } from 'node:string_decoder';
import { currentExtensionLaunch } from '../../extensions/extensionLaunchContext.js';
import { ExtensionStreamRedactor } from '../../extensions/extensionOutput.js';
import { captureWorkflowMarkers, repositoryWorkflowExecution } from '../../workflow/workflowExecution.js';
import { finishDiagnosticOutput, prepareCommandCapture, scheduleProviderCapture } from '../../diagnostics/managedLogRuntime.js';
import { startExecutionWatchdog } from '../../claude/docker/dockerExecutionWatchdog.js';
import { startLiveOutputStreaming } from '../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine, type SessionLineInspectionContext } from '../../claude/docker/dockerSessionOutput.js';
import type { DockerCommandOptions } from '../../claude/docker/dockerExecutor.js';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, boundedProviderOutput } from '../impl/utils/boundedProviderOutput.js';
import logger from '../../utils/logger.js';

type Stream = 'stdout' | 'stderr';

interface PipelineLaunch {
    markerArgs: string[];
    diagnosticArgs: string[];
    createArgs?: string[];
    environment?: NodeJS.ProcessEnv;
    attempt?: string;
    secrets?: string[];
    /** False when a remote display stream publishes live output independently. */
    liveOutput?: boolean;
    /** Observe captured usage before display redaction can buffer a completed record. */
    incrementalCaptureCost?: { maxRecordBytes: number; unreadable: () => void };
    stopForWatchdog: () => boolean;
    command: string;
    stopForCostCap: (message: string) => void;
    invokeExecutionCallback: SessionLineInspectionContext['invokeExecutionCallback'];
}

/** Consume the physical launch streams before bounded handle readers can drop output. */
export function startRunPipeline(options: DockerCommandOptions, launch: PipelineLaunch) {
    const cost = registerCostExecution(launch.command, launch.markerArgs, options, launch.stopForCostCap);
    if ('refusal' in cost) return { refusal: refuseCostExecution(cost.refusal, options.preserveOutputOnTimeout ?? false) };
    const { execution } = cost;
    const watchdog = startExecutionWatchdog(options, launch.stopForWatchdog);
    const stdout = new BoundedProviderRecordBuffer();
    const stderr = new BoundedDiagnosticTail();
    const markers = captureWorkflowMarkers(launch.markerArgs);
    const secrets = [...(currentExtensionLaunch()?.secrets ?? []), ...(launch.secrets ?? [])];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const redactors = { stdout: new ExtensionStreamRedactor(secrets), stderr: new ExtensionStreamRedactor(secrets) };
    const diagnostics = options.diagnostics && { ...options.diagnostics, attribution: { task: options.taskId, attempt: launch.attempt } };
    const { capture } = prepareCommandCapture(diagnostics, launch.diagnosticArgs, launch.environment, launch.createArgs);
    const timer = scheduleProviderCapture(capture);
    const warn = (error: Error) => logger.warn({ error: error.message, taskId: options.taskId }, 'Live output unavailable; continuing agent execution');
    const transcript = options.streamExtraOutput;
    const streamExtraOutput = transcript && secrets.length ? () => {
        const redact = new ExtensionStreamRedactor(secrets);
        return redact.push(transcript()) + redact.finish();
    } : transcript;
    const live = launch.liveOutput === false ? null : startLiveOutputStreaming({ ...options, streamExtraOutput, onOverflow: warn, onActivity: watchdog.recordActivity,
        onTranscriptRecord: watchdog.observeLine }, () => stdout.output, () => stderr.value);
    const messageTimestamps = new Map<string, string>();
    const session = { state: { sessionIdDetected: false }, messageTimestamps, onSessionId: options.onSessionId,
        invokeExecutionCallback: launch.invokeExecutionCallback };
    let pending = '';
    const captureCost = execution && launch.incrementalCaptureCost && { execution, ...launch.incrementalCaptureCost };
    let costPending = '';
    let costBytes = 0;
    function observeCapturedCost(data: string) {
        if (!captureCost) return;
        const limit = captureCost.maxRecordBytes;
        const parts = data.split('\n');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const previous = costBytes;
            costBytes += Buffer.byteLength(part);
            if (costBytes <= limit) costPending += part;
            else if (previous <= limit) {
                costPending = '';
                captureCost.unreadable();
            }
            if (i < parts.length - 1) {
                if (costBytes <= limit) captureCost.execution.observeLine(costPending);
                costPending = '';
                costBytes = 0;
            }
        }
    }
    function inspect(line: string, timestamp: string) {
        inspectSessionMessageLine(line, timestamp, session);
        if (!captureCost) execution?.observeLine(line);
        watchdog.observeLine(line);
    }
    function publish(stream: Stream, chunk: string) {
        if (stream === 'stdout') {
            stdout.append(chunk);
            const lines = boundedProviderOutput(pending + chunk).split('\n');
            pending = lines.pop() ?? '';
            const timestamp = new Date().toISOString();
            for (const line of lines) inspect(line, timestamp);
        } else {
            stderr.append(chunk);
        }
        capture?.[stream].write(chunk);
        live?.[stream](chunk);
        options.agentRun?.onOutput?.(stream, chunk);
    }
    const pipeline = {
        watchdog,
        hasCaptureCost: !!captureCost,
        finishCost: () => execution?.finish(),
        write(stream: Stream, data: Buffer) {
            watchdog.recordActivity();
            const decoded = decoders[stream].write(data);
            if (stream === 'stdout' && captureCost) observeCapturedCost(decoded);
            if (stream === 'stderr') markers?.append(decoded);
            publish(stream, redactors[stream].push(decoded));
        },
        finishOutput({ disconnected = false, stdoutComplete = !disconnected }: { disconnected?: boolean; stdoutComplete?: boolean } = {}) {
            const workflow = markers && repositoryWorkflowExecution.getStore();
            if (disconnected && workflow) {
                workflow.wrapped = true;
                workflow.observed = undefined;
            }
            clearInterval(timer);
            capture?.snapshot();
            for (const stream of ['stdout', 'stderr'] as const) {
                const tail = decoders[stream].end();
                if (stream === 'stdout' && captureCost) {
                    observeCapturedCost(tail);
                    if (costPending && stdoutComplete) captureCost.execution.observeLine(costPending);
                }
                if (stream === 'stderr' && !disconnected) markers?.finish(tail);
                publish(stream, redactors[stream].push(tail) + redactors[stream].finish());
            }
            if (pending && !disconnected) inspect(pending, new Date().toISOString());
            finishDiagnosticOutput(capture, '', '');
            watchdog.stop();
        },
        closeLive: async () => { await live?.close().catch(warn); },
        result: (exitCode: number | null) => ({ exitCode, stdout: stdout.output, stderr: stderr.value, messageTimestamps }),
    };
    return { pipeline };
}

export type RunPipeline = NonNullable<ReturnType<typeof startRunPipeline>['pipeline']>;
