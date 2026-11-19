/**
 * What ProPR did about the latest infrastructure-only CI failure of a pull
 * request, kept in Redis so the status block can say it (pullRequestStatusFacts).
 * Dependency-free so the status reads can import it without a cycle.
 */

export type CiInfrastructureNoticeAction =
    /** The failed jobs were re-run. */
    | 'rerun_requested'
    /** The workflow run was still running; its failed jobs are re-run once it finishes. */
    | 'rerun_deferred'
    /** Re-running was refused, or the one re-run was already spent: a person has to look. */
    | 'rerun_unavailable';

export interface CiInfrastructureNotice {
    headSha: string;
    /** The failed job (check) name. */
    job: string;
    runId: number;
    runAttempt?: number;
    action: CiInfrastructureNoticeAction;
    at: number;
}

const ACTIONS = new Set<CiInfrastructureNoticeAction>(['rerun_requested', 'rerun_deferred', 'rerun_unavailable']);

/** Notices outlive no head for long: a new push makes them obsolete anyway. */
export const CI_INFRASTRUCTURE_NOTICE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function ciInfrastructureNoticeKey(repository: string, prNumber: number): string {
    return `propr:ci-infra-notice:${repository.toLowerCase()}#${prNumber}`;
}

export function parseCiInfrastructureNotice(raw: string | null | undefined): CiInfrastructureNotice | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<CiInfrastructureNotice>;
        if (typeof value.headSha !== 'string' || typeof value.job !== 'string' || typeof value.runId !== 'number') return null;
        if (!value.action || !ACTIONS.has(value.action)) return null;
        return {
            headSha: value.headSha, job: value.job, runId: value.runId, action: value.action,
            at: typeof value.at === 'number' ? value.at : 0,
            ...(typeof value.runAttempt === 'number' ? { runAttempt: value.runAttempt } : {}),
        };
    } catch {
        return null;
    }
}
