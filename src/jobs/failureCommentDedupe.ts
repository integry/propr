/**
 * Identical failure comments on the same issue or pull request head collapse
 * into one: within an hour of the last occurrence a repeat updates the earlier
 * comment with a count instead of posting again. GitHub itself holds the state
 * (a hidden marker on the comment), so a worker restart does not reset it.
 */
import { createHash } from 'node:crypto';

export const FAILURE_COMMENT_WINDOW_MS = 60 * 60 * 1000;

const FAILURE_MARKER_RE = /\n*<!-- propr:failure-comment key="([a-f0-9]{16})" count="(\d+)" -->/;
const OCCURRENCE_NOTE_RE = /\n*_This failure has occurred \d+ times on this head; latest at [^_]+\._/;

interface FailureCommentOctokit {
    request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;
}

interface IssueCommentSummary { id: number; body?: string | null; html_url?: string; updated_at?: string }

export interface FailureCommentTarget {
    owner: string;
    repo: string;
    issueNumber: number;
}

/** Stable key of one failure: what failed, on which head, and the public cause. */
export function failureCommentKey(parts: { kind: string; headSha?: string | null; cause: string }): string {
    return createHash('sha256')
        .update(`${parts.kind}\n${parts.headSha ?? ''}\n${parts.cause.trim()}`)
        .digest('hex')
        .slice(0, 16);
}

export function failureCommentMarker(key: string, count: number): string {
    return `<!-- propr:failure-comment key="${key}" count="${count}" -->`;
}

/** Count recorded on an earlier failure comment with `key`, or null when it is another comment. */
export function failureCommentCount(body: string | null | undefined, key: string): number | null {
    const match = body?.match(FAILURE_MARKER_RE);
    return match && match[1] === key ? Number(match[2]) : null;
}

function stripFailureBookkeeping(body: string): string {
    return body.replace(FAILURE_MARKER_RE, '').replace(OCCURRENCE_NOTE_RE, '');
}

/** The body an identical failure publishes on its `count`th occurrence. */
export function renderFailureCommentBody(body: string, key: string, count: number, now: Date): string {
    const clean = stripFailureBookkeeping(body).trimEnd();
    const note = count > 1 ? `\n\n_This failure has occurred ${count} times on this head; latest at ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}._` : '';
    return `${clean}${note}\n${failureCommentMarker(key, count)}`;
}

/** Most recent comment carrying `key` that was updated within the window. */
export async function findRecentFailureComment(
    octokit: FailureCommentOctokit,
    target: FailureCommentTarget & { key: string; excludeCommentId?: number; now?: Date },
): Promise<(IssueCommentSummary & { count: number }) | null> {
    const now = target.now ?? new Date();
    const since = new Date(now.getTime() - FAILURE_COMMENT_WINDOW_MS);
    const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: target.owner, repo: target.repo, issue_number: target.issueNumber,
        since: since.toISOString(), per_page: 100,
    });
    const comments = Array.isArray(response.data) ? response.data as IssueCommentSummary[] : [];
    for (const comment of [...comments].reverse()) {
        if (comment.id === target.excludeCommentId) continue;
        if (comment.updated_at && Date.parse(comment.updated_at) < since.getTime()) continue;
        const count = failureCommentCount(comment.body, target.key);
        if (count !== null) return { ...comment, count };
    }
    return null;
}

export interface PublishFailureCommentOptions extends FailureCommentTarget {
    body: string;
    key: string;
    /** "Working on it" comment this run already posted; it becomes the failure comment when the failure is new. */
    startingCommentId?: number;
    /**
     * Receipt text the starting comment must keep (comment IDs and work-evidence
     * markers). With it a duplicate leaves the starting comment as a one-line
     * pointer; without it the starting comment is deleted.
     */
    startingCommentReceipt?: string;
    now?: Date;
}

export interface PublishFailureCommentResult {
    action: 'posted' | 'updated';
    commentId?: number;
    count: number;
}

/**
 * Publish a failure comment, or count it on the identical one posted in the
 * last hour. Lookup errors fall back to posting so a failure is never silent.
 */
