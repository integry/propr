import type { Redis } from 'ioredis';
import logger from './logger.js';
import {
    TaskStates,
    type NonTerminalTaskFilter,
    type TaskState,
    type TaskStateData,
} from './workerStateManager.types.js';

type StateEnumerationRedis = Pick<InstanceType<typeof Redis>, 'pipeline' | 'scan'>;
type StateMaintenanceRedis = Pick<InstanceType<typeof Redis>, 'del' | 'get' | 'keys'>;

export interface NonTerminalTaskScanResult {
    tasks: TaskStateData[];
    nextCursor: string;
    /** Unread keys from a SCAN page that exceeded this invocation's bound. */
    pendingKeys: string[];
}

export interface NonTerminalTaskScanPosition {
    cursor: string;
    pendingKeys: string[];
}

/**
 * Recognizes PR-comment task state written before `issueRef.type` was added.
 * Explicit types always win; the legacy fallback is deliberately limited to
 * the old queue ID prefixes or the comment payload stored by that processor.
 */
export function isPRCommentTaskState(state: TaskStateData): boolean {
    if (state.issueRef.type !== undefined) return state.issueRef.type === 'pr_comment';
    return state.taskId.startsWith('pr-comments-')
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
    position: NonTerminalTaskScanPosition = { cursor: '0', pendingKeys: [] },
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
    // A finite result limit is also the hard bound on Redis values inspected.
    // SCAN's COUNT is only a hint, so excess keys from a page are retained by
    // WorkerStateManager and consumed before advancing the cursor again.
    const inspectionLimit = limit;
    const pageLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : Number.POSITIVE_INFINITY;
    let inspectedKeys = 0;
    let inspectedPages = 0;
    let cursor = position.cursor;
    const readKeys = async (batch: string[]): Promise<string[]> => {
        const remaining = inspectionLimit - inspectedKeys;
        const keys: string[] = [];
        const overflow: string[] = [];
        for (const key of batch) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            if (keys.length < remaining) keys.push(key);
            else overflow.push(key);
        }
        if (keys.length === 0) return overflow;

        inspectedKeys += keys.length;
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
        return overflow;
    };

    if (position.pendingKeys.length > 0) {
        const pendingKeys = await readKeys(position.pendingKeys);
        if (pendingKeys.length > 0 || inspectedKeys >= inspectionLimit || nonTerminalTasks.length >= limit) {
            return { tasks: nonTerminalTasks, nextCursor: cursor, pendingKeys };
        }
        // A zero cursor paired with pending keys represents the final page of
        // the previous SCAN cycle. Finish it without starting that cycle over.
        if (cursor === '0') return { tasks: nonTerminalTasks, nextCursor: cursor, pendingKeys: [] };
    }

    do {
        const remaining = inspectionLimit - inspectedKeys;
        const count = Number.isFinite(remaining) ? Math.max(1, Math.min(100, remaining)) : 100;
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', count);
        inspectedPages++;
        cursor = nextCursor;
        const pendingKeys = await readKeys(batch);
        if (pendingKeys.length > 0
            || inspectedKeys >= inspectionLimit
            || inspectedPages >= pageLimit
            || nonTerminalTasks.length >= limit) {
            return { tasks: nonTerminalTasks, nextCursor: cursor, pendingKeys };
        }
    } while (cursor !== '0');
    return { tasks: nonTerminalTasks, nextCursor: cursor, pendingKeys: [] };
}

export async function getProcessingTaskStates(
    redis: StateMaintenanceRedis,
    keyPrefix: string,
): Promise<TaskStateData[]> {
    const keys = await redis.keys(`${keyPrefix}*`);
    const processingTasks: TaskStateData[] = [];
    const processingStates: TaskState[] = [
        TaskStates.PROCESSING,
        TaskStates.CLAUDE_EXECUTION,
        TaskStates.POST_PROCESSING,
    ];
    for (const key of keys) {
        try {
            const stateJson = await redis.get(key);
            if (!stateJson) continue;
            const state: TaskStateData = JSON.parse(stateJson);
            if (processingStates.includes(state.state)) processingTasks.push(state);
        } catch (error) {
            logger.warn({ key, error: (error as Error).message }, 'Failed to parse task state during recovery scan');
        }
    }
    return processingTasks;
}

export async function cleanupOldTaskStates(
    redis: StateMaintenanceRedis,
    keyPrefix: string,
    _revisionKeyPrefix: string,
    maxAge: number,
): Promise<number> {
    const keys = await redis.keys(`${keyPrefix}*`);
    const cutoffTime = Date.now() - (maxAge * 1000);
    const cleanupStates: TaskState[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    let cleanedCount = 0;
    for (const key of keys) {
        try {
            const stateJson = await redis.get(key);
            if (!stateJson) continue;
            const state: TaskStateData = JSON.parse(stateJson);
            if (!cleanupStates.includes(state.state)) continue;
            const updatedAt = new Date(state.updatedAt).getTime();
            if (updatedAt >= cutoffTime) continue;
            // The revision is a longer-lived monotonic fence. Deleting it with
            // the expiring state lets a recreated task restart at version 1,
            // which live socket caches and SQL generation checks can reject as
            // stale. Its own revisionExpiry bounds retention.
            await redis.del(key);
            cleanedCount++;
            logger.debug({ taskId: state.taskId, state: state.state, age: Date.now() - updatedAt }, 'Cleaned up old task state');
        } catch (error) {
            logger.warn({ key, error: (error as Error).message }, 'Failed to cleanup task state');
        }
    }
    logger.info({ cleanedCount, totalKeys: keys.length, maxAge }, 'Task state cleanup completed');
    return cleanedCount;
}
