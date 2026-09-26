import type { Redis } from 'ioredis';
import logger from './logger.js';
import {
    TaskStates,
    type NonTerminalTaskScanResult,
    type TaskState,
    type TaskStateData,
} from './workerStateManager.types.js';

type StateScanRedis = Pick<InstanceType<typeof Redis>, 'pipeline' | 'scan'>;

interface ScanContinuation {
    cursor: string;
    keyPrefix: string;
    keys: string[];
    nextCursor: string;
    offset: number;
}

interface ScanBatch {
    keys: string[];
    start: number;
    nextCursor: string;
    continuation?: ScanContinuation;
}

// A WorkerStateManager owns one Redis client, so retaining at most one response
// per client prevents abandoned scans from accumulating over-sized pages.
const scanContinuations = new WeakMap<StateScanRedis, ScanContinuation>();

const NON_TERMINAL_STATES: TaskState[] = [
    TaskStates.PENDING,
    TaskStates.PROCESSING,
    TaskStates.CLAUDE_EXECUTION,
    TaskStates.POST_PROCESSING,
];

async function readScanBatch(
    redis: StateScanRedis,
    keyPrefix: string,
    cursor: string,
    pageSize: number,
): Promise<ScanBatch> {
    const stored = scanContinuations.get(redis);
    if (stored?.cursor === cursor && stored.keyPrefix === keyPrefix) {
        return {
            keys: stored.keys,
            start: stored.offset,
            nextCursor: stored.nextCursor,
            continuation: stored,
        };
    }

    const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${keyPrefix}*`,
        'COUNT',
        pageSize,
    );
    if (keys.length <= pageSize) return { keys, start: 0, nextCursor };

    const continuation = { cursor, keyPrefix, keys, nextCursor, offset: 0 };
    // Retain the response before reading values so a failed pipeline can retry
    // this batch without issuing SCAN again and losing excess keys.
    scanContinuations.set(redis, continuation);
    return { keys, start: 0, nextCursor, continuation };
}

/** Reads one bounded SCAN page and rejects records stored under a mismatched task key. */
export async function scanNonTerminalTaskStates(
    redis: StateScanRedis,
    keyPrefix: string,
    cursor = '0',
    count = 100,
): Promise<NonTerminalTaskScanResult> {
    const requestedPageSize = Number.isFinite(count) ? Math.floor(count) : 100;
    const pageSize = Math.max(1, Math.min(1_000, requestedPageSize));
    const batch = await readScanBatch(redis, keyPrefix, cursor, pageSize);
    const batchEnd = Math.min(batch.start + pageSize, batch.keys.length);
    const batchKeys = batch.keys.slice(batch.start, batchEnd);
    const hasRemainingKeys = batchEnd < batch.keys.length;
    if (batchKeys.length === 0) {
        scanContinuations.delete(redis);
        return { tasks: [], nextCursor: batch.nextCursor };
    }

    const pipeline = redis.pipeline();
    for (const key of batchKeys) pipeline.get(key);
    const values = await pipeline.exec();
    const tasks: TaskStateData[] = [];

    for (let index = 0; index < batchKeys.length; index++) {
        const key = batchKeys[index];
        const [error, value] = values?.[index] ?? [];
        if (error || typeof value !== 'string') {
            if (error) logger.warn({ key, error: error.message }, 'Failed to read task state during recovery scan');
            continue;
        }
        try {
            const state = JSON.parse(value) as TaskStateData;
            if (state.taskId !== key.slice(keyPrefix.length)) {
                logger.warn({ key, taskId: state.taskId }, 'Ignoring task state whose ID does not match its Redis key');
                continue;
            }
            if (NON_TERMINAL_STATES.includes(state.state)) tasks.push(state);
        } catch (error) {
            logger.warn({ key, error: (error as Error).message }, 'Failed to parse task state during recovery scan');
        }
    }

    if (hasRemainingKeys) {
        batch.continuation!.offset = batchEnd;
        scanContinuations.set(redis, batch.continuation!);
        return { tasks, nextCursor: cursor };
    }

    scanContinuations.delete(redis);
    return { tasks, nextCursor: batch.nextCursor };
}
