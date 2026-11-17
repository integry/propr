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
const HEAD_LOCK_WAIT_MS = 15_000;

type Log = ReturnType<typeof logger.withCorrelation>;

export interface CiFailureFollowupTiming {
    sleep?: (ms: number) => Promise<void>;
    lockWaitMs?: number;
}

function configuredBotUsernames(): Set<string> {
    return new Set([getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter(Boolean) as string[]);
}

interface HeadComment { id: number; body: string }

/** The head commit's CI-failure comment: the id Redis remembers, else a marker scan. */
async function findHeadComment(
    octokit: CiFailureOctokit,
    redis: DedupeRedis,
    request: CiFailureFollowupRequest,
    headKey: string,
): Promise<HeadComment | null> {
    const marker = buildCiFailureFollowupMarker(headKey);
    const rememberedId = Number(await redis.get(`ci-failure-followup-head:${headKey}`).catch(() => null));
    if (Number.isSafeInteger(rememberedId) && rememberedId > 0) {
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: request.owner, repo: request.repo, comment_id: rememberedId,
            });
            const body = isRecord(data) && typeof data.body === 'string' ? data.body : '';
            if (body.includes(marker)) return { id: rememberedId, body };
        } catch {
            // Deleted or unreadable: fall back to the scan.
        }
    }
    if (!octokit.paginate) return null;
    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: request.owner, repo: request.repo, issue_number: request.prNumber, per_page: 100,
    });
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
}): Promise<HeadPublication> {
    const { octokit, redis, request, entry, headKey, correlationId, log } = options;
    let existing: HeadComment | null = null;
    try {
        existing = await findHeadComment(octokit, redis, request, headKey);
    } catch (error) {
        // The per-source claim still protects redeliveries; a list failure must not hide a failure.
        log.warn({ error: (error as Error).message }, 'Could not look up the head commit CI-failure comment');
    }
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
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: request.owner, repo: request.repo, comment_id: existing.id, body,
        });
        log.info({ ...failureLogContext(request), headKey, commentId: existing.id }, 'Added CI failure to the head commit CI-failure comment');
        return { posted: false, reason: 'merged', body };
    }
    const body = renderCiFailureHeadComment({ owner: request.owner, repo: request.repo, sha: request.evidence.sha, entries: [entry], marker });
    const created = await withRetry(
        () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: request.owner, repo: request.repo, issue_number: request.prNumber, body,
        }),
        { maxAttempts: 3, baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, correlationId },
        `post_ci_failure_followup_${request.owner}_${request.repo}_${request.prNumber}`,
    );
    const commentId = isRecord(created?.data) && typeof created.data.id === 'number' ? created.data.id : null;
    if (commentId !== null) {
        await redis.set(`ci-failure-followup-head:${headKey}`, String(commentId), 'EX', CI_FAILURE_DEDUPE_TTL_SECONDS).catch(() => undefined);
    }
    return { posted: true, reason: 'posted', body };
}

export async function withHeadLock<T>(
    options: { redis: DedupeRedis; headKey: string; timing?: CiFailureFollowupTiming; log: Log },
    work: () => Promise<T>,
): Promise<T> {
    const { redis, headKey, timing, log } = options;
    const lockKey = `ci-failure-followup-head-lock:${headKey}`;
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const sleep = timing?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + (timing?.lockWaitMs ?? HEAD_LOCK_WAIT_MS);
    let locked = false;
    for (;;) {
        try {
            locked = await redis.set(lockKey, token, 'EX', HEAD_LOCK_TTL_SECONDS, 'NX') === 'OK';
        } catch {
            break;
        }
        if (locked || Date.now() >= deadline) break;
        await sleep(100);
    }
    if (!locked) log.warn({ headKey }, 'Could not lock the head commit CI-failure comment; publishing without the lock');
    try {
        return await work();
    } finally {
        if (locked && await redis.get(lockKey).catch(() => null) === token) {
            await redis.del(lockKey).catch(() => undefined);
        }
    }
}