export async function publishFailureComment(
    octokit: FailureCommentOctokit,
    options: PublishFailureCommentOptions,
): Promise<PublishFailureCommentResult> {
    const { owner, repo, issueNumber, key, startingCommentId } = options;
    const now = options.now ?? new Date();
    const previous = await findRecentFailureComment(octokit, { owner, repo, issueNumber, key, excludeCommentId: startingCommentId, now })
        .catch(() => null);

    if (previous) {
        const count = previous.count + 1;
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            // The earlier body keeps its own receipts; only the count changes.
            owner, repo, comment_id: previous.id, body: renderFailureCommentBody(previous.body ?? options.body, key, count, now),
        });
        if (startingCommentId) {
            if (options.startingCommentReceipt !== undefined) {
                const pointer = previous.html_url ? `[the earlier comment](${previous.html_url})` : 'the earlier comment';
                await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner, repo, comment_id: startingCommentId,
                    body: `❌ Failed again with the same error; see ${pointer} (${count} occurrences).${options.startingCommentReceipt}`,
                });
            } else {
                await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner, repo, comment_id: startingCommentId,
                });
            }
        }
        return { action: 'updated', commentId: previous.id, count };
    }

    const body = renderFailureCommentBody(options.body, key, 1, now);
    if (startingCommentId) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner, repo, comment_id: startingCommentId, body,
        });
        return { action: 'posted', commentId: startingCommentId, count: 1 };
    }
    const created = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: issueNumber, body,
    });
    return { action: 'posted', commentId: (created.data as { id?: number })?.id, count: 1 };
}

/** Best-effort head SHA of a pull request; empty when it cannot be read. */
export async function readPullRequestHeadSha(
    octokit: FailureCommentOctokit,
    target: FailureCommentTarget,
): Promise<string> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: target.owner, repo: target.repo, pull_number: target.issueNumber,
        });
        return (response.data as { head?: { sha?: string } })?.head?.sha ?? '';
    } catch {
        return '';
    }
}

/** Web UI page for a task, linked from public comments instead of log paths. */
export function taskPageUrl(taskId: string): string {
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
    return `${webUiUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}`;
}

/** Window in which the same start or cancel notice of one event is posted once. */
export const NOTICE_DEDUPE_WINDOW_MS = 30 * 1000;

export function noticeMarker(key: string): string {
    return `<!-- propr:notice key="${key}" -->`;
}

/**
 * Post a start or cancel notice unless the same notice (by key) was posted on
 * the issue within the window: several jobs reacting to one event post once.
 * A lookup failure posts, so a notice is never lost to a GitHub hiccup.
 */
export async function postNoticeOnce(
    octokit: FailureCommentOctokit,
    options: FailureCommentTarget & { body: string; kind: string; identity?: string; windowMs?: number; now?: Date },
): Promise<boolean> {
    const now = options.now ?? new Date();
    const key = createHash('sha256').update(`${options.kind}\n${options.identity ?? ''}`).digest('hex').slice(0, 16);
    const marker = noticeMarker(key);
    try {
        const since = new Date(now.getTime() - (options.windowMs ?? NOTICE_DEDUPE_WINDOW_MS));
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: options.owner, repo: options.repo, issue_number: options.issueNumber, since: since.toISOString(), per_page: 100,
        });
        const comments = Array.isArray(response.data) ? response.data as IssueCommentSummary[] : [];
        const recent = comments.some(comment => comment.body?.includes(marker)
            && (!comment.updated_at || Date.parse(comment.updated_at) >= since.getTime()));
        if (recent) return false;
    } catch {
        // Fall through and post.
    }
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: options.owner, repo: options.repo, issue_number: options.issueNumber, body: `${options.body}\n${marker}`,
    });
    return true;
}

/** `{ taskUrl }` for a completion report when the task is known. */
export function taskLinkOption(taskId: string | undefined): { taskUrl?: string } {
    return taskId ? { taskUrl: taskPageUrl(taskId) } : {};
}
