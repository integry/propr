/**
 * One bot notice per issue or PR for a repeated event, best effort.
 *
 * Retries and redeliveries can report the same thing many times: a rate limit
 * on every retry of one task, a cancellation from each handler that observes
 * it, the same merge failure on every attempt against one head. Each notice
 * carries a hidden marker naming its kind and a key (the task attempt or head
 * commit, plus the notice text with timestamps removed). Before posting, the
 * thread's comments are read once: a ProPR comment with the same marker is
 * edited to the latest text with a repeat count and time instead of a new
 * comment being added. This follows the CI-failure comment grouping
 * (`ciFailureCommentGrouping.ts`), and any read or edit failure falls back
 * to posting, so no notice is dropped. Two notices arriving together (sibling
 * tasks of one issue, on different workers) can both read the thread before
 * either posts, so both post; each then re-reads the thread, and the one
 * whose comment is newer folds itself into the older one and deletes its own.
 * A comment's creator re-reads after its own creation, so the newer one always
 * sees the older and exactly one notice remains.
 */
import { createHash } from 'node:crypto';
import * as core from '@propr/core';

export interface NoticeOctokit {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
}

interface NoticeLog {
    warn: (obj: object, msg?: string) => void;
    info?: (obj: object, msg?: string) => void;
}

export interface RepeatedNoticeTarget {
    owner: string;
    repo: string;
    /** Issue or pull request number. */
    issueNumber: number;
}

export interface RepeatedNotice {
    /** Notice type, e.g. `rate-limit`, `cancelled`, `started`, `merge-conflict-failed`. */
    kind: string;
    /** What makes repeats the same event: a task id or a head commit SHA. */
    scope: string;
    /** Comment text without the marker or repeat line. */
    body: string;
    /**
     * Text that must match for a repeat; timestamps are ignored. Defaults to
     * `body`. A notice whose text legitimately changes on each repeat (a new
     * reset time) passes a fixed value so the latest text replaces the old.
     */
    fingerprint?: string;
}

export interface PublishRepeatedNoticeOptions {
    /**
     * A comment this attempt already posted (a "starting" comment) that the
     * notice would otherwise be written into. When an earlier notice is
     * updated instead, this comment is deleted so one notice remains.
     */
    ownCommentId?: number;
    /**
     * Only an earlier notice updated within this window is a repeat; an older
     * one is a past event, and a fresh comment is easier to see. Unbounded
     * when absent.
     */
    withinMs?: number;
    now?: Date;
    log?: NoticeLog;
}

export interface PublishRepeatedNoticeResult {
    commentId: number | null;
    /** True when an earlier notice was updated instead of a new one added. */
    repeated: boolean;
    count: number;
}

const MARKER_PREFIX = '<!-- propr:notice';
const COMMENTS_PER_PAGE = 100;
const DEFAULT_BOT_USERNAME = 'propr-dev[bot]';

/**
 * The logins ProPR posts as: the detected or configured App bot, as in the
 * CI-failure grouping. Read at call time, since detection runs at startup.
 */
export function proprBotUsernames(): Set<string> {
    // Namespace access: suites that mock the core module without this export still load.
    const getBotUsername = (core as { getBotUsername?: () => string | undefined }).getBotUsername;
    return new Set(
        [getBotUsername?.(), process.env.GITHUB_BOT_USERNAME, DEFAULT_BOT_USERNAME].filter((name): name is string => Boolean(name)),
    );
}

/** Removes the parts of a notice that change on every repeat of one event. */
export function normalizeNoticeText(text: string): string {
    return text
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?(?:\s*UTC)?/gi, '<time>')
        .replace(/\s+/g, ' ')
        .trim();
}

export function repeatedNoticeKey(notice: Pick<RepeatedNotice, 'kind' | 'scope' | 'body' | 'fingerprint'>): string {
    const fingerprint = normalizeNoticeText(notice.fingerprint ?? notice.body);
    return createHash('sha256').update(JSON.stringify([notice.kind, notice.scope, fingerprint])).digest('hex').slice(0, 16);
}

function markerIdentity(kind: string, key: string): string {
    return `${MARKER_PREFIX} kind="${kind}" key="${key}"`;
}

