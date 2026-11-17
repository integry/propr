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
