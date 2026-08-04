import type { Redis } from 'ioredis';
import logger from './logger.js';
import {
    TaskStates,
    type NonTerminalTaskFilter,
    type TaskState,
    type TaskStateData,
} from './workerStateManager.types.js';

type StateEnumerationRedis = Pick<InstanceType<typeof Redis>, 'pipeline' | 'scan'>;

/** Incrementally scans and pipelines state reads without trusting SCAN uniqueness. */
export async function scanNonTerminalTaskStates(
    redis: StateEnumerationRedis,
    keyPrefix: string,
    filter: NonTerminalTaskFilter,
): Promise<TaskStateData[]> {
    const seenKeys = new Set<string>();
    const nonTerminalTasks: TaskStateData[] = [];
    const nonTerminalStates: TaskState[] = [
        TaskStates.PENDING,
        TaskStates.PROCESSING,
        TaskStates.CLAUDE_EXECUTION,
        TaskStates.POST_PROCESSING,
    ];
    const taskTypes = filter.taskTypes ? new Set(filter.taskTypes) : null;
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 100);
        cursor = nextCursor;
        const keys = batch.filter(key => {
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
        });
        if (keys.length === 0) continue;

        const pipeline = redis.pipeline();
        for (const key of keys) pipeline.get(key);
        const results = await pipeline.exec();
        for (let index = 0; index < keys.length; index++) {
            const [error, value] = results?.[index] ?? [];
            if (error) {
                logger.warn({ key: keys[index], error: error.message }, 'Failed to read task state during reconciliation scan');
                continue;
            }
            if (typeof value !== 'string') continue;
            try {
                const state: TaskStateData = JSON.parse(value);
                if (!nonTerminalStates.includes(state.state)) continue;
                if (taskTypes && !taskTypes.has(state.issueRef.type ?? '')) continue;
                nonTerminalTasks.push(state);
            } catch (error) {
                logger.warn({ key: keys[index], error: (error as Error).message }, 'Failed to parse task state during reconciliation scan');
            }
        }
    } while (cursor !== '0');
    return nonTerminalTasks;
}
