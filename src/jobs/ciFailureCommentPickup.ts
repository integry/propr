/**
 * ProPR adds later failures of a head commit to that commit's one CI-failure
 * comment, and does not restart the follow-up already queued for it. The
 * worker's read of the pull request's comments, after it claimed the job and
 * right before the request is built, is where that follow-up takes those
 * additions: it runs on the comment as GitHub holds it now, not as it was
 * when the job was queued.
 */
import type { Logger } from 'pino';
// Namespace import: suites that mock @propr/core with an enumerated export
// list keep linking; without the helper the queued body is kept.
import * as core from '@propr/core';
import { acceptedRequestDigest } from '../shared/workEvidenceMarker.js';

function followupTriggerKeywords(): string[] {
    return (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS ?? '').split(',').map(keyword => keyword.trim()).filter(Boolean);
}

/** The current request body of a ProPR CI-failure comment; `undefined` for any other comment. */
export function currentCiFailureBody(
    queued: { id: number; author?: string; body?: string },
    current: { body?: string | null; user?: { login?: string } | null },
    correlatedLogger?: Pick<Logger, 'info'>,
): string | undefined {
    const derive = (core as Partial<Pick<typeof core, 'currentCiFailureRequestBody'>>).currentCiFailureRequestBody;
    const body = typeof derive === 'function' ? derive(queued, current, followupTriggerKeywords()) : undefined;
    if (body !== undefined && body !== queued.body) {
        correlatedLogger?.info({ commentId: queued.id }, 'CI-failure comment gained entries since the job was queued, using its current content');
    }
    return body;
}

/**
 * A follow-up's receipts name the comments it handled by id, not by revision.
 * For a CI-failure comment, which ProPR keeps editing to add later failures of
 * the head, the revision a run consumed is recorded here when the run takes
 * the request, so a later revision (added while the run was in flight, or
 * after it) is not mistaken for handled work. The record is a digest of the
 * comment as GitHub held it when the run read it.
 */
const CONSUMED_REVISION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CiFailureRevisionRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

interface PullRequestRef { repoOwner: string; repoName: string; pullRequestNumber: number }
type QueuedComment = { id: number; author?: string; body?: string };
type CurrentComment = { id: number; body?: string | null; user?: { login?: string } | null };

export function consumedCiFailureRevisionKey(pr: PullRequestRef, commentId: number): string {
    return `ci-failure-consumed-revision:${pr.repoOwner}:${pr.repoName}:${pr.pullRequestNumber}:${commentId}`;
}

/** Digest of the current revision of a ProPR CI-failure comment; `undefined` for any other comment. */
export function ciFailureRevisionDigest(queued: QueuedComment, current: CurrentComment | undefined): string | undefined {
    if (!current?.body || currentCiFailureBody(queued, current) === undefined) return undefined;
    return acceptedRequestDigest(current.body);
}

function revisionsOf(comments: readonly QueuedComment[], current: readonly CurrentComment[]): Array<{ id: number; digest: string }> {
    return comments.flatMap(comment => {
        const digest = ciFailureRevisionDigest(comment, current.find(candidate => candidate.id === comment.id));
        return digest ? [{ id: comment.id, digest }] : [];
    });
}

/**
 * Ids of CI-failure comments whose current revision differs from the one a
 * run already consumed: their id-based receipts belong to an earlier revision.
 * Without a record (none consumed yet, or unreadable) the receipts decide.
 */
export async function unconsumedCiFailureRevisions(
    redis: CiFailureRevisionRedis,
    pr: PullRequestRef,
    read: { comments: readonly QueuedComment[]; current: readonly CurrentComment[]; correlatedLogger?: Pick<Logger, 'info' | 'warn'> },
): Promise<Set<number>> {
    const { comments, current, correlatedLogger } = read;
    const unconsumed = new Set<number>();
    for (const { id, digest } of revisionsOf(comments, current)) {
        let consumed: string | null;
        try {
            consumed = await redis.get(consumedCiFailureRevisionKey(pr, id));
        } catch (error) {
            correlatedLogger?.warn({ commentId: id, error: (error as Error).message }, 'Could not read the consumed revision of a CI-failure comment; its receipts decide');
            continue;
        }
        if (consumed && consumed !== digest) {
            correlatedLogger?.info({ commentId: id }, 'CI-failure comment gained failures after a run consumed it; running its current revision');
            unconsumed.add(id);
        }
    }
    return unconsumed;
}

/**
 * Record the revisions this run takes. Written before the run starts, so an
 * edit at any later point compares unequal; a write failure fails the run
 * rather than leave a later revision looking handled.
 */
export async function recordConsumedCiFailureRevisions(
    redis: CiFailureRevisionRedis,
    pr: PullRequestRef,
    comments: readonly QueuedComment[],
    current: readonly CurrentComment[],
): Promise<void> {
    for (const { id, digest } of revisionsOf(comments, current)) {
        await redis.set(consumedCiFailureRevisionKey(pr, id), digest, 'EX', CONSUMED_REVISION_TTL_SECONDS);
    }
}
