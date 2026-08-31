import { spawn } from 'child_process';
import fs from 'fs';
import type { Readable } from 'stream';
import {
    abortSpawnedExecution,
    createDockerExecutionState,
    ExecutionAbortedError,
    getExecutionAbortError,
    getDockerRunContainerName,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from './dockerExecutionOwnership.js';
import { scheduleForceKill } from './dockerAbortController.js';
import { resolveDockerPath } from './dockerProcessUtils.js';

export interface SupervisedDockerFence {
    goalId: string;
    sessionId: string;
    controllerEpoch: number;
    turnId: string;
    attemptId: string;
    worktreeFingerprint: string;
}

export interface SupervisedDockerOutput extends SupervisedDockerFence {
    channel: 'stdout' | 'stderr';
    data: string;
}

export interface SupervisedDockerOptions extends SupervisedDockerFence {
    taskId?: string;
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    /**
     * Allow-listed environment injected into the spawned docker client's own
     * environment. Callers pair this with `docker run --env NAME` (name only) so
     * secret values are never placed in argv/process listings.
     */
    env?: Record<string, string>;
    /** Largest single durable chunk; larger stream reads are split. Default 64 KiB. */
    maxChunkBytes?: number;
    /** Hard bound on buffered-but-undelivered bytes before overflow cancellation. Default 8 MiB. */
    maxQueuedBytes?: number;
    /** Called once per arriving stream chunk. Delivery is serialized and back-pressured. */
    durableOutput: (output: SupervisedDockerOutput) => void | Promise<void>;
}

export interface SupervisedDockerExecution {
    containerName: string | null;
    writeInput(data: string): Promise<void>;
    closeInput(): void;
    /** Terminal cancellation is immediate and deliberately separate from provider pause. */
    cancel(reason?: Error): Promise<void>;
    completion: Promise<{ exitCode: number | null }>;
}

const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

function assertPositiveSafeInteger(value: number | undefined, name: string): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Supervised Docker ${name} must be a positive safe integer`);
    }
}

/**
 * Resolves the backpressure limits into a coherent, positive, safe-integer
 * policy. A caller may set only the queued bound; the per-chunk default is then
 * clamped so it can never exceed it. Explicitly incoherent overrides are rejected.
 */
function resolveBackpressureLimits(options: SupervisedDockerOptions): { maxChunkBytes: number; maxQueuedBytes: number } {
    assertPositiveSafeInteger(options.maxQueuedBytes, 'maxQueuedBytes');
    assertPositiveSafeInteger(options.maxChunkBytes, 'maxChunkBytes');
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    const maxChunkBytes = options.maxChunkBytes ?? Math.min(DEFAULT_MAX_CHUNK_BYTES, maxQueuedBytes);
    if (maxChunkBytes > maxQueuedBytes) {
        throw new Error('Supervised Docker maxChunkBytes must not exceed maxQueuedBytes');
    }
    return { maxChunkBytes, maxQueuedBytes };
}

function isUtf8ContinuationByte(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}

/**
 * Splits a buffer into slices no larger than maxChunkBytes, backing each split
 * off any trailing UTF-8 continuation bytes so a multi-byte character is never
 * cut across a chunk boundary and every slice decodes to valid text.
 */
function splitBuffer(buffer: Buffer, maxChunkBytes: number): Buffer[] {
    if (buffer.length <= maxChunkBytes) return [buffer];
    const slices: Buffer[] = [];
    let offset = 0;
    while (offset < buffer.length) {
        let end = Math.min(offset + maxChunkBytes, buffer.length);
        if (end < buffer.length) {
            while (end > offset && isUtf8ContinuationByte(buffer[end])) end -= 1;
            // A run of continuation bytes longer than a chunk (only possible for
            // malformed input) falls back to a hard split to guarantee progress.
            if (end === offset) end = Math.min(offset + maxChunkBytes, buffer.length);
        }
        slices.push(buffer.subarray(offset, end));
        offset = end;
    }
    return slices;
}

/**
 * Serializes stream chunks to a durable sink while bounding memory. Chunks are
 * delivered strictly in arrival order across stdout and stderr. When buffered
 * bytes cross a high-water mark the source streams are paused, and they resume
 * once the sink drains below the low-water mark, so a slow sink cannot cause
 * unbounded buffering. Exceeding the hard cap raises an actionable overflow error.
 */
interface OrderedBackpressureSinkConfig {
    base: SupervisedDockerFence;
    deliver: (output: SupervisedDockerOutput) => void | Promise<void>;
    streams: () => Array<Readable | null | undefined>;
    onOverflow: (error: Error) => void;
    maxChunkBytes: number;
    maxQueuedBytes: number;
}

class OrderedBackpressureSink {
    private readonly queue: SupervisedDockerOutput[] = [];
    private queuedBytes = 0;
    private draining = false;
    private paused = false;
    private failed = false;
    private loop: Promise<void> = Promise.resolve();
    private readonly base: SupervisedDockerFence;
    private readonly deliver: (output: SupervisedDockerOutput) => void | Promise<void>;
    private readonly streams: () => Array<Readable | null | undefined>;
    private readonly onOverflow: (error: Error) => void;
    private readonly maxChunkBytes: number;
    private readonly maxQueuedBytes: number;
    private readonly highWaterMark: number;
    private readonly lowWaterMark: number;

    constructor(config: OrderedBackpressureSinkConfig) {
        this.base = config.base;
        this.deliver = config.deliver;
        this.streams = config.streams;
        this.onOverflow = config.onOverflow;
        this.maxChunkBytes = config.maxChunkBytes;
        this.maxQueuedBytes = config.maxQueuedBytes;
        this.highWaterMark = Math.max(1, Math.floor(config.maxQueuedBytes / 2));
        this.lowWaterMark = Math.max(1, Math.floor(config.maxQueuedBytes / 4));
    }

    enqueue(channel: 'stdout' | 'stderr', buffer: Buffer): void {
        if (this.failed) return;
        for (const slice of splitBuffer(buffer, this.maxChunkBytes)) {
            this.queue.push({ ...this.base, channel, data: slice.toString() });
            this.queuedBytes += slice.length;
            if (this.queuedBytes >= this.highWaterMark) this.setPaused(true);
            // Enforce the hard cap while enqueuing each slice so a single
            // oversized read is stopped mid-split instead of being fully
            // buffered before the bound is checked.
            if (this.queuedBytes > this.maxQueuedBytes) {
                this.fail(new Error(`Supervised Docker output exceeded the ${this.maxQueuedBytes}-byte backpressure bound; the durable sink is too slow to keep up`));
                return;
            }
        }
        this.ensureDraining();
    }

    /** Resolves once every queued chunk has been delivered (or delivery failed). */
    settle(): Promise<void> {
        return this.loop;
    }

    private ensureDraining(): void {
        if (this.draining || this.failed) return;
        this.draining = true;
        this.loop = this.drain();
    }

    private async drain(): Promise<void> {
        while (this.queue.length && !this.failed) {
            const item = this.queue.shift()!;
            try {
                await this.deliver(item);
            } catch (error) {
                this.fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.queuedBytes -= Buffer.byteLength(item.data);
            if (this.paused && this.queuedBytes <= this.lowWaterMark) this.setPaused(false);
        }
        this.draining = false;
        if (this.paused && this.queuedBytes <= this.lowWaterMark) this.setPaused(false);
    }

    private setPaused(paused: boolean): void {
        if (this.paused === paused) return;
        this.paused = paused;
        for (const stream of this.streams()) {
            if (paused) stream?.pause();
            else stream?.resume();
        }
    }

    private fail(error: Error): void {
        if (this.failed) return;
        this.failed = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.setPaused(false);
        this.onOverflow(error);
    }
}

export function addGoalFenceLabels(args: string[], fence: SupervisedDockerFence): string[] {
    if (args[0] !== 'run') return args;
    return [
        'run',
        '--label', `propr.goal.id=${fence.goalId}`,
        '--label', `propr.goal.session=${fence.sessionId}`,
        '--label', `propr.goal.controller-epoch=${fence.controllerEpoch}`,
        '--label', `propr.goal.turn=${fence.turnId}`,
        '--label', `propr.goal.attempt=${fence.attemptId}`,
        '--label', `propr.goal.worktree-fingerprint=${fence.worktreeFingerprint}`,
        ...args.slice(1),
    ];
}

function validateSupervisedOptions(args: string[], options: SupervisedDockerOptions): void {
    if (args[0] !== 'run') throw new Error('Supervised Docker execution only supports docker run');
    if (!options.goalId || !options.sessionId || !options.turnId || !options.attemptId
        || !options.worktreeFingerprint || !Number.isSafeInteger(options.controllerEpoch)) {
        throw new Error('A valid goal/session/controller epoch/turn fence is required');
    }
    if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout <= 0)) {
        throw new Error('Supervised Docker timeout must be a positive safe integer');
    }
}

/**
 * Starts a controlled duplex Docker invocation for a goal turn. Unlike the
 * legacy one-shot executor, stdin remains open and output deltas are awaited by
 * an injected durable sink with explicit backpressure. No expiring full-output
 * snapshot is maintained.
 */
export function executeSupervisedDockerCommand(
    args: string[],
    options: SupervisedDockerOptions,
): SupervisedDockerExecution {
    validateSupervisedOptions(args, options);
    const backpressureLimits = resolveBackpressureLimits(options);
    const ownershipContext = getExecutionOwnershipContext();
    const executionSignal = options.signal ?? ownershipContext?.signal;
    const initialAbortError = getExecutionAbortError(executionSignal);
    if (initialAbortError) throw initialAbortError;
    const fencedArgs = addGoalFenceLabels(
        resolveExecutionArgs('docker', args, options.taskId, ownershipContext?.attemptGeneration),
        options,
    );
    const containerName = getDockerRunContainerName(fencedArgs);
    const child = spawn(resolveDockerPath('docker'), fencedArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined,
        // Exact allowlist: never inherit host-controlled Docker, loader, SSH, or
        // credential variables into this security boundary.
        env: options.env ?? {},
    });
    const state = createDockerExecutionState();
    let outputFailure: unknown;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let cancelReason: Error | undefined;
    let settled = false;
    let settleCompletion: ((result: { exitCode: number | null }) => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        settleCompletion = resolve;
        rejectCompletion = reject;
    });
    const cancel = async (reason = new ExecutionAbortedError()): Promise<void> => {
        if (settled) return;
        cancelReason ??= reason;
        await abortSpawnedExecution(child, state, {
            namedContainer: containerName,
            scheduleForceKill,
            taskId: options.taskId,
            attemptGeneration: ownershipContext?.attemptGeneration,
        });
    };
    const sink = new OrderedBackpressureSink({
        base: options,
        deliver: options.durableOutput,
        streams: () => [child.stdout, child.stderr],
        onOverflow: error => { outputFailure ??= error; void cancel(error); },
        maxChunkBytes: backpressureLimits.maxChunkBytes,
        maxQueuedBytes: backpressureLimits.maxQueuedBytes,
    });
    child.stdout?.on('data', (data: Buffer) => sink.enqueue('stdout', data));
    child.stderr?.on('data', (data: Buffer) => sink.enqueue('stderr', data));
    const abortListener = (): void => { void cancel(getExecutionAbortError(executionSignal) ?? undefined); };
    executionSignal?.addEventListener('abort', abortListener, { once: true });
    if (options.timeout !== undefined) {
        timeoutHandle = setTimeout(() => { void cancel(new Error(`Supervised Docker command timed out after ${options.timeout}ms`)); }, options.timeout);
    }
    child.once('close', (exitCode: number | null) => {
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        executionSignal?.removeEventListener('abort', abortListener);
        // On a sink failure (e.g. overflow) the delivery may be stuck, so don't
        // wait on it; otherwise drain in order before settling.
        const drained = outputFailure ? Promise.resolve() : sink.settle();
        void drained.then(async () => {
            if (state.teardownPromise) await state.teardownPromise;
            if (outputFailure) rejectCompletion?.(outputFailure);
            else if (cancelReason) rejectCompletion?.(cancelReason);
            else settleCompletion?.({ exitCode });
        });
    });
    child.once('error', error => {
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        executionSignal?.removeEventListener('abort', abortListener);
        rejectCompletion?.(error);
    });

    return {
        containerName,
        writeInput(data: string): Promise<void> {
            if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
                return Promise.reject(new Error('Supervised Docker stdin is closed'));
            }
            return new Promise((resolve, reject) => {
                child.stdin!.write(data, error => error ? reject(error) : resolve());
            });
        },
        closeInput(): void { child.stdin?.end(); },
        cancel,
        completion,
    };
}
