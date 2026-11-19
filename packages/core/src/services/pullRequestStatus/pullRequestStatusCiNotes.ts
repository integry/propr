/**
 * Facts for what CI cannot say for itself: a follow-up's suspension of the
 * head's validation, and a runner-problem failure ProPR re-ran instead of
 * starting a code follow-up. Both are notes, not verdicts: an unreadable
 * record leaves the note out rather than failing the status read.
 */
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { ciInfrastructureNoticeKey, parseCiInfrastructureNotice } from '../../webhook/ciInfrastructureNotice.js';
import type { PullRequestCiRunnerProblem, PullRequestCiSuspension } from './pullRequestStatus.js';

/** Mirrors `PR_CI_SUSPENSIONS_TABLE` and `SUSPENSION_ACTIVE` in the worker's src/jobs/followupCiSuspensionStore.ts. */
const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
const SUSPENSION_ACTIVE = 'active';

function sameSha(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

/** Runs the suspension cancelled and has not brought back. */
function countCancelledRuns(raw: unknown): number {
    if (typeof raw !== 'string') return 0;
    try {
        const runs = JSON.parse(raw) as unknown;
        if (!Array.isArray(runs)) return 0;
        return runs.filter(run => !!run && typeof run === 'object' && Number.isInteger((run as { id?: unknown }).id)
            && (run as { restarted?: unknown }).restarted !== true).length;
    } catch {
        return 0;
    }
}

/**
 * The active suspension of the head's validation, if any. Only `active`
 * suspends: once restoring starts, a re-run is no longer cancelled.
 */
export async function loadCiSuspensionFact(
    db: Knex, repository: string, prNumber: number, headSha: string,
): Promise<PullRequestCiSuspension | null> {
    try {
        const row = await db(PR_CI_SUSPENSIONS_TABLE)
            .where({ repository: repository.toLowerCase(), pull_request: prNumber })
            .first('head_sha', 'state', 'cancelled_runs') as { head_sha?: string; state?: string; cancelled_runs?: unknown } | undefined;
        if (!row || row.state !== SUSPENSION_ACTIVE || typeof row.head_sha !== 'string' || !sameSha(row.head_sha, headSha)) return null;
        return { cancelledRuns: countCancelledRuns(row.cancelled_runs) };
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not read the CI suspension of a pull request');
        return null;
    }
}

/** The runner-problem notice of the head (ciFailureInfrastructureRerun), if any. */
export async function loadCiRunnerProblemFact(
    redis: Pick<Redis, 'get'> | null | undefined, repository: string, prNumber: number, headSha: string,
): Promise<PullRequestCiRunnerProblem | null> {
    if (!redis) return null;
    try {
        const notice = parseCiInfrastructureNotice(await redis.get(ciInfrastructureNoticeKey(repository, prNumber)));
        if (!notice || !sameSha(notice.headSha, headSha)) return null;
        return { job: notice.job, action: notice.action };
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not read the runner-problem notice of a pull request');
        return null;
    }
}
