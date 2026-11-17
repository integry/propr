/**
 * One CI-failure comment per head commit, best effort.
 *
 * Before a new CI-failure comment is posted, the PR's comments are read once:
 * a ProPR-authored CI-failure comment carrying the same head-commit marker is
 * edited to list the new check instead of posting a second comment (which
 * would start a second follow-up run for the same commit). This is best
 * effort: two deliveries arriving together can both post, or both edit from
 * the same snapshot so the later edit drops the earlier check's entry; that is
 * accepted. Any read or edit failure falls back to posting, so no failure
 * report is dropped.
 */
import type logger from '../utils/logger.js';
import type { CancellationProvenanceOctokit } from './ciCancellationProvenance.js';

type Log = ReturnType<typeof logger.withCorrelation>;

const HEAD_MARKER_PREFIX = '<!-- propr:ci-failure-head';
const MARKER_BLOCK_START = '\n<!-- propr:ci-failure-';
const SINGLE_FAILURE_INSTRUCTION = 'Please investigate and fix this CI failure.';
const MULTIPLE_FAILURES_INSTRUCTION = 'Please investigate and fix these CI failures.';

export interface ExistingCiFailureComment {
    id: number;
    body: string;
}

export interface CiFailureCommentScan {
    /** A ProPR comment already reports this exact check on this head. */
    duplicate: boolean;
    /** The ProPR CI-failure comment for the same head commit, if any. */
    sameHead: ExistingCiFailureComment | null;
}

export function buildCiFailureHeadMarker(sha: string): string {
    return `${HEAD_MARKER_PREFIX} sha="${sha.toLowerCase()}" -->`;
}

/** Reads app-authored comments for this check's key and for this head commit. */
export function scanCiFailureComments(
    comments: unknown[],
    { dedupeKey, sha, botUsernames }: { dedupeKey: string; sha: string; botUsernames: Set<string> },
): CiFailureCommentScan {
    const keyMarker = `key="${dedupeKey}"`;
    const headMarker = buildCiFailureHeadMarker(sha);
    const scan: CiFailureCommentScan = { duplicate: false, sameHead: null };
    for (const comment of comments) {
        if (typeof comment !== 'object' || comment === null) continue;
        const { id, body, user } = comment as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
        if (typeof body !== 'string' || typeof user?.login !== 'string' || !botUsernames.has(user.login)) continue;
        if (body.includes(keyMarker)) scan.duplicate = true;
        if (!scan.sameHead && typeof id === 'number' && body.includes(headMarker)) scan.sameHead = { id, body };
    }
    return scan;
}

/**
 * Adds one check to an existing same-head comment: its name joins the title,
 * its details and evidence go after the listed ones, and its key marker joins
 * the hidden markers at the end, so redeliveries of it stay deduplicated.
 */
export function appendCheckToCiFailureComment(body: string, check: { title: string; section: string[]; marker: string }): string {
    const markerAt = body.indexOf(MARKER_BLOCK_START);
    const content = markerAt === -1 ? body.trimEnd() : body.slice(0, markerAt).trimEnd();
    const markers = markerAt === -1 ? '' : body.slice(markerAt + 1).trimEnd();
    const [title, ...rest] = content.split('\n');
    const instructionAt = rest.indexOf(SINGLE_FAILURE_INSTRUCTION);
    if (instructionAt !== -1) rest[instructionAt] = MULTIPLE_FAILURES_INSTRUCTION;
    return [
        `${title}, ${check.title}`,
        ...rest,
        '',
        '---',
        '',
        ...check.section,
        '',
        [markers, check.marker].filter(Boolean).join('\n'),
    ].join('\n');
}

/**
 * Edits the head's existing comment. Editing a ProPR CI-failure comment starts
 * no follow-up of its own (one was already requested for this commit). False
 * when the edit failed; the caller then posts a new comment instead.
 */
export async function editCiFailureComment(
    octokit: CancellationProvenanceOctokit,
    target: { owner: string; repo: string; commentId: number; body: string },
    log: Log,
): Promise<boolean> {
    try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: target.commentId, body: target.body,
        });
        log.info({ owner: target.owner, repo: target.repo, commentId: target.commentId }, 'Listed failed check on the existing CI-failure comment for this head');
        return true;
    } catch (error) {
        log.warn({ commentId: target.commentId, error: (error as Error).message }, 'Could not add the failed check to the existing CI-failure comment; posting a new one');
        return false;
    }
}
