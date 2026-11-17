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
import { receiptConsumesRequest } from './requestReceipts.js';

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
 * ProPR keeps editing a CI-failure comment to add later failures of the head,
 * so when a run takes a revision of one, it records here the revision (a
 * digest of the comment as GitHub held it when the run read it) and the
 * ProPR receipts that consumed the comment at that moment. Those receipts
 * belong to earlier revisions. The revision counts as handled only once a
 * receipt that is not among them consumes the comment: the taking run's own
 * completion or failure notice. A run that stops before one (a usage-limit
 * retry, a capacity deferral, a lost worker) leaves the revision to run again.
 */
const CONSUMED_REVISION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CiFailureRevisionRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

interface PullRequestRef { repoOwner: string; repoName: string; pullRequestNumber: number }
type QueuedComment = { id: number; author?: string; body?: string };
type CurrentComment = { id: number; body?: string | null; user?: { login?: string } | null };
/** The pull request's issue comments, of which only ProPR's own are receipts. */
export interface CiFailureReceipts { comments: readonly CurrentComment[]; botUsername: string }
interface RevisionRead { comments: readonly QueuedComment[]; current: readonly CurrentComment[]; receipts: CiFailureReceipts }
interface TakenRevision { digest: string; earlierReceiptIds: number[] }

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

/** Ids of ProPR's receipts that consumed the comment: completion or failure notices naming it. */
function consumingReceiptIds(receipts: CiFailureReceipts, commentId: number): number[] {
    return receipts.comments
        .filter(receipt => receipt.user?.login === receipts.botUsername && receiptConsumesRequest(receipt.body, commentId))
        .map(receipt => receipt.id);
}

/** A record of another shape names no revision, so nothing it says is handled. */
function parseTakenRevision(value: string): TakenRevision | undefined {
    try {
        const parsed = JSON.parse(value) as Partial<TakenRevision> | null;
        if (typeof parsed?.digest === 'string' && Array.isArray(parsed.earlierReceiptIds) && parsed.earlierReceiptIds.every(Number.isSafeInteger)) {
            return { digest: parsed.digest, earlierReceiptIds: parsed.earlierReceiptIds };
        }
    } catch {
        // Not a record of this shape.
    }
    return undefined;
}

/**
 * Ids of CI-failure comments whose id-based receipts must not decide: the
 * current revision differs from the one a run took, or a run took it and no
 * receipt of its own consumed it yet. Without a record (no run took one) the
 * receipts decide. A failed read throws: the job retries validation rather
 * than let an earlier revision's receipt hide this one.
 */
export async function unconsumedCiFailureRevisions(
    redis: CiFailureRevisionRedis,
    pr: PullRequestRef,
    read: RevisionRead & { correlatedLogger?: Pick<Logger, 'info'> },
): Promise<Set<number>> {
    const { comments, current, receipts, correlatedLogger } = read;
    const unconsumed = new Set<number>();
    for (const { id, digest } of revisionsOf(comments, current)) {
        const value = await redis.get(consumedCiFailureRevisionKey(pr, id));
        if (value === null) continue;
        const taken = parseTakenRevision(value);
        if (taken?.digest !== digest) {
            correlatedLogger?.info({ commentId: id }, 'CI-failure comment gained failures after a run took it; running its current revision');
            unconsumed.add(id);
        } else if (!consumingReceiptIds(receipts, id).some(receiptId => !taken.earlierReceiptIds.includes(receiptId))) {
            correlatedLogger?.info({ commentId: id }, 'A run took this CI-failure revision but did not finish it; running it again');
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
    read: RevisionRead,
): Promise<void> {
    for (const { id, digest } of revisionsOf(read.comments, read.current)) {
        const taken: TakenRevision = { digest, earlierReceiptIds: consumingReceiptIds(read.receipts, id) };
        await redis.set(consumedCiFailureRevisionKey(pr, id), JSON.stringify(taken), 'EX', CONSUMED_REVISION_TTL_SECONDS);
    }
}
