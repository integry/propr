import type { Redis } from 'ioredis';
import logger from './logger.js';
import {
    TaskStates,
    type NonTerminalTaskScanResult,
    type TaskState,
    type TaskStateData,
} from './workerStateManager.types.js';

type StateScanRedis = Pick<InstanceType<typeof Redis>, 'pipeline' | 'scan'>;

const NON_TERMINAL_STATES: TaskState[] = [
    TaskStates.PENDING,
    TaskStates.PROCESSING,
    TaskStates.CLAUDE_EXECUTION,
    TaskStates.POST_PROCESSING,
];

/** Reads one bounded SCAN page and rejects records stored under a mismatched task key. */
export async function scanNonTerminalTaskStates(
    redis: StateScanRedis,
    keyPrefix: string,
    cursor = '0',
    count = 100,
): Promise<NonTerminalTaskScanResult> {
    const requestedPageSize = Number.isFinite(count) ? Math.floor(count) : 100;
    const pageSize = Math.max(1, Math.min(1_000, requestedPageSize));
    const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${keyPrefix}*`,
        'COUNT',
        pageSize,
    );
    if (keys.length === 0) return { tasks: [], nextCursor };

    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.get(key);
    const values = await pipeline.exec();
    const tasks: TaskStateData[] = [];

    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
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
    return { tasks, nextCursor };
}
