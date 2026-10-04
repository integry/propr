import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { boundedProviderOutput, MAX_PROVIDER_OUTPUT_BYTES } from './boundedProviderOutput.js';
import { LiveOutputBacklog, LiveOutputLog } from './liveOutputLog.js';

/**
 * Bounded provider JSONL kept in memory and appended to the task's live Redis
 * output log (and optional durable goal records) in small batched flushes.
 * Records neither sink has acknowledged are bounded (see {@link LiveOutputBacklog}).
 */
export class LiveAgentOutput {
    private readonly liveLog?: LiveOutputLog;
    private readonly writes: Array<{ chunk: string; bytes: number }> = [];
    private readonly backlog: LiveOutputBacklog;
    private closed = false;
    private finished = false;
    private closePromise: Promise<void> | null = null;
    private output = '';
    private pendingOutput = '';
    /** Reserved for `pendingOutput`; bounding it may leave this higher than its size. */
    private pendingBytes = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly taskId: string | undefined,
        private readonly persistOutput?: (records: string[]) => Promise<void>,
        private readonly label = 'agent',
        { redis, maximumQueuedBytes, onOverflow }: {
            redis?: Redis;
            maximumQueuedBytes?: number;
            /** Called once when unacknowledged output passes the maximum; later output is refused. */
            onOverflow?: (error: Error) => void;
        } = {},
    ) {
        this.backlog = new LiveOutputBacklog(maximumQueuedBytes, onOverflow, { taskId, label });
        // Redis is an ephemeral display sink. Its backlog and acknowledgements
        // must never hold up, or release, the independent durable obligation.
        if (taskId) this.liveLog = new LiveOutputLog(taskId, { redis, maximumQueuedBytes, flushIntervalMs: 200 });
    }

    get raw(): string { return this.output; }

    append(value: string): void {
        if (this.closed) return;
        this.output = boundedProviderOutput(this.output + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.liveLog?.append(value);
        if (!this.taskId || !this.persistOutput) return;
        const bytes = Buffer.byteLength(value);
        if (!this.backlog.reserve(bytes)) return;
        this.pendingOutput = boundedProviderOutput(this.pendingOutput + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.pendingBytes += bytes;
        this.scheduleFlush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        const publication = this.liveLog?.flush();
        if (!this.taskId || !this.persistOutput) return publication ?? this.flushPromise;
        if (this.pendingOutput) {
            const bytes = Buffer.byteLength(this.pendingOutput);
            this.backlog.release(this.pendingBytes - bytes);
            this.writes.push({ chunk: this.pendingOutput, bytes });
            this.pendingOutput = '';
            this.pendingBytes = 0;
        }
        this.flushPromise = this.flushPromise.then(async () => {
            while (this.writes.length > 0) {
                const write = this.writes[0];
                try {
                    await this.persistOutput!(write.chunk.split('\n').filter(Boolean));
                } catch (error) {
                    logger.debug({ error: (error as Error).message, label: this.label }, 'Failed to persist durable agent output');
                    this.scheduleFlush();
                    return;
                }
                this.backlog.release(write.bytes);
                this.writes.shift();
            }
        });
        return Promise.all([this.flushPromise, publication]).then(() => undefined);
    }

    private scheduleFlush(): void {
        if (this.closed || !this.taskId || this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 200);
    }

    async close(): Promise<void> {
        if (this.finished) {
            if (this.backlog.overflow) throw this.backlog.overflow;
            return;
        }
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.finishClose();
        try { await this.closePromise; }
        finally { this.closePromise = null; }
    }

    private async finishClose(): Promise<void> {
        this.closed = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        // close() retries the Redis drain with bounded backoff. Failure remains
        // diagnostic; only unacknowledged durable writes can fail the session.
        await Promise.all([
            this.flush(),
            this.liveLog?.close().catch(error => {
                logger.warn({ error: (error as Error).message, label: this.label }, 'Failed to publish final live agent output');
            }),
        ]);
        if (this.writes.length > 0) throw new Error('Live agent output still has unacknowledged writes');
        this.finished = true;
        // Everything accepted was acknowledged, but the output refused after the overflow was not.
        if (this.backlog.overflow) throw this.backlog.overflow;
    }
}
