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
 * (`ciFailureCommentGrouping.ts`): two notices arriving together can both
 * post, and any read or edit failure falls back to posting, so no notice is
 * dropped.
 */
import { createHash } from 'node:crypto';

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
const MAX_COMMENT_PAGES = 10;

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

/** The latest bot-authored comment carrying this notice's marker, if any. */
export function findRepeatedNotice(
    comments: unknown[], notice: RepeatedNotice,
    { excludeCommentId, notBefore }: { excludeCommentId?: number; notBefore?: number } = {},
): ExistingNotice | null {
    const identity = markerIdentity(notice.kind, repeatedNoticeKey(notice));
    let found: ExistingNotice | null = null;
    for (const comment of comments) {
        if (typeof comment !== 'object' || comment === null) continue;
        const { id, body, user, updated_at: updatedAt, created_at: createdAt } = comment as {
            id?: unknown; body?: unknown; user?: { type?: unknown } | null; updated_at?: unknown; created_at?: unknown;
        };
        if (typeof id !== 'number' || id === excludeCommentId || typeof body !== 'string') continue;
        // Only the app's own comments: a person quoting the marker is never edited.
        if (user?.type !== 'Bot') continue;
        const touched = Date.parse(String(updatedAt ?? createdAt ?? ''));
        if (notBefore !== undefined && Number.isFinite(touched) && touched < notBefore) continue;
        const at = body.lastIndexOf(identity);
        if (at === -1) continue;
        const count = Number(/count="(\d+)"/.exec(body.slice(at))?.[1] ?? '1');
        found = { id, count: Number.isFinite(count) && count > 0 ? count : 1 };
    }
    return found;
}

async function listThreadComments(octokit: NoticeOctokit, target: RepeatedNoticeTarget): Promise<unknown[]> {
    const comments: unknown[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const response = await octokit.request<{ data?: unknown }>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: target.owner, repo: target.repo, issue_number: target.issueNumber, per_page: 100, page,
        });
        const data = response?.data;
        if (!Array.isArray(data)) break;
        comments.push(...data);
        if (data.length < 100) break;
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
    try {
        existing = findRepeatedNotice(await listThreadComments(octokit, target), notice, {
            excludeCommentId: ownCommentId,
            notBefore: options.withinMs === undefined ? undefined : now.getTime() - options.withinMs,
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
    if (ownCommentId !== undefined) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: ownCommentId, body,
        });
        return { commentId: ownCommentId, repeated: false, count: 1 };
    }
    const posted = await octokit.request<{ data?: { id?: unknown } }>('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: target.owner, repo: target.repo, issue_number: target.issueNumber, body,
    });
    const id = posted?.data?.id;
    return { commentId: typeof id === 'number' ? id : null, repeated: false, count: 1 };
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