function formatRepeatTime(date: Date): string {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The comment body for the `count`th occurrence of a notice. */
export function buildRepeatedNoticeBody(notice: RepeatedNotice, count: number, now: Date = new Date()): string {
    const repeatLine = count > 1 ? `\n\n_Reported ${count} times; last at ${formatRepeatTime(now)}._` : '';
    return `${notice.body.trimEnd()}${repeatLine}\n\n${markerIdentity(notice.kind, repeatedNoticeKey(notice))} count="${count}" -->`;
}

interface ExistingNotice {
    id: number;
    count: number;
}

/** Only ProPR's own comments: the marker is copyable text, so a person or another bot quoting it is never edited. */
function isProprComment(user: { login?: unknown } | null | undefined, botUsernames: Set<string>): boolean {
    return typeof user?.login === 'string' && botUsernames.has(user.login);
}

function lastTouched(comment: { updated_at?: unknown; created_at?: unknown }): number {
    return Date.parse(String(comment.updated_at ?? comment.created_at ?? ''));
}

/** Every ProPR-authored comment carrying this notice's marker, in thread order. */
function matchingNotices(
    comments: unknown[], notice: RepeatedNotice,
    { excludeCommentId, notBefore, botUsernames = proprBotUsernames() }: { excludeCommentId?: number; notBefore?: number; botUsernames?: Set<string> } = {},
): ExistingNotice[] {
    const identity = markerIdentity(notice.kind, repeatedNoticeKey(notice));
    const found: ExistingNotice[] = [];
    for (const comment of comments) {
        if (typeof comment !== 'object' || comment === null) continue;
        const { id, body, user } = comment as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
        if (typeof id !== 'number' || id === excludeCommentId || typeof body !== 'string') continue;
        if (!isProprComment(user, botUsernames)) continue;
        const touched = lastTouched(comment);
        if (notBefore !== undefined && Number.isFinite(touched) && touched < notBefore) continue;
        const at = body.lastIndexOf(identity);
        if (at === -1) continue;
        const count = Number(/count="(\d+)"/.exec(body.slice(at))?.[1] ?? '1');
        found.push({ id, count: Number.isFinite(count) && count > 0 ? count : 1 });
    }
    return found;
}

/** The latest ProPR-authored comment carrying this notice's marker, if any. */
export function findRepeatedNotice(
    comments: unknown[], notice: RepeatedNotice,
    options: { excludeCommentId?: number; notBefore?: number; botUsernames?: Set<string> } = {},
): ExistingNotice | null {
    return matchingNotices(comments, notice, options).at(-1) ?? null;
}

/**
 * The oldest ProPR notice with this marker created before `commentId` (ids
 * grow with creation time): the one a concurrently posted duplicate folds into.
 */
export function findEarlierConcurrentNotice(
    comments: unknown[], notice: RepeatedNotice, commentId: number,
    options: { notBefore?: number; botUsernames?: Set<string> } = {},
): ExistingNotice | null {
    const earlier = matchingNotices(comments, notice, { ...options, excludeCommentId: commentId }).filter(match => match.id < commentId);
    return earlier.reduce<ExistingNotice | null>((oldest, match) => (!oldest || match.id < oldest.id ? match : oldest), null);
}

/**
 * Every comment on the thread, oldest first. The newest comments are the last
 * page, so the whole thread is read: a cap would miss a notice posted after
 * it on a long thread and post a new one on every repeat. `since` limits the
 * read to comments touched inside the repeat window when there is one.
 */
async function listThreadComments(octokit: NoticeOctokit, target: RepeatedNoticeTarget, notBefore?: number): Promise<unknown[]> {
    const comments: unknown[] = [];
    const since = notBefore === undefined ? undefined : new Date(notBefore).toISOString();
    for (let page = 1; ; page++) {
        const response = await octokit.request<{ data?: unknown }>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: target.owner, repo: target.repo, issue_number: target.issueNumber, per_page: COMMENTS_PER_PAGE, page,
            ...(since ? { since } : {}),
        });
        const data = response?.data;
        if (!Array.isArray(data)) break;
        comments.push(...data);
        if (data.length < COMMENTS_PER_PAGE) break;
    }
    return comments;
}

/**
 * Posts the notice, or updates the earlier identical one on this issue or PR.
 * The final post or edit throws on failure, as a plain comment post would.
 */
