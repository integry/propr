import { registerCostExecution, refuseCostExecution } from '../../claude/docker/dockerCostCap.js';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { currentExtensionLaunch } from '../../extensions/extensionLaunchContext.js';
import { ExtensionStreamRedactor } from '../../extensions/extensionOutput.js';
import { captureWorkflowMarkers, repositoryWorkflowExecution } from '../../workflow/workflowExecution.js';
import { finishDiagnosticOutput, prepareCommandCapture, scheduleProviderCapture } from '../../diagnostics/managedLogRuntime.js';
import { startExecutionWatchdog } from '../../claude/docker/dockerExecutionWatchdog.js';
import { startLiveOutputStreaming } from '../../claude/docker/dockerLiveOutputStreaming.js';
import { inspectSessionMessageLine, type SessionLineInspectionContext } from '../../claude/docker/dockerSessionOutput.js';
import type { DockerCommandOptions } from '../../claude/docker/dockerExecutor.js';
import { BoundedDiagnosticTail, BoundedProviderRecordBuffer, MAX_PROVIDER_OUTPUT_BYTES, boundedProviderOutput } from '../impl/utils/boundedProviderOutput.js';
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

const MAX_LIVE_RECORD_DIGESTS = 65_536;
// Fly log messages can omit the CR of a CRLF record terminator.
const recordDigest = (line: string) => createHash('sha256').update(line.replace(/\r$/, '')).digest('hex');

/** Decode and redact across exec chunk boundaries. Skip an oversized record
 * through its newline, but continue accounting for subsequent records. */
function scanCostRecords(secrets: string[], observe: (line: string) => void) {
    const decoder = new StringDecoder('utf8');
    const redactor = new ExtensionStreamRedactor(secrets);
    let partial = '';
    let oversized = false;
    let complete = true;
    function consume(text: string) {
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (!oversized) {
                partial += parts[i];
                if (Buffer.byteLength(partial) > MAX_PROVIDER_OUTPUT_BYTES) {
                    oversized = true;
                    complete = false;
                    partial = '';
                }
            }
            if (i < parts.length - 1) {
                if (!oversized) observe(partial);
                partial = '';
                oversized = false;
            }
        }
    }
    return {
        write(chunk: Buffer) { consume(redactor.push(decoder.write(chunk))); },
        finish() {
            consume(redactor.push(decoder.end()) + redactor.finish());
            if (partial) observe(partial);
            return complete;
        },
    };
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
    // Fly log pages can have gaps. Count occurrences, since identical provider
    // records (including usage without a message id) can legitimately repeat.
    const liveRecords = new Map<string, number>();
    let trackedAllLiveRecords = true;
    function inspect(line: string, timestamp: string) {
        inspectSessionMessageLine(line, timestamp, session);
        if (execution) {
            execution.observeLine(line);
            if (launch.command === 'fly-machines' && trackedAllLiveRecords) {
                const key = recordDigest(line);
                liveRecords.set(key, (liveRecords.get(key) ?? 0) + 1);
                if (liveRecords.size > MAX_LIVE_RECORD_DIGESTS) trackedAllLiveRecords = false;
            }
        }
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
            publish(stream, safe, timestamp);
        },
        // Reconcile the Machine's exact output without publishing the live records twice.
        redactCapture(text: string) {
            const redactor = new ExtensionStreamRedactor(secrets);
            return redactor.push(text) + redactor.finish();
        },
        // Called after log polling has stopped. Flush the live redactor before
        // comparing observations, including when a secret spans log lines.
        beginCostCapture() {
            if (!execution) return;
            const tail = redactors.stdout.finish();
            if (tail) publish('stdout', tail);
            if (pending) {
                inspect(pending, new Date().toISOString());
                pending = '';
            }
            const scan = scanCostRecords(secrets, line => {
                if (!trackedAllLiveRecords) return;
                const key = recordDigest(line);
                const count = liveRecords.get(key);
                if (count === undefined) execution.observeLine(line);
                else if (count === 1) liveRecords.delete(key);
                else liveRecords.set(key, count - 1);
            });
            return {
                write: scan.write,
                finish: () => scan.finish() && trackedAllLiveRecords && liveRecords.size === 0,
            };
        },
        recoverCapturedRecords(output: string) {
            const lines = output.split('\n');
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
