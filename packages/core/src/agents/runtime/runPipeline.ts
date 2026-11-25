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
    const secretsSpanLines = secrets.some(secret => secret.includes('\n'));
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
    const live = startLiveOutputStreaming({ ...options, streamExtraOutput, onOverflow: warn, onActivity: watchdog.recordActivity,
        onTranscriptRecord: watchdog.observeLine }, () => stdout.output, () => stderr.value);
    const messageTimestamps = new Map<string, string>();
    const session = { state: { sessionIdDetected: false }, messageTimestamps, onSessionId: options.onSessionId,
        invokeExecutionCallback: launch.invokeExecutionCallback };
    let pending = '';
    let liveLogBytes = 0;
    function inspect(line: string, timestamp: string) {
        inspectSessionMessageLine(line, timestamp, session);
        execution?.observeLine(line);
        watchdog.observeLine(line);
    }
    function publish(stream: Stream, chunk: string, timestamp = new Date().toISOString()) {
        if (stream === 'stdout') {
            stdout.append(chunk);
            const lines = boundedProviderOutput(pending + chunk).split('\n');
            pending = lines.pop() ?? '';
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
        finishCost: () => execution?.finish(),
        write(stream: Stream, data: Buffer) {
            watchdog.recordActivity();
            const decoded = decoders[stream].write(data);
            if (stream === 'stderr') markers?.append(decoded);
            publish(stream, redactors[stream].push(decoded));
        },
        // Line-oriented transport logs are for live observation. Only the original
        // stderr bytes in the Machine's capture file are authoritative workflow evidence.
        captureWorkflowStderr: markers?.append,
        // The Fly logs API delivers complete lines with their original timestamps.
        writeLogLine(stream: Stream, text: string, timestamp: string) {
            watchdog.recordActivity();
            const redactor = redactors[stream];
            const chunk = redactor.push(text);
            const safe = secretsSpanLines ? chunk : chunk + redactor.finish();
            if (stream === 'stdout') liveLogBytes += Buffer.byteLength(safe);
            publish(stream, safe, timestamp);
        },
        // Reconcile the Machine's exact output without publishing the live records twice.
        redactCapture(text: string) {
            const redactor = new ExtensionStreamRedactor(secrets);
            return redactor.push(text) + redactor.finish();
        },
        recoverCapturedRecords(output: string) {
            // Fly can observe exit before the last log page arrives. Match complete
            // live records against the exact file in order before charging missing
            // records. Never replay a retained tail as though it were the full log.
            const liveOutput = stdout.output;
            const liveLines = execution && !secretsSpanLines && Buffer.byteLength(liveOutput) === liveLogBytes
                ? liveOutput.split('\n').slice(0, -1) : undefined;
            const lines = output.split('\n');
            if (liveLines) {
                let next = 0;
                const missed: string[] = [];
                for (const line of lines) {
                    if (next < liveLines.length && line === liveLines[next]) next++;
                    else if (line) missed.push(line);
                }
                if (next === liveLines.length) for (const line of missed) execution!.observeLine(line);
            }
            const missing = { ...session, messageTimestamps: new Map<string, string>() };
            const timestamp = new Date().toISOString();
            for (const line of lines) inspectSessionMessageLine(line, timestamp, missing);
            for (const [id, at] of missing.messageTimestamps) if (!messageTimestamps.has(id)) messageTimestamps.set(id, at);
        },
        finishOutput({ disconnected = false } = {}) {
            const workflow = markers && repositoryWorkflowExecution.getStore();
            if (disconnected && workflow) {
                workflow.wrapped = true;
                workflow.observed = undefined;
            }
            clearInterval(timer);
            capture?.snapshot();
            for (const stream of ['stdout', 'stderr'] as const) {
                const tail = decoders[stream].end();
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