export async function publishRepeatedNotice(
    octokit: NoticeOctokit,
    target: RepeatedNoticeTarget,
    notice: RepeatedNotice,
    options: PublishRepeatedNoticeOptions = {},
): Promise<PublishRepeatedNoticeResult> {
    const { ownCommentId, log } = options;
    const now = options.now ?? new Date();
    let existing: ExistingNotice | null = null;
    const notBefore = options.withinMs === undefined ? undefined : now.getTime() - options.withinMs;
    try {
        existing = findRepeatedNotice(await listThreadComments(octokit, target, notBefore), notice, {
            excludeCommentId: ownCommentId,
            notBefore,
        });
    } catch (error) {
        log?.warn({ kind: notice.kind, error: (error as Error).message }, 'Could not read earlier notices; posting a new one');
    }

    if (existing) {
        const count = existing.count + 1;
        try {
            await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: target.owner, repo: target.repo, comment_id: existing.id, body: buildRepeatedNoticeBody(notice, count, now),
            });
            log?.info?.({ kind: notice.kind, commentId: existing.id, count }, 'Updated the earlier identical notice instead of posting a new one');
            if (ownCommentId !== undefined) await deleteOwnComment(octokit, { ...target, commentId: ownCommentId, fallbackBody: notice.body }, log);
            return { commentId: existing.id, repeated: true, count };
        } catch (error) {
            log?.warn({ kind: notice.kind, commentId: existing.id, error: (error as Error).message }, 'Could not update the earlier notice; posting a new one');
        }
    }

    const body = buildRepeatedNoticeBody(notice, 1, now);
    let commentId: number | null;
    if (ownCommentId !== undefined) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: ownCommentId, body,
        });
        commentId = ownCommentId;
    } else {
        const posted = await octokit.request<{ data?: { id?: unknown } }>('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: target.owner, repo: target.repo, issue_number: target.issueNumber, body,
        });
        const id = posted?.data?.id;
        commentId = typeof id === 'number' ? id : null;
    }
    const published: PublishRepeatedNoticeResult = { commentId, repeated: false, count: 1 };
    if (commentId === null) return published;
    return await foldConcurrentDuplicate(octokit, target, notice, { commentId, notBefore, now, log, ownCommentId }) ?? published;
}

/**
 * After a notice was published as new, folds it into an identical notice that
 * a concurrent caller, having read the thread at the same time, created before
 * it: the earlier comment gets the repeat count and this one is deleted. Only
 * the newer comment's creator acts, so the two never delete each other.
 * Returns null, keeping the published comment, when there is no earlier
 * notice, the thread cannot be re-read, or the earlier notice cannot be
 * updated (it may have been deleted meanwhile).
 */
async function foldConcurrentDuplicate(
    octokit: NoticeOctokit, target: RepeatedNoticeTarget, notice: RepeatedNotice,
    { commentId, notBefore, now, log, ownCommentId }: { commentId: number; notBefore?: number; now: Date; log?: NoticeLog; ownCommentId?: number },
): Promise<PublishRepeatedNoticeResult | null> {
    let earlier: ExistingNotice | null;
    try {
        earlier = findEarlierConcurrentNotice(await listThreadComments(octokit, target, notBefore), notice, commentId, { notBefore });
    } catch (error) {
        log?.warn({ kind: notice.kind, commentId, error: (error as Error).message }, 'Could not re-read the thread for a concurrent identical notice');
        return null;
    }
    if (!earlier) return null;
    const count = earlier.count + 1;
    try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: earlier.id, body: buildRepeatedNoticeBody(notice, count, now),
        });
    } catch (error) {
        log?.warn({ kind: notice.kind, commentId: earlier.id, error: (error as Error).message }, 'Could not update the concurrent earlier notice; keeping this one');
        return null;
    }
    if (commentId === ownCommentId) {
        await deleteOwnComment(octokit, { ...target, commentId, fallbackBody: notice.body }, log);
    } else {
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: target.owner, repo: target.repo, comment_id: commentId,
            });
        } catch (error) {
            log?.warn({ kind: notice.kind, commentId, error: (error as Error).message }, 'Could not remove the duplicate of a concurrent identical notice');
        }
    }
    log?.info?.({ kind: notice.kind, commentId: earlier.id, removedCommentId: commentId, count }, 'Folded a concurrently posted identical notice into the earlier one');
    return { commentId: earlier.id, repeated: true, count };
}

async function deleteOwnComment(
    octokit: NoticeOctokit, target: RepeatedNoticeTarget & { commentId: number; fallbackBody: string }, log?: NoticeLog,
): Promise<void> {
    const { commentId, fallbackBody } = target;
    try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: commentId,
        });
    } catch (error) {
        log?.warn({ commentId, error: (error as Error).message }, 'Could not remove the attempt comment after updating the earlier notice');
        // A left-over "starting" comment must not claim the attempt is still running.
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: commentId, body: fallbackBody,
        }).catch(() => undefined);
    }
}
