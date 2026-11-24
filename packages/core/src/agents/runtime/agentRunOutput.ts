import { Readable } from 'node:stream';
import { ExecutionAbortedError } from '../../claude/docker/dockerExecutionOwnership.js';

/**
 * What every runtime's run handle shares: bounded, lazily started output
 * streams and the error a handle-stopped run rejects with. Kept apart from the
 * Docker runtime so another runtime does not load the Docker executor for it.
 */

type StreamName = 'stdout' | 'stderr';

/**
 * Output a run-handle stream holds for a reader that has fallen behind (paused,
 * or piped into a slower destination). The agent is never slowed to match its
 * reader: once this much is pending, further chunks are dropped until the
 * reader catches up, and the stream then carries a notice of what was lost.
 * The run's result keeps the executor's own bounded capture either way.
 */
export const AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES = 1024 * 1024;

/** Inserted into a handle stream where output was dropped because its reader fell behind. */
export function agentRunOutputDroppedNotice(name: StreamName, droppedBytes: number): string {
    return `\n[propr: ${droppedBytes} bytes of agent ${name} dropped because the reader fell behind]\n`;
}

/** A readable whose pending output is bounded: chunks arriving while it is full are dropped and counted. */
class BoundedOutputStream extends Readable {
    private droppedBytes = 0;
    private finished = false;

    constructor(private readonly streamName: StreamName, private readonly limitBytes: number) {
        super();
    }

    // Data is pushed as it arrives; there is nothing to pull.
    override _read(): void { /* push-driven */ }

    offer(chunk: string): void {
        if (this.finished || this.destroyed) return;
        const size = Buffer.byteLength(chunk);
        // An empty buffer always takes the next chunk, so a single large chunk
        // still reaches a reader that keeps up; pending output stays within
        // limit + one chunk (plus a one-line drop notice).
        if (this.readableLength > 0 && this.readableLength + size > this.limitBytes) {
            this.droppedBytes += size;
            return;
        }
        this.flushDroppedNotice();
        this.push(chunk);
    }

    finish(): void {
        if (this.finished) return;
        this.finished = true;
        if (this.destroyed) return;
        this.flushDroppedNotice();
        this.push(null);
    }

    private flushDroppedNotice(): void {
        if (this.droppedBytes === 0) return;
        this.push(agentRunOutputDroppedNotice(this.streamName, this.droppedBytes));
        this.droppedBytes = 0;
    }
}

/**
 * Output streams that start forwarding when first read, so unread output is
 * never buffered twice, and that buffer at most
 * {@link AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES} each for a slow reader.
 */
export class LazyOutputStreams {
    private readonly streams: Partial<Record<StreamName, BoundedOutputStream>> = {};
    private ended = false;

    get(name: StreamName): Readable {
        let stream = this.streams[name];
        if (!stream) {
            stream = new BoundedOutputStream(name, AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES);
            if (this.ended) stream.finish();
            this.streams[name] = stream;
        }
        return stream;
    }

    write(name: StreamName, chunk: string): void {
        if (chunk) this.streams[name]?.offer(chunk);
    }

    end(): void {
        this.ended = true;
        this.streams.stdout?.finish();
        this.streams.stderr?.finish();
    }
}

/** Why a run handle cancelled its launch: `wait()` rejects with it. */
export class AgentRunStoppedError extends ExecutionAbortedError {
    constructor(name: string) {
        super(`Agent run ${name} was stopped through its run handle`);
        this.name = 'AgentRunStoppedError';
    }
}
