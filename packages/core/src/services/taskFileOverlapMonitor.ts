import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { replayableTransaction } from '../db/sqliteRetry.js';
import logger from '../utils/logger.js';
import { updateFileChangesFromWorktree, type FileChangesData } from './worktreeMonitorService.js';
import { boundOverlapPaths, computeFileOverlaps, describeOverlapPaths, normalizeHotPaths, overlapsForTask } from './taskFileOverlap.js';

/**
 * Early, non-blocking warning when concurrent tasks on one repository change the same files.
 * Runs that capture live changes register here; a throttled comparison records each newly
 * overlapping pair on both task timelines once and keeps each task's current overlaps.
 * Nothing here delays, reorders or refuses any task.
 */

const FILE_CHANGES_PREFIX = 'task:file-changes:';
const OVERLAPS_PREFIX = 'task:file-overlaps:';
/** A registered run that has not captured for this long is no longer considered active. */
export const ACTIVE_TASK_STALE_MS = 120_000;
/** At most one comparison per repository in this window. */
export const OVERLAP_CHECK_INTERVAL_SECONDS = 30;
const PAIR_TTL_SECONDS = 30 * 86400;
/** Holds a pair while one comparison delivers its events, so concurrent comparisons do not both write. */
const PAIR_DELIVERY_LOCK_SECONDS = 60;
const OVERLAPS_TTL_SECONDS = 86400;
const REGISTRY_TTL_SECONDS = 3600;

export interface TaskFileOverlap {
    /** The other task changing the same files. */
    taskId: string;
    /** Shared paths, bounded to MAX_OVERLAP_PATHS. */
    paths: string[];
    totalPaths: number;
    repository: string;
    issueNumber: number | null;
    taskType: string | null;
}

interface StoredOverlaps {
    repository: string;
    computedAt: string;
    overlaps: TaskFileOverlap[];
}

export interface OverlapCheckResult {
    status: 'single_task' | 'throttled' | 'checked';
    /** Pairs whose overlap was recorded for the first time by this check. */
    newPairs: Array<[string, string]>;
}

const repositoryKey = (repository: string) => repository.toLowerCase();
export const activeFileChangesTasksKey = (repository: string) => `task:file-changes:active:{${repositoryKey(repository)}}`;
const throttleKey = (repository: string) => `task:file-overlap:throttle:{${repositoryKey(repository)}}`;
const pairKey = (repository: string, [a, b]: [string, string]) => `task:file-overlap:pair:{${repositoryKey(repository)}}:${a}:${b}`;

/** Hot directory prefixes from `PROPR_FILE_OVERLAP_HOT_PATHS` (comma-separated). */
export function configuredHotPaths(): string[] {
    return normalizeHotPaths(process.env.PROPR_FILE_OVERLAP_HOT_PATHS);
}

export async function registerActiveFileChangesTask(redis: Redis, repository: string, taskId: string, now = Date.now()): Promise<void> {
    const key = activeFileChangesTasksKey(repository);
    await redis.zadd(key, now, taskId);
    await redis.expire(key, REGISTRY_TTL_SECONDS);
}

export async function unregisterActiveFileChangesTask(redis: Redis, repository: string, taskId: string): Promise<void> {
    await redis.zrem(activeFileChangesTasksKey(repository), taskId);
}

/** Task ids with a live capture on the repository; stale registrations are dropped. */
export async function listActiveFileChangesTasks(redis: Redis, repository: string, now = Date.now()): Promise<string[]> {
    const key = activeFileChangesTasksKey(repository);
    await redis.zremrangebyscore(key, '-inf', now - ACTIVE_TASK_STALE_MS);
    return redis.zrange(key, 0, -1);
}

function parseChangedPaths(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const data = JSON.parse(raw) as Partial<FileChangesData>;
        return Array.isArray(data.files) ? data.files.map(file => file?.path).filter((path): path is string => typeof path === 'string') : [];
    } catch {
        return [];
    }
}

