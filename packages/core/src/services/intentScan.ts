import type { Redis } from 'ioredis';
import { getStateManager } from '../utils/workerStateManager.js';
import type { StopTaskRedisClient } from './taskCancellation.js';
import { taskIntentTarget, type IntentTarget } from './taskIntent.js';

/** Shared scans over durable task intents (worker state and the issue queue). */

/** Queue job names that carry a task intent. */
export const INTENT_JOB_NAMES = ['processGitHubIssue', 'processPullRequestComment', 'processMergeConflict'];

/** Queue states holding work that has not reached a terminal outcome. */
export const PENDING_INTENT_JOB_STATES: Array<'waiting' | 'delayed' | 'active' | 'prioritized' | 'waiting-children'> =
    ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'];

export function jobIntentTarget(job: { name: string; data: unknown }): IntentTarget | null {
    const type = { processGitHubIssue: 'issue', processPullRequestComment: 'pr-comment', processMergeConflict: 'merge_conflict' }[job.name];
    return type ? taskIntentTarget(job.data as Record<string, unknown>, type) : null;
}

/**
 * Pages through every non-terminal task state; stopping iteration stops the scan.
 * `strict` throws on a record that exists but cannot be read, instead of skipping it.
 */
export async function* nonTerminalTasks(options: { strict?: boolean } = {}) {
    let cursor = '0';
    do {
        const page = await getStateManager().scanNonTerminalTasks(cursor, 100, { strict: options.strict });
        yield* page.tasks;
        cursor = page.nextCursor;
    } while (cursor !== '0');
}

export function redisAdapter(redis: Redis): StopTaskRedisClient {
    return {
        get: key => redis.get(key),
        set: (key, value, options) => options?.EX ? redis.set(key, value, 'EX', options.EX) : redis.set(key, value),
        rPush: (key, value) => redis.rpush(key, value),
        del: key => redis.del(key),
    };
}
