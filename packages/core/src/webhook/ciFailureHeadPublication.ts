/**
 * Publication of the single CI-failure comment of a pull request head: find
 * it (Redis-remembered id, else a marker scan), merge a later failure into it,
 * or post it, all under a short per-head Redis lock.
 */
import { getBotUsername } from '../daemon/configLoader.js';
import type logger from '../utils/logger.js';
import { withRetry } from '../utils/retryHandler.js';
import {
    mergeCiFailureEntry, parseCiFailureEntries, parseOmittedCiFailureCount, renderCiFailureHeadComment,
    type CiFailureEntry,
} from './ciFailureHeadComment.js';
import {
    buildCiFailureFollowupMarker, CI_FAILURE_DEDUPE_TTL_SECONDS, failureLogContext, isRecord,
    type CiFailureFollowupRequest, type CiFailureOctokit, type DedupeRedis,
} from './ciFailureFollowup.js';

const HEAD_LOCK_TTL_SECONDS = 30;
const HEAD_LOCK_RENEW_MS = 10_000;
/** Longer than the TTL: a crashed holder's lock lapses before a waiter gives up. */
const HEAD_LOCK_WAIT_MS = 40_000;

type Log = ReturnType<typeof logger.withCorrelation>;

export interface CiFailureFollowupTiming {
    sleep?: (ms: number) => Promise<void>;
    lockWaitMs?: number;
}

function configuredBotUsernames(): Set<string> {
    return new Set([getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter(Boolean) as string[]);
}

interface HeadComment { id: number; body: string }

/** The head comment could not be confirmed present or absent; posting now could add a second one. */
export class CiFailureHeadLookupError extends Error {
    constructor(headKey: string, cause?: unknown) {
        super(`Could not look up the CI-failure comment of head ${headKey}; not posting a new one`);
        this.name = 'CiFailureHeadLookupError';
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

function isNotFound(error: unknown): boolean {
    return isRecord(error) && (error.status === 404 || error.status === 410);
}

/**
 * The comment whose id Redis remembers. `inconclusive` carries the error when
 * Redis or GitHub could not be read; a deleted comment is a confirmed miss.
 */
async function readRememberedHeadComment(
    octokit: CiFailureOctokit,
    redis: DedupeRedis,
    request: CiFailureFollowupRequest,
    headKey: string,
): Promise<{ comment: HeadComment | null; inconclusive?: unknown }> {
    let remembered: unknown;
    try {
        remembered = await redis.get(`ci-failure-followup-head:${headKey}`);
    } catch (error) {
        return { comment: null, inconclusive: error };
    }
    const rememberedId = Number(remembered);
    if (!Number.isSafeInteger(rememberedId) || rememberedId <= 0) return { comment: null };
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: request.owner, repo: request.repo, comment_id: rememberedId,
        });
        const body = isRecord(data) && typeof data.body === 'string' ? data.body : '';
        return { comment: body.includes(buildCiFailureFollowupMarker(headKey)) ? { id: rememberedId, body } : null };
    } catch (error) {
        return isNotFound(error) ? { comment: null } : { comment: null, inconclusive: error };
    }
}

/**
 * The head commit's CI-failure comment: the id Redis remembers, else a marker
 * scan of the bot's comments. `null` only when absence is confirmed; a lookup
 * that cannot complete throws, so a read failure never looks like no comment.
 */
async function findHeadComment(
    octokit: CiFailureOctokit,
    redis: DedupeRedis,
    request: CiFailureFollowupRequest,
    headKey: string,
): Promise<HeadComment | null> {
    const remembered = await readRememberedHeadComment(octokit, redis, request, headKey);
    if (remembered.comment) return remembered.comment;
    // An unreadable remembered comment leaves the decision to a completed scan.
    if (!octokit.paginate) {
        if (remembered.inconclusive !== undefined) throw new CiFailureHeadLookupError(headKey, remembered.inconclusive);
        return null;
    }
    let comments: unknown[];
    try {
        comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: request.owner, repo: request.repo, issue_number: request.prNumber, per_page: 100,
        });
    } catch (error) {
        throw new CiFailureHeadLookupError(headKey, error);
    }
    const marker = buildCiFailureFollowupMarker(headKey);
    const bots = configuredBotUsernames();
    for (const comment of comments) {
        if (!isRecord(comment) || typeof comment.body !== 'string' || !comment.body.includes(marker)) continue;
        const user = isRecord(comment.user) ? comment.user : null;
        if (user && typeof user.login === 'string' && bots.has(user.login) && typeof comment.id === 'number') {
            return { id: comment.id, body: comment.body };
        }
    }
    return null;
}

type HeadPublication = { posted: false; reason: 'merged' | 'duplicate'; body?: string } | { posted: true; reason: 'posted'; body: string };

