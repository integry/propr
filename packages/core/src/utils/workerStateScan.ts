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
const KNOWN_STATES: readonly unknown[] = Object.values(TaskStates);

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

export interface NonTerminalTaskScanOptions {
    count?: number;
    /**
     * Throw instead of skipping a record that exists but cannot be read or
     * parsed (or is stored under a mismatched key or in an unknown state), so a
     * caller that must see every nonterminal task never mistakes unreadable
     * work for absent work.
     */
    strict?: boolean;
}

function unreadable(strict: boolean | undefined, key: string, detail: string): null {
    if (strict) throw new Error(`Unreadable task state ${key}: ${detail}`);
    return null;
}

/** One pipeline result as task state; null for an absent (deleted) or skipped record. */
function readTaskState(key: string, keyPrefix: string, entry: [Error | null, unknown] | undefined, strict?: boolean): TaskStateData | null {
    if (!entry) return unreadable(strict, key, 'missing pipeline result');
    const [error, value] = entry;
    if (error) {
        unreadable(strict, key, error.message);
        logger.warn({ key, error: error.message }, 'Failed to read task state during recovery scan');
        return null;
    }
    if (typeof value !== 'string') return value === null || value === undefined ? null : unreadable(strict, key, 'non-string value');
    let state: TaskStateData;
    try {
        state = JSON.parse(value) as TaskStateData;
        if (typeof state !== 'object' || state === null) throw new Error('not an object');
    } catch (parseError) {
        unreadable(strict, key, (parseError as Error).message);
        logger.warn({ key, error: (parseError as Error).message }, 'Failed to parse task state during recovery scan');
        return null;
    }
    if (state.taskId !== key.slice(keyPrefix.length)) {
        unreadable(strict, key, 'task ID does not match its key');
        logger.warn({ key, taskId: state.taskId }, 'Ignoring task state whose ID does not match its Redis key');
        return null;
    }
    // An unknown state cannot be proved terminal.
    return KNOWN_STATES.includes(state.state) ? state : unreadable(strict, key, 'unknown state');
}

/**
 * Reads one bounded SCAN page and rejects records stored under a mismatched task
 * key. `options` may be the page size alone.
 */
export async function scanNonTerminalTaskStates(
    redis: StateScanRedis,
    keyPrefix: string,
    cursor = '0',
    options: number | NonTerminalTaskScanOptions = {},
): Promise<NonTerminalTaskScanResult> {
    const { count = 100, strict } = typeof options === 'number' ? { count: options } : options;
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
        const state = readTaskState(batchKeys[index], keyPrefix, values?.[index] as [Error | null, unknown] | undefined, strict);
        if (state && NON_TERMINAL_STATES.includes(state.state)) tasks.push(state);
    }

    if (hasRemainingKeys) {
        batch.continuation!.offset = batchEnd;
        scanContinuations.set(redis, batch.continuation!);
        return { tasks, nextCursor: cursor };
    }

    scanContinuations.delete(redis);
    return { tasks, nextCursor: batch.nextCursor };
}
