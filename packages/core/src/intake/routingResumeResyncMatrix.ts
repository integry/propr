/**
 * The reconciliation matrix for a Routing installation suspension gap.
 *
 * While an installation is suspended GitHub neither delivers webhooks nor
 * answers API calls, so every webhook-driven transition in the gap is lost.
 * Catch-up converges on CURRENT GitHub state: it does not, and cannot, replay the
 * chronological webhook stream. Each supported event/transition is mapped to the
 * reconciliation family that recovers its effect from current state, or is
 * explicitly documented as unrecoverable when its historical occurrence leaves
 * no trace that current state can reconstruct.
 */

import type { WebhookEventType } from '../webhook/webhookHandler.js';

/** Per-repository families, run in this order for every tracked repository. */
export const RESYNC_REPOSITORY_FAMILIES = [
    /** Installation repository access, recorded as authoritative current state (never a skip). */
    'repository_access',
    /**
     * Durable task intents: closures, trigger-label removals, unmerged PR
     * closures. Runs for every repository; one that lost access or left the
     * configuration is invalidated locally, without GitHub.
     */
    'task_intents',
    /** Eligible open AI-labelled issues (new, reapplied, or restorable triggers). */
    'labelled_issues',
    /** Issue and review comments on open PRs, regardless of PR comment polling. */
    'pull_request_comments',
    /** Open PR heads: check state, CI-failure follow-ups, auto-merge, Ultrafix readiness. */
    'pull_request_heads',
    /** Merge-conflict detection for open PRs (the existing safety sweep). */
    'merge_conflicts',
] as const;

/** Installation-wide families, run once every repository has converged. */
export const RESYNC_INSTALLATION_FAMILIES = [
    /** Deferred Ultrafix/CI continuations and retry obligations (full scan). */
    'ultrafix_continuations',
] as const;

export type ResyncRepositoryFamily = (typeof RESYNC_REPOSITORY_FAMILIES)[number];

/**
 * Families that need GitHub access to a configured repository. Only these may be
 * classified inapplicable, and only with recorded evidence (access lost or the
 * repository is no longer configured); every other family always runs.
 */
export const RESYNC_GITHUB_DEPENDENT_FAMILIES: readonly ResyncRepositoryFamily[] = [
    'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts',
];
export type ResyncInstallationFamily = (typeof RESYNC_INSTALLATION_FAMILIES)[number];
export type ResyncFamily = ResyncRepositoryFamily | ResyncInstallationFamily;

export interface ResyncMatrixEntry {
    event: WebhookEventType;
    /** The webhook actions/transitions this entry covers. */
    transitions: string;
    /** The family that recovers it, or null when it cannot be reconstructed. */
    family: ResyncFamily | null;
    note: string;
}

export const RESUME_RESYNC_RECONCILIATION_MATRIX: readonly ResyncMatrixEntry[] = [
    { event: 'issues', transitions: 'opened, reopened, labeled (processing trigger)', family: 'labelled_issues',
        note: 'Open issues carrying a processing label are rediscovered with timeline-verified trigger evidence.' },
    { event: 'issues', transitions: 'closed, unlabeled (processing trigger)', family: 'task_intents',
        note: 'Queued and active work whose issue is closed or no longer triggered is withdrawn.' },
    { event: 'issues', transitions: 'unlabeled (ultrafix, on a pull request)', family: 'ultrafix_continuations',
        note: 'A resumed loop re-reads the label and stops when it was removed.' },
    { event: 'issues', transitions: 'plan issue status updates', family: null,
        note: 'Unrecoverable: plan issue rows are updated from the transition itself; the next issue event or plan refresh re-reads it.' },
    { event: 'issue_comment', transitions: 'created (on a pull request)', family: 'pull_request_comments',
        note: 'Unprocessed trigger comments on open PRs are queued; processed/refused markers prevent duplicates.' },
    { event: 'issue_comment', transitions: 'edited, deleted', family: null,
        note: 'Unrecoverable: an edit or deletion inside the gap leaves no history; only the current body is visible.' },
    { event: 'pull_request_review_comment', transitions: 'created', family: 'pull_request_comments',
        note: 'Unprocessed review comments on open PRs are queued with their code context.' },
    { event: 'pull_request_review_comment', transitions: 'edited, deleted', family: null,
        note: 'Unrecoverable: an edit or deletion inside the gap leaves no history; only the current body is visible.' },
    { event: 'pull_request', transitions: 'closed (unmerged)', family: 'task_intents',
        note: 'Pending work for a PR that is now closed is withdrawn.' },
    { event: 'pull_request', transitions: 'opened, synchronize, reopened', family: 'pull_request_heads',
        note: 'The current head is evaluated for checks, CI-failure follow-ups, auto-merge and Ultrafix.' },
    { event: 'pull_request', transitions: 'opened, synchronize, edited (base)', family: 'merge_conflicts',
        note: 'Open PRs are re-evaluated for merge conflicts when auto-resolve is enabled.' },
    { event: 'pull_request', transitions: 'closed (merged): epic creation, plan PR tracking, CI cancellation', family: null,
        note: 'Unrecoverable: merge-time side effects are triggered by the transition; recorded failures still retry via their own sweeps.' },
    { event: 'check_run', transitions: 'completed', family: 'pull_request_heads',
        note: 'Latest check runs on each open PR head drive the same readiness and failure paths.' },
    { event: 'check_suite', transitions: 'completed', family: 'pull_request_heads',
        note: 'Covered by the check-run and status state of the current head.' },
    { event: 'status', transitions: 'commit status changes', family: 'pull_request_heads',
        note: 'The newest status per context on each open PR head is evaluated.' },
    { event: 'push', transitions: 'base branch pushes', family: 'merge_conflicts',
        note: 'Conflicts introduced by base pushes are detected on every open PR.' },
];

/**
 * Thrown by a `repository_access` step when the installation can no longer read
 * a repository. The runner records it as authoritative access state; from any
 * other family it is an ordinary (retried) failure.
 */
export class ResyncRepositoryInaccessibleError extends Error {
    constructor(repository: string, status?: number) {
        super(`Repository ${repository} is not accessible to the installation${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'ResyncRepositoryInaccessibleError';
    }
}

export type ResyncErrorClass =
    | { kind: 'inaccessible' }
    | { kind: 'rate_limited'; retryAt: number }
    | { kind: 'failed' };

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const value = (headers as Record<string, unknown>)[name];
    return value === undefined || value === null ? undefined : String(value);
}

/** Classify a step failure so rate limits back off until GitHub's reset. */
export function classifyResyncError(error: unknown, now: number): ResyncErrorClass {
    if (error instanceof ResyncRepositoryInaccessibleError) return { kind: 'inaccessible' };
    const err = error as { status?: unknown; message?: unknown; response?: { headers?: unknown } } | null;
    const status = typeof err?.status === 'number' ? err.status : undefined;
    const headers = err?.response?.headers;
    const message = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
    const rateLimited = status === 429
        || (status === 403 && (message.includes('rate limit') || headerValue(headers, 'x-ratelimit-remaining') === '0'));
    if (!rateLimited) return { kind: 'failed' };

    const retryAfterSeconds = Number(headerValue(headers, 'retry-after'));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return { kind: 'rate_limited', retryAt: now + retryAfterSeconds * 1000 };
    }
    const resetEpochSeconds = Number(headerValue(headers, 'x-ratelimit-reset'));
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds * 1000 > now) {
        return { kind: 'rate_limited', retryAt: resetEpochSeconds * 1000 };
    }
    return { kind: 'rate_limited', retryAt: now + DEFAULT_RATE_LIMIT_BACKOFF_MS };
}