export async function publishHeadFailure(options: {
    octokit: CiFailureOctokit;
    redis: DedupeRedis;
    request: CiFailureFollowupRequest;
    entry: CiFailureEntry;
    headKey: string;
    correlationId: string;
    log: Log;
    lease: HeadLease;
}): Promise<HeadPublication> {
    const { octokit, redis, request, entry, headKey, correlationId, log, lease } = options;
    // A lookup failure propagates: the caller releases the per-source claim so
    // the failure is delivered again, instead of posting a possible second comment.
    const existing = await findHeadComment(octokit, redis, request, headKey);
    const marker = buildCiFailureFollowupMarker(headKey);
    if (existing) {
        // A later failure of the same head joins its comment. Editing never
        // starts a second follow-up for the head (see handleCommentEdited).
        const merged = mergeCiFailureEntry(parseCiFailureEntries(existing.body), entry);
        if (!merged) return { posted: false, reason: 'duplicate' };
        const body = renderCiFailureHeadComment({
            owner: request.owner, repo: request.repo, sha: request.evidence.sha, entries: merged, marker,
            omittedCount: parseOmittedCiFailureCount(existing.body),
        });
        await lease.assertHeld();
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: request.owner, repo: request.repo, comment_id: existing.id, body,
        });
        log.info({ ...failureLogContext(request), headKey, commentId: existing.id }, 'Added CI failure to the head commit CI-failure comment');
        return { posted: false, reason: 'merged', body };
    }
    const body = renderCiFailureHeadComment({ owner: request.owner, repo: request.repo, sha: request.evidence.sha, entries: [entry], marker });
    const created = await withRetry(
        async () => {
            await lease.assertHeld();
            return octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: request.owner, repo: request.repo, issue_number: request.prNumber, body,
            });
        },
        { maxAttempts: 3, baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, correlationId },
        `post_ci_failure_followup_${request.owner}_${request.repo}_${request.prNumber}`,
    );
    const commentId = isRecord(created?.data) && typeof created.data.id === 'number' ? created.data.id : null;
    if (commentId !== null) {
        await redis.set(`ci-failure-followup-head:${headKey}`, String(commentId), 'EX', CI_FAILURE_DEDUPE_TTL_SECONDS).catch(() => undefined);
    }
    return { posted: true, reason: 'posted', body };
}

/** The head lock was held by another publisher for the whole wait; nothing was published. */
export class CiFailureHeadLockTimeoutError extends Error {
    constructor(headKey: string) {
        super(`Timed out waiting for the CI-failure comment lock of head ${headKey}; not publishing without it`);
        this.name = 'CiFailureHeadLockTimeoutError';
    }
}

/** This publisher no longer owns the head lock, so its read of the comment may be stale. */
export class CiFailureHeadLockLostError extends Error {
    constructor(headKey: string) {
        super(`Lost the CI-failure comment lock of head ${headKey} before writing; not publishing`);
        this.name = 'CiFailureHeadLockLostError';
    }
}

/** Confirms, and extends, the head lock right before a GitHub write. */
export interface HeadLease { assertHeld(): Promise<void> }

type HeadLockRedis = DedupeRedis & { eval?: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown> };

const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Renews the lock while it still carries `token`; false once another publisher owns it or it lapsed. */
async function renewHeadLock(redis: HeadLockRedis, lockKey: string, token: string): Promise<boolean> {
    if (typeof redis.eval === 'function') {
        return Number(await redis.eval(RENEW_SCRIPT, 1, lockKey, token, HEAD_LOCK_TTL_SECONDS)) === 1;
    }
    if (await redis.get(lockKey) !== token) return false;
    return await redis.set(lockKey, token, 'EX', HEAD_LOCK_TTL_SECONDS, 'XX') === 'OK';
}

/**
 * Runs `work` while holding the head's lock, so the failures of one head are
 * merged one at a time. Contention for the whole wait (longer than the lock
 * TTL, so only a live, renewing holder can cause it) throws instead of
 * publishing unlocked; the caller then releases its per-source claim so the
 * failure can be delivered again. The lock is renewed while the work runs,
 * and `lease.assertHeld()` must be called right before each GitHub write.
 */
export async function withHeadLock<T>(
    options: { redis: HeadLockRedis; headKey: string; timing?: CiFailureFollowupTiming; log: Log },
    work: (lease: HeadLease) => Promise<T>,
): Promise<T> {
    const { redis, headKey, timing, log } = options;
    const lockKey = `ci-failure-followup-head-lock:${headKey}`;
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const sleep = timing?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + (timing?.lockWaitMs ?? HEAD_LOCK_WAIT_MS);
    let acquiredAt = Date.now();
    for (;;) {
        acquiredAt = Date.now();
        // A Redis error propagates: publishing unlocked is never the fallback.
        if (await redis.set(lockKey, token, 'EX', HEAD_LOCK_TTL_SECONDS, 'NX') === 'OK') break;
        if (Date.now() >= deadline) {
            log.warn({ headKey }, 'Head commit CI-failure comment is locked by another publisher; deferring this failure');
            throw new CiFailureHeadLockTimeoutError(headKey);
        }
        await sleep(100);
    }
    let lost = false;
    let expiresAt = acquiredAt + HEAD_LOCK_TTL_SECONDS * 1000;
    const renew = async (): Promise<boolean> => {
        if (lost) return false;
        const startedAt = Date.now();
        try {
            if (await renewHeadLock(redis, lockKey, token)) expiresAt = startedAt + HEAD_LOCK_TTL_SECONDS * 1000;
            else lost = true;
        } catch {
            // A failed renewal proves nothing yet; the lock is lost once it lapses.
        }
        if (Date.now() >= expiresAt) lost = true;
        return !lost;
    };
    const timer = setInterval(() => { void renew(); }, HEAD_LOCK_RENEW_MS);
    timer.unref?.();
    const lease: HeadLease = {
        assertHeld: async () => {
            if (!await renew()) throw new CiFailureHeadLockLostError(headKey);
        },
    };
    try {
        return await work(lease);
    } finally {
        clearInterval(timer);
        if (typeof redis.eval === 'function') {
            await redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch(() => undefined);
        } else if (await redis.get(lockKey).catch(() => null) === token) {
            await redis.del(lockKey).catch(() => undefined);
        }
    }
}
