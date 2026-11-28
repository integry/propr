/**
 * Issue jobs use one job ID per issue (`issue-<owner>-<repo>-<number>`), so
 * BullMQ deduplicates a second request while the first is still queued. It
 * also deduplicates against a job that has already finished but is still
 * retained (failed or completed, e.g. waiting for its removal), and then the
 * request is swallowed without a trace. A finished job is no reason not to run
 * the issue again: it is removed and the new job added. A job that is still
 * live (waiting, delayed, active) keeps the request, and that is logged.
 *
 * Inspection, removal and addition are separate Redis operations, and BullMQ
 * removes a job by its ID, not by the generation that was inspected. So every
 * replacement of one job ID is serialized by a per-ID lock in Redis: a second
 * request inspects only after the first one's job was added, and finds it
 * live instead of removing it. Every caller that adds `issue-*` jobs goes
 * through this helper; a worker never brings a finished job back to life, it
 * only removes it (its retention), which the removal handles.
 */
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';

type EnqueueLog = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

const FINISHED_STATES = new Set(['failed', 'completed']);
/** BullMQ's state for a job that is gone (it vanished between `getJob` and `getState`). */
const ABSENT_STATE = 'unknown';
/** Far above the few Redis round trips a replacement takes; only bounds a crashed holder. */
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

interface ExistingJob { getState(): Promise<string>; remove(): Promise<void> }

export interface EnqueueLockClient {
    set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<unknown>;
    eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

interface EnqueueQueue<D> {
    add(name: string, data: D, opts: { jobId: string } & Record<string, unknown>): Promise<unknown>;
    getJob?(jobId: string): Promise<ExistingJob | undefined | null>;
    /** A BullMQ queue's connection and key prefix; test doubles may omit them (no serialization then). */
    client?: Promise<unknown>;
    toKey?(type: string): string;
}

export type IssueJobEnqueueOutcome =
    | { status: 'added'; replaced?: 'failed' | 'completed' }
    | { status: 'already_queued'; state: string };

async function readState<D>(queue: EnqueueQueue<D>, jobId: string): Promise<string> {
    const job = await queue.getJob!(jobId);
    return job ? job.getState() : ABSENT_STATE;
}

function alreadyQueued(log: EnqueueLog, jobId: string, state: string): IssueJobEnqueueOutcome {
    log.info({ jobId, state }, 'An issue job with this ID is still queued or running; the new request is served by it');
    return { status: 'already_queued', state };
}

async function withReplacementLock<D, T>(queue: EnqueueQueue<D>, jobId: string, run: () => Promise<T>): Promise<T> {
    if (!queue.client || typeof queue.toKey !== 'function') return run();
    const client = await queue.client as EnqueueLockClient;
    const key = queue.toKey(`issue-enqueue-lock:${jobId}`);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (await client.set(key, token, 'PX', LOCK_TTL_MS, 'NX') !== 'OK') {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for another enqueue of issue job ${jobId}`);
        await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
    }
    try {
        return await run();
    } finally {
        await client.eval(RELEASE_LOCK, 1, key, token).catch(() => {});
    }
}

export async function enqueueIssueJobReplacingFinished<D extends object>(
    queue: EnqueueQueue<D>,
    { name, data, opts }: { name: string; data: D; opts: { jobId: string } & Record<string, unknown> },
    log: EnqueueLog = logger,
): Promise<IssueJobEnqueueOutcome> {
    const { jobId } = opts;
    // Test doubles of the queue may implement only `add`.
    if (typeof queue.getJob !== 'function') {
        await queue.add(name, data, opts);
        return { status: 'added' };
    }
    return withReplacementLock(queue, jobId, async () => {
        let replaced: 'failed' | 'completed' | undefined;
        const existing = await queue.getJob!(jobId);
        const state = existing ? await existing.getState() : ABSENT_STATE;
        if (existing && FINISHED_STATES.has(state)) {
            try {
                await existing.remove();
                replaced = state as 'failed' | 'completed';
                log.info({ jobId, state }, 'Removed the finished issue job retained under this ID so the issue can run again');
            } catch (error) {
                // Gone meanwhile (its retention ran out) is fine; a finished job still there would swallow the add below.
                const after = await readState(queue, jobId);
                if (FINISHED_STATES.has(after)) {
                    log.warn({ jobId, state: after, error: (error as Error).message }, 'Could not remove the finished issue job retained under this ID');
                    throw error;
                }
                if (after !== ABSENT_STATE) return alreadyQueued(log, jobId, after);
            }
        } else if (state !== ABSENT_STATE) {
            return alreadyQueued(log, jobId, state);
        }
        await queue.add(name, data, opts);
        return replaced ? { status: 'added', replaced } : { status: 'added' };
    });
}