/** Changed paths last captured for each task, read in one round trip. */
export async function readChangedPaths(redis: Redis, taskIds: readonly string[]): Promise<Map<string, string[]>> {
    if (!taskIds.length) return new Map();
    const values = await redis.mget(...taskIds.map(taskId => `${FILE_CHANGES_PREFIX}${taskId}`));
    return new Map(taskIds.map((taskId, index) => [taskId, parseChangedPaths(values[index] ?? null)]));
}

type TaskRow = { task_id: string; issue_number: number | null; task_type: string | null };

async function loadTaskRows(database: Knex, taskIds: string[]): Promise<Map<string, TaskRow>> {
    if (!taskIds.length) return new Map();
    const rows = await database('tasks').whereIn('task_id', taskIds).select('task_id', 'issue_number', 'task_type') as TaskRow[];
    return new Map(rows.map(row => [row.task_id, row]));
}

/** "issue #12" / "PR #34" / the bare task id when the task has no number. */
export function describeTask(taskId: string, row?: { issue_number?: number | null; task_type?: string | null } | null): string {
    if (!row?.issue_number) return `task ${taskId}`;
    const kind = row.task_type && /pr|pull/i.test(row.task_type) ? 'PR' : 'issue';
    return `task ${taskId} (${kind} #${row.issue_number})`;
}

/** Durable receipt stored in the timeline entry's metadata: one entry per recipient and task pair. */
const pairReceipt = (repository: string, [a, b]: [string, string]) => `${repositoryKey(repository)}:${a}:${b}`;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

/**
 * Writes the overlap entry on one task's timeline unless that task already has it. The receipt
 * check and the insert share one transaction, so a retry after a partial delivery only writes
 * the missing entries. Returns whether an entry was written.
 */
interface OverlapTimelineEntry { taskId: string; receipt: string; reason: string; metadata: Record<string, unknown> }

async function appendOverlapTimelineEvent(database: Knex, { taskId, receipt, reason, metadata }: OverlapTimelineEntry): Promise<boolean> {
    // Repeat the latest state so the entry never changes the task's derived state.
    return database.transaction(async trx => {
        const marker = `"fileOverlapReceipt":${JSON.stringify(receipt)}`;
        const existing = await trx('task_history').where({ task_id: taskId })
            .andWhereRaw("metadata LIKE ? ESCAPE '\\'", [`%${escapeLike(marker)}%`]).first('history_id');
        if (existing) return false;
        const latest = await trx('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state');
        if (!latest) return false;
        await trx('task_history').insert({
            task_id: taskId, state: latest.state, timestamp: new Date().toISOString(), reason,
            metadata: JSON.stringify({ ...metadata, fileOverlapReceipt: receipt }),
        });
        return true;
    }, replayableTransaction());
}

export interface CheckRepositoryFileOverlapsOptions {
    redis: Redis;
    repository: string;
    database?: Knex;
    hotPaths?: readonly string[];
    now?: number;
    /** Skip the 30-second throttle: the final comparison of a run that is about to stop. */
    force?: boolean;
}

/**
 * Compares the live changes of every active task on the repository. Skipped when fewer
 * than two tasks are active and throttled to one run per repository every 30 seconds
 * (unless forced).
 */
