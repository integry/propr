import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { boundedProviderOutput, MAX_PROVIDER_OUTPUT_BYTES } from './boundedProviderOutput.js';

const APPEND_BOUNDED_OUTPUT_SCRIPT = `
local combined = (redis.call('get', KEYS[1]) or '') .. ARGV[1]
local maximum = tonumber(ARGV[2])
if string.len(combined) > maximum then
    combined = string.sub(combined, string.len(combined) - maximum + 1)
    local boundary = string.find(combined, '\\n')
    if boundary then combined = string.sub(combined, boundary + 1) end
end
redis.call('setex', KEYS[1], tonumber(ARGV[3]), combined)
return string.len(combined)
`;

/**
 * Bounded provider JSONL kept in memory and appended to the task's live Redis
 * output (and optional durable goal records) in small batched flushes.
 */
export class LiveAgentOutput {
    private readonly redis: Redis;
    private output = '';
    private pendingOutput = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly taskId: string | undefined,
        private readonly persistOutput?: (records: string[]) => Promise<void>,
        private readonly label = 'agent',
    ) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
    }

    get raw(): string { return this.output; }

    append(value: string): void {
        this.output = boundedProviderOutput(this.output + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.pendingOutput = boundedProviderOutput(this.pendingOutput + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.scheduleFlush();
    }

    flush(): Promise<void> {
        if (!this.taskId || !this.pendingOutput) return this.flushPromise;
        const chunk = this.pendingOutput;
        this.pendingOutput = '';
        this.flushPromise = this.flushPromise.then(async () => {
            await Promise.all([
                this.redis.eval(
                    APPEND_BOUNDED_OUTPUT_SCRIPT,
                    1,
                    `agent:output:${this.taskId}`,
                    chunk,
                    String(MAX_PROVIDER_OUTPUT_BYTES),
                    '3600',
                ),
                this.persistOutput?.(chunk.split('\n').filter(Boolean)),
            ]);
        }).catch(error => {
            logger.debug({ error: (error as Error).message, label: this.label }, 'Failed to persist live agent output');
        });
        return this.flushPromise;
    }

    private scheduleFlush(): void {
        if (!this.taskId || this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 200);
    }

    async close(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        await this.flush();
        await this.redis.quit().catch(() => undefined);
    }
}
