/**
 * Authorized follow-up requests for PR reviews.
 *
 * A review judges the PR against its original objective, but a person may
 * later ask ProPR to change that behavior on the same PR (a GitHub follow-up
 * comment or a Desktop/API follow-up). Without those requests the reviewer
 * treats the requested change as a regression against the original objective.
 *
 * Only requests ProPR itself accepted and completed count. The evidence is the
 * trailing footer of a completion comment authored by the authenticated ProPR
 * identity: its `phase=completed` work-evidence marker names the trigger
 * comments that passed the follow-up author, assignment and API authorization
 * gates, and an accepted-request marker binds each one to a digest of the body
 * the run accepted. A request counts only while its current body still matches
 * that digest, so an edit never inherits an earlier run's completion. Marker
 * text anywhere else — inside a review, a fenced example, an agent summary —
 * is not evidence. Anything else in the comment history — prior reviews, bot
 * summaries, review suggestions, unprocessed or untrusted comments — never
 * becomes a requirement here merely by appearing on the PR.
 */

import { buildCommandMeta, parseSlashCommand } from '@propr/core';
import { parseFixCommand } from './reviewFindingSelector.js';
import { acceptedRequestDigest } from '../shared/workEvidenceMarker.js';

export interface FollowupSourceComment {
    id: number;
    user: { login: string; type?: string } | null;
    body?: string | null;
    created_at: string;
}

export interface AuthorizedFollowupRequest {
    commentId: number;
    createdAt: string;
    /** GitHub login of the person, or undefined for a ProPR API follow-up. */
    requester?: string;
    /** The requested behavior change, without command lines or ProPR markers. */
    text: string;
}

/**
 * A completed request that is withheld from the review because its completion
 * does not bind the body now on GitHub: `unbound` when the completion carries
 * no accepted-request digest (older completions, partial runs, completions
 * without an executed run), `edited` when the body changed after it was accepted.
 */
export interface UnverifiedFollowupRequest {
    commentId: number;
    reason: 'unbound' | 'edited';
}

export interface FollowupRequestEvidence {
    requests: AuthorizedFollowupRequest[];
    unverified: UnverifiedFollowupRequest[];
}

const FOOTER_MARKER_LINE = /^<!-- propr:(?:work-evidence|accepted-request) [^>]*-->$/;
const COMPLETED_EVIDENCE = /^<!-- propr:work-evidence phase=completed trigger-comment-ids=(\d+(?:,\d+)*) -->$/;
const ACCEPTED_REQUEST = /^<!-- propr:accepted-request comment-id=(\d+) body-sha256=([a-f0-9]{64}) -->$/;
// Mirrors `prepareApiFollowup`: the API registers and posts the request as the bot.
const API_FOLLOWUP_MARKER = /\n\n<!-- propr-api-followup:[a-f0-9-]{36} -->$/;

function positiveId(value: string): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The contiguous marker lines that end a comment, which is where ProPR writes its completion footer. */
function footerMarkerLines(body: string): string[] {
    const lines = body.replace(/\r\n?/g, '\n').trimEnd().split('\n');
    let start = lines.length;
    while (start > 0 && FOOTER_MARKER_LINE.test(lines[start - 1])) start--;
    return lines.slice(start);
}

/** Completed trigger IDs and, per ID, the accepted-body digests its completion bound. */
function completionEvidence(comments: readonly FollowupSourceComment[], botLogin: string): Map<number, Set<string>> {
    const completed = new Map<number, Set<string>>();
    for (const comment of comments) {
        if (comment.user?.login !== botLogin || !comment.body) continue;
        const footer = footerMarkerLines(comment.body);
        const ids = new Set<number>();
        for (const line of footer) {
            for (const id of COMPLETED_EVIDENCE.exec(line)?.[1].split(',') ?? []) {
                const parsed = positiveId(id);
                if (parsed !== null) ids.add(parsed);
            }
        }
        for (const id of ids) if (!completed.has(id)) completed.set(id, new Set());
        for (const line of footer) {
            const match = ACCEPTED_REQUEST.exec(line);
            const id = match ? positiveId(match[1]) : null;
            // A binding counts only for a trigger the same footer completed.
            if (match && id !== null && ids.has(id)) completed.get(id)!.add(match[2]);
        }
    }
    return completed;
}

/**
 * The behavior a completed trigger comment asked for. Review, merge and
 * Ultrafix commands request no behavior change, and `/fix` selectors only name
 * review records, so selected review prose is never imported as a requirement.
 * The person's own request is the `/fix` instruction prose execution receives,
 * or the prose below a `/use` or `/switch` command line.
 */
function requestedText(body: string): string {
    const command = parseSlashCommand(body);
    if (!command) return body.trim();
    const meta = buildCommandMeta(command);
    // Inline (`/fix S1; change row20`) and following-line prose, never selectors.
    if (meta.mode === 'fix') return parseFixCommand(meta).instructions;
    return meta.mode === 'use' || meta.mode === 'switch' ? meta.instructions.trim() : '';
}

/**
 * Follow-up requests ProPR accepted and completed on this PR, newest first,
 * plus the completed requests withheld because their completion does not bind
 * their current body. `botLogin` must be the authenticated ProPR identity;
 * completion markers in any other author's comment are ignored.
 */
export function collectFollowupRequestEvidence(
    comments: readonly FollowupSourceComment[],
    botLogin: string | undefined,
): FollowupRequestEvidence {
    if (!botLogin) return { requests: [], unverified: [] };
    const completed = completionEvidence(comments, botLogin);
    const requests: AuthorizedFollowupRequest[] = [];
    const unverified: UnverifiedFollowupRequest[] = [];
    for (const comment of comments) {
        const boundDigests = completed.get(comment.id);
        if (!boundDigests || !comment.body || !comment.user) continue;
        let body = comment.body;
        let requester: string | undefined = comment.user.login;
        if (requester === botLogin) {
            // A bot-authored trigger is only a request when the API posted it.
            if (!API_FOLLOWUP_MARKER.test(body)) continue;
            body = body.replace(API_FOLLOWUP_MARKER, '');
            requester = undefined;
        }
        const text = requestedText(body);
        if (!text) continue;
        if (boundDigests.size === 0) {
            unverified.push({ commentId: comment.id, reason: 'unbound' });
        } else if (!boundDigests.has(acceptedRequestDigest(comment.body))) {
            unverified.push({ commentId: comment.id, reason: 'edited' });
        } else {
            requests.push({ commentId: comment.id, createdAt: comment.created_at, requester, text });
        }
    }
    requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.commentId - a.commentId);
    return { requests, unverified };
}

/** The authorized requests alone; see `collectFollowupRequestEvidence`. */
export function collectAuthorizedFollowupRequests(
    comments: readonly FollowupSourceComment[],
    botLogin: string | undefined,
): AuthorizedFollowupRequest[] {
    return collectFollowupRequestEvidence(comments, botLogin).requests;
}

/** Prompt text for the review's authorized follow-up section; empty when there are none. */
export function formatAuthorizedFollowupRequests(requests: readonly AuthorizedFollowupRequest[]): string {
    return requests.map(request => {
        const source = request.requester ? `requested by @${request.requester}` : 'submitted through ProPR by an authorized user';
        return `---\n**Follow-up request** (comment ${request.commentId}, ${request.createdAt}, ${source})\n${request.text}\n---\n`;
    }).join('');
}