export async function checkRepositoryFileOverlaps(options: CheckRepositoryFileOverlapsOptions): Promise<OverlapCheckResult> {
    const { redis, repository } = options;
    // Loaded lazily: the shared connection opens the database as soon as it is imported.
    const database = options.database ?? (await import('../db/connection.js')).db;
    const active = await listActiveFileChangesTasks(redis, repository, options.now);
    if (active.length < 2) return { status: 'single_task', newPairs: [] };
    if (!options.force) {
        const acquired = await redis.set(throttleKey(repository), String(options.now ?? Date.now()), 'EX', OVERLAP_CHECK_INTERVAL_SECONDS, 'NX');
        if (acquired !== 'OK') return { status: 'throttled', newPairs: [] };
    }

    const changed = await readChangedPaths(redis, active);
    const overlaps = computeFileOverlaps(active.map(taskId => ({ taskId, paths: changed.get(taskId) ?? [] })), { hotPaths: options.hotPaths ?? configuredHotPaths() });
    const rows = await loadTaskRows(database, active);
    const computedAt = new Date(options.now ?? Date.now()).toISOString();

    for (const taskId of active) {
        const stored: StoredOverlaps = {
            repository, computedAt,
            overlaps: overlapsForTask(overlaps, taskId).map(({ otherTaskId, paths }) => ({
                taskId: otherTaskId, ...boundOverlapPaths(paths), repository,
                issueNumber: rows.get(otherTaskId)?.issue_number ?? null, taskType: rows.get(otherTaskId)?.task_type ?? null,
            })),
        };
        await redis.setex(`${OVERLAPS_PREFIX}${taskId}`, OVERLAPS_TTL_SECONDS, JSON.stringify(stored));
    }

    const newPairs: Array<[string, string]> = [];
    for (const overlap of overlaps) {
        // The pair marker is set only once both timelines hold the entry; until then later
        // comparisons retry, and the per-recipient receipt keeps the retry from duplicating.
        const deliveredKey = pairKey(repository, overlap.taskIds);
        if (await redis.get(deliveredKey) !== null) continue;
        const lockKey = `${deliveredKey}:delivering`;
        if (await redis.set(lockKey, computedAt, 'EX', PAIR_DELIVERY_LOCK_SECONDS, 'NX') !== 'OK') continue;
        try {
            const bounded = boundOverlapPaths(overlap.paths);
            const receipt = pairReceipt(repository, overlap.taskIds);
            let delivered = true;
            let wrote = false;
            for (const [taskId, otherTaskId] of [overlap.taskIds, [overlap.taskIds[1], overlap.taskIds[0]]]) {
                const reason = `Also being changed by ${describeTask(otherTaskId, rows.get(otherTaskId))}: ${describeOverlapPaths(bounded.paths, bounded.totalPaths)}`;
                try {
                    wrote = await appendOverlapTimelineEvent(database, {
                        taskId, receipt, reason,
                        metadata: { description: reason, fileOverlap: { otherTaskId, repository, issueNumber: rows.get(otherTaskId)?.issue_number ?? null, ...bounded } },
                    }) || wrote;
                } catch (error) {
                    delivered = false;
                    logger.warn({ taskId, otherTaskId, error: (error as Error).message }, 'Could not record file overlap timeline event; will retry');
                }
            }
            if (wrote) newPairs.push(overlap.taskIds);
            if (delivered) await redis.set(deliveredKey, computedAt, 'EX', PAIR_TTL_SECONDS);
        } finally {
            await redis.del(lockKey).catch(() => undefined);
        }
    }
    return { status: 'checked', newPairs };
}

/** The two reads the overlap projection needs; ioredis satisfies it, node-redis via a small adapter. */
export interface FileOverlapReader {
    get(key: string): Promise<string | null>;
    zscore(key: string, member: string): Promise<string | number | null>;
}

/** Overlaps from the latest comparison whose tasks are both still active; empty when none. */
export async function getCurrentFileOverlaps(redis: FileOverlapReader, taskId: string, now = Date.now()): Promise<TaskFileOverlap[]> {
    try {
        const raw = await redis.get(`${OVERLAPS_PREFIX}${taskId}`);
        if (!raw) return [];
        const stored = JSON.parse(raw) as StoredOverlaps;
        if (!stored?.repository || !Array.isArray(stored.overlaps) || !stored.overlaps.length) return [];
        const key = activeFileChangesTasksKey(stored.repository);
        const live = (score: string | number | null) => score !== null && Number(score) > now - ACTIVE_TASK_STALE_MS;
        if (!live(await redis.zscore(key, taskId))) return [];
        const result: TaskFileOverlap[] = [];
        for (const overlap of stored.overlaps) {
            if (live(await redis.zscore(key, overlap.taskId))) result.push(overlap);
        }
        return result;
    } catch (error) {
        logger.debug({ taskId, error: (error as Error).message }, 'Could not read current file overlaps');
        return [];
    }
}

