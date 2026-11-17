/**
 * The request a ProPR CI-failure comment makes. ProPR keeps one such comment
 * per head commit and edits it to add later failures of that commit, so the
 * comment's current GitHub revision, not the body captured when its follow-up
 * was queued, is the request that follow-up has to address.
 */
import { isCiFailureFollowupComment, stripCiFailureFollowupMarker } from './ciFailureFollowup.js';
import { stripKeywordsFromBody } from './commentEventHelpers.js';
import { getSystemBotUsernames } from './followupAssignmentGate.js';

export interface CiFailureRequestRevision {
    /** Body the follow-up runs on: markers and trigger keywords removed. */
    body: string;
    /** Body with only the markers removed, kept as the admission proof. */
    proofBody: string;
}

/**
 * Derives the queued request from a raw CI-failure comment body exactly as
 * intake does (marker stripped, then trigger keywords), so a revision read
 * later compares equal to the queued body when nothing changed.
 */
export function ciFailureRequestRevision(rawBody: string, keywords: readonly string[]): CiFailureRequestRevision {
    const proofBody = stripCiFailureFollowupMarker(rawBody);
    return { proofBody, body: keywords.length > 0 ? stripKeywordsFromBody(proofBody, [...keywords]) : proofBody };
}

function isSystemLogin(login: string | null | undefined): boolean {
    if (!login) return false;
    const lower = login.toLowerCase();
    return [...getSystemBotUsernames()].some(username => username.toLowerCase() === lower);
}

/**
 * The body a follow-up of a CI-failure comment must run on, read from the
 * comment as GitHub holds it now. `undefined` when the comment is not one of
 * ProPR's own CI-failure comments: only ProPR's comments carry that request,
 * and anyone can copy the marker into a comment of their own.
 */
export function currentCiFailureRequestBody(
    queued: { author?: string },
    current: { body?: string | null; user?: { login?: string } | null },
    keywords: readonly string[],
): string | undefined {
    if (!isSystemLogin(queued.author) || !isSystemLogin(current.user?.login)) return undefined;
    if (!current.body || !isCiFailureFollowupComment(current.body)) return undefined;
    return ciFailureRequestRevision(current.body, keywords).body;
}
