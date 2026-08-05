import type { Redis } from 'ioredis';
import logger from './logger.js';
import {
    TaskStates,
    type NonTerminalTaskFilter,
    type TaskState,
    type TaskStateData,
} from './workerStateManager.types.js';

type StateEnumerationRedis = Pick<InstanceType<typeof Redis>, 'pipeline' | 'scan'>;

export interface NonTerminalTaskScanResult {
    tasks: TaskStateData[];
    nextCursor: string;
}

/**
 * Recognizes PR-comment task state written before `issueRef.type` was added.
 * Explicit types always win; the legacy fallback is deliberately limited to
 * the old queue ID prefixes or the comment payload stored by that processor.
 */
export function isPRCommentTaskState(state: TaskStateData): boolean {
    if (state.issueRef.type !== undefined) return state.issueRef.type === 'pr_comment';
    return state.taskId.startsWith('pr-comments-batch-')
        || state.taskId.startsWith('pr-comment-')
        || (/^\d+$/.test(state.taskId)
            && Number.isInteger(state.issueRef.number)
            && state.issueRef.number > 0
            && Array.isArray(state.issueRef.comments)
            && state.issueRef.comments.length > 0
            && state.issueRef.comments.every(comment => (
                comment !== null
                && typeof comment === 'object'
                && Number.isFinite((comment as { id?: unknown }).id)
                && typeof (comment as { body?: unknown }).body === 'string'
            )));
}

function matchesTaskType(state: TaskStateData, taskTypes: Set<string>): boolean {
    if (state.issueRef.type !== undefined) return taskTypes.has(state.issueRef.type);
    return taskTypes.has('pr_comment') && isPRCommentTaskState(state);
}

/** Incrementally scans and pipelines state reads without trusting SCAN uniqueness. */
export async function scanNonTerminalTaskStates(
    redis: StateEnumerationRedis,
    keyPrefix: string,
    filter: NonTerminalTaskFilter,
    initialCursor = '0',
): Promise<NonTerminalTaskScanResult> {
    const seenKeys = new Set<string>();
    const nonTerminalTasks: TaskStateData[] = [];
    const nonTerminalStates: TaskState[] = [
        TaskStates.PENDING,
        TaskStates.PROCESSING,
        TaskStates.CLAUDE_EXECUTION,
        TaskStates.POST_PROCESSING,
    ];
    const taskTypes = filter.taskTypes ? new Set(filter.taskTypes) : null;
    const limit = Math.max(1, filter.limit ?? Number.POSITIVE_INFINITY);
    let cursor = initialCursor;
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
                if (taskTypes && !matchesTaskType(state, taskTypes)) continue;
                nonTerminalTasks.push(state);
            } catch (error) {
                logger.warn({ key: keys[index], error: (error as Error).message }, 'Failed to parse task state during reconciliation scan');
            }
        }
        // Finish the Redis SCAN page so no keys from the returned cursor page
        // are skipped. COUNT is a hint, so a page can be slightly over limit.
        if (nonTerminalTasks.length >= limit) {
            return { tasks: nonTerminalTasks, nextCursor: cursor };
        }
    } while (cursor !== '0');
    return { tasks: nonTerminalTasks, nextCursor: cursor };
}