export interface LiveFileChangesCaptureOptions {
    taskId: string;
    worktreePath: string;
    repository: string;
    redis: Redis;
    intervalMs?: number;
    /** Longest `stop()` waits for in-flight and final work before releasing the run (default 10s). */
    stopTimeoutMs?: number;
    log?: { debug: (obj: object, msg: string) => void; warn?: (obj: object, msg: string) => void };
    /** Seams for tests. */
    capture?: (taskId: string, worktreePath: string) => Promise<unknown>;
    checkOverlaps?: (options: CheckRepositoryFileOverlapsOptions) => Promise<OverlapCheckResult>;
}

/**
 * The periodic live changed-file capture shared by issue implementation, PR follow-up and
 * `/fix` runs: writes `task:file-changes:<taskId>`, keeps the run registered as active on
 * its repository and runs the (throttled) overlap comparison. Failures are logged only.
 */
export interface LiveFileChangesCaptureHandle {
    tick: () => Promise<void>;
    /**
     * Ends the capture. While the run is still registered it optionally records the worktree
     * once more (`finalCapture`), then runs an unthrottled comparison so an overlap that arose
     * during a throttled window is not lost, and only then unregisters the run. Bounded by
     * `stopTimeoutMs`: past it the remaining capture and comparison are skipped and the run
     * resolves, so an unreachable Redis never holds the agent run's completion.
     */
    stop: (options?: { finalCapture?: boolean }) => Promise<void>;
}

export const LIVE_CAPTURE_STOP_TIMEOUT_MS = 10_000;

export function startLiveFileChangesCapture(options: LiveFileChangesCaptureOptions): LiveFileChangesCaptureHandle {
    const { taskId, worktreePath, repository, redis } = options;
    const capture = options.capture ?? updateFileChangesFromWorktree;
    const checkOverlaps = options.checkOverlaps ?? checkRepositoryFileOverlaps;
    let running: Promise<void> | null = null;
    let stopped = false;
    // Set once stop() gives up waiting: work still pending afterwards must not record, register or compare.
    let abandoned = false;
    const unregister = () => unregisterActiveFileChangesTask(redis, repository, taskId).catch(() => undefined);
    const tick = () => running ??= (async () => {
        try {
            await capture(taskId, worktreePath);
            if (stopped) return;
            await registerActiveFileChangesTask(redis, repository, taskId);
            if (stopped) return;
            await checkOverlaps({ redis, repository });
        } catch (error) {
            options.log?.debug({ taskId, error: (error as Error).message }, 'Periodic file changes update failed');
        }
    })().finally(() => { running = null; });
    const interval = setInterval(() => { void tick(); }, options.intervalMs ?? 2000);
    interval.unref?.();

    const shutdown = async (finalCapture: boolean) => {
        await running?.catch(() => undefined);
        if (finalCapture && !abandoned) {
            try {
                await capture(taskId, worktreePath);
            } catch (error) {
                (options.log?.warn ?? options.log?.debug)?.call(options.log, { taskId, error: (error as Error).message }, 'Failed to capture file changes');
            }
        }
        try {
            if (!abandoned) await registerActiveFileChangesTask(redis, repository, taskId);
            if (!abandoned) await checkOverlaps({ redis, repository, force: true });
        } catch (error) {
            options.log?.debug({ taskId, error: (error as Error).message }, 'Final file overlap check failed');
        }
        // Always last, so a registration made by work that outlived the deadline is still removed.
        await unregister();
    };

    return {
        tick,
        stop: async ({ finalCapture = false } = {}) => {
            stopped = true;
            clearInterval(interval);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<'timeout'>(resolve => {
                timer = setTimeout(() => resolve('timeout'), options.stopTimeoutMs ?? LIVE_CAPTURE_STOP_TIMEOUT_MS);
                timer.unref?.();
            });
            try {
                if (await Promise.race([shutdown(finalCapture).then(() => 'done' as const), deadline]) === 'timeout') {
                    abandoned = true;
                    (options.log?.warn ?? options.log?.debug)?.call(options.log, { taskId }, 'File changes capture did not stop in time; continuing without the final overlap check');
                    // Queued behind any pending registration on the same connection; the stale window drops it otherwise.
                    void unregister();
                }
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
