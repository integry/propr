/**
 * Handling of an infrastructure-only CI failure (ciFailureInfrastructure):
 * no code follow-up is started, so no follow-up implementation suspends the
 * pull request's validation. Instead the failed jobs of the workflow run are
 * re-run once, and the pull request's status block says what happened. When
 * the run is still running (GitHub only re-runs jobs of a finished run), the
 * re-run is deferred to the next completed check of the head; when re-running
 * is refused or the one re-run was already spent, the status block says the
 * failure looks like a runner problem and names the job.
 */
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isAutoCiFollowupEnabledForRepository } from '../daemon/configLoader.js';
import logger from '../utils/logger.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';
import { requestPullRequestStatusSync } from '../services/pullRequestStatus/pullRequestStatusSignal.js';
import type { CiFailureAnnotation, CiFailureFollowupRequest } from './ciFailureFollowup.js';
import { classifyCiInfrastructureFailure, hasInfrastructureSignature, type CiInfrastructureVerdict } from './ciFailureInfrastructure.js';
import {
    CI_INFRASTRUCTURE_NOTICE_TTL_SECONDS, ciInfrastructureNoticeKey, parseCiInfrastructureNotice,
    type CiInfrastructureNotice, type CiInfrastructureNoticeAction,
} from './ciInfrastructureNotice.js';

type Log = ReturnType<typeof logger.withCorrelation>;

export interface InfrastructureOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export type InfrastructureRedis = Pick<Redis, 'get' | 'set'>;

const ACTIONS_RUN_URL_RE = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/u;
const FAILED_STEP_CONCLUSIONS = new Set(['failure', 'timed_out']);
const RERUN_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

interface ActionsJob {
    run_id?: number;
    run_attempt?: number;
    name?: string;
    steps?: Array<{ name?: unknown; conclusion?: unknown }>;
}

export interface InfrastructureFailureResult {
    /** True when the failure is infrastructure-only: no code follow-up must be started for it. */
    handled: boolean;
    verdict: CiInfrastructureVerdict;
    action?: CiInfrastructureNoticeAction | 'already_requested';
}

function rerunClaimKey(repository: string, runId: number): string {
    return `propr:ci-infra-rerun:${repository.toLowerCase()}:${runId}`;
}

async function loadJob(octokit: InfrastructureOctokit, request: CiFailureFollowupRequest): Promise<{ job: ActionsJob; runId: number } | null> {
    const match = ACTIONS_RUN_URL_RE.exec(request.evidence.url);
    const jobId = match?.[2] ? Number(match[2]) : request.evidence.checkRunId;
    if (!jobId) return null;
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', {
        owner: request.owner, repo: request.repo, job_id: jobId,
    });
    const job = (data ?? {}) as ActionsJob;
    const runId = typeof job.run_id === 'number' ? job.run_id : (match ? Number(match[1]) : NaN);
    return Number.isSafeInteger(runId) && runId > 0 ? { job, runId } : null;
}

function failedSteps(job: ActionsJob): string[] | null {
    if (!Array.isArray(job.steps)) return null;
    return job.steps
        .filter(step => typeof step.conclusion === 'string' && FAILED_STEP_CONCLUSIONS.has(step.conclusion))
        .map(step => (typeof step.name === 'string' ? step.name : ''));
}

async function writeNotice(
    redis: InfrastructureRedis, target: { owner: string; repo: string; prNumber: number }, notice: CiInfrastructureNotice,
): Promise<void> {
    const repository = `${target.owner}/${target.repo}`;
    await redis.set(ciInfrastructureNoticeKey(repository, target.prNumber), JSON.stringify(notice), 'EX', CI_INFRASTRUCTURE_NOTICE_TTL_SECONDS);
    requestPullRequestStatusSync(repository, target.prNumber);
}

/** Re-runs the failed jobs of a finished run; 'rerun_deferred' while it still runs, 'rerun_unavailable' when GitHub refuses. */
async function rerunFailedJobs(
    octokit: InfrastructureOctokit, target: { owner: string; repo: string; runId: number }, log: Log,
): Promise<CiInfrastructureNoticeAction> {
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
            owner: target.owner, repo: target.repo, run_id: target.runId,
        });
        if ((data as { status?: unknown } | null)?.status !== 'completed') return 'rerun_deferred';
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', {
            owner: target.owner, repo: target.repo, run_id: target.runId,
        });
        log.info({ ...target }, 'Re-ran the failed jobs of a workflow run that failed on a runner problem');
        return 'rerun_requested';
    } catch (error) {
        log.warn({ ...target, error: (error as Error).message }, 'Could not re-run the failed jobs of a workflow run that failed on a runner problem');
        return 'rerun_unavailable';
    }
}

/**
 * Classifies the failure and, when it is infrastructure-only, re-runs it once
 * instead of starting a code follow-up. Any failure to read the evidence keeps
 * the failure a code failure (handled: false), as before.
 */
export async function handleInfrastructureFailure(
    params: { octokit: InfrastructureOctokit; redis: InfrastructureRedis; request: CiFailureFollowupRequest; annotations: CiFailureAnnotation[] | undefined },
    log: Log,
): Promise<InfrastructureFailureResult> {
    const { octokit, redis, request, annotations } = params;
    const { evidence } = request;
    const notHandled: InfrastructureFailureResult = { handled: false, verdict: { infrastructure: false } };
    const texts = [evidence.fallbackExcerpt, ...(annotations ?? []).flatMap(item => [item.title, item.message, item.raw_details])];
    if (evidence.kind !== 'check_run' || !hasInfrastructureSignature(texts)) return notHandled;

    let loaded: { job: ActionsJob; runId: number } | null;
    try {
        loaded = await loadJob(octokit, request);
    } catch (error) {
        log.debug({ error: (error as Error).message }, 'Could not read the failed job; treating the CI failure as a code failure');
        return notHandled;
    }
    if (!loaded) return notHandled;
    const verdict = classifyCiInfrastructureFailure({
        kind: evidence.kind, state: evidence.state, texts: [evidence.fallbackExcerpt], annotations, failedSteps: failedSteps(loaded.job),
    });
    if (!verdict.infrastructure) return { handled: false, verdict };

    const { runId, job } = loaded;
    const runAttempt = typeof job.run_attempt === 'number' ? job.run_attempt : 1;
    const repository = `${request.owner}/${request.repo}`;
    const claimKey = rerunClaimKey(repository, runId);
    const claimed = await redis.set(claimKey, String(runAttempt), 'EX', RERUN_CLAIM_TTL_SECONDS, 'NX') === 'OK';
    let action: CiInfrastructureNoticeAction;
    if (claimed) {
        action = await rerunFailedJobs(octokit, { owner: request.owner, repo: request.repo, runId }, log);
    } else if (await redis.get(claimKey) === String(runAttempt)) {
        // Another failed job of the same attempt already took the one re-run (or deferred it).
        return { handled: true, verdict, action: 'already_requested' };
    } else {
        // A later attempt failed on the runner again: the one re-run is spent.
        action = 'rerun_unavailable';
    }
    log.info({ repository, prNumber: request.prNumber, job: evidence.name, runId, runAttempt, cause: verdict.cause, step: verdict.step, action },
        'CI failure looks like a runner problem; no code follow-up is started');
    await writeNotice(redis, request, { headSha: evidence.sha, job: evidence.name, runId, runAttempt, action, at: Date.now() });
    return { handled: true, verdict, action };
}

/**
 * Sends a re-run that was deferred because its workflow run was still
 * running, once the run has finished. Called for completed checks of a
 * pull request's head; never throws.
 */
export async function resumeDeferredInfrastructureRerun(
    params: { octokit: InfrastructureOctokit; redis: InfrastructureRedis; owner: string; repo: string; prNumber: number; headSha: string },
    log: Log,
): Promise<CiInfrastructureNoticeAction | null> {
    const { octokit, redis, owner, repo, prNumber, headSha } = params;
    try {
        const notice = parseCiInfrastructureNotice(await redis.get(ciInfrastructureNoticeKey(`${owner}/${repo}`, prNumber)));
        if (notice?.action !== 'rerun_deferred' || notice.headSha.toLowerCase() !== headSha.toLowerCase()) return null;
        const action = await rerunFailedJobs(octokit, { owner, repo, runId: notice.runId }, log);
        if (action === 'rerun_deferred') return action;
        await writeNotice(redis, { owner, repo, prNumber }, { ...notice, action, at: Date.now() });
        return action;
    } catch (error) {
        log.debug({ owner, repo, prNumber, error: (error as Error).message }, 'Could not resume a deferred re-run of a runner-problem failure');
        return null;
    }
}

/**
 * Sends the re-run of a runner-problem failure that waited for its workflow
 * run to finish; called for completed checks of a pull request head. GitHub
 * is only read when such a re-run is waiting. Never throws.
 */
export async function resumeDeferredCiInfrastructureRerun(
    target: { owner: string; repo: string; prNumber: number; headSha: string },
    correlationId: string,
    dependencies: {
        isEnabled?: (owner: string, repo: string) => Promise<boolean>;
        getOctokit?: () => Promise<InfrastructureOctokit>;
        redisClient?: InfrastructureRedis;
    } = {},
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    try {
        const isEnabled = dependencies.isEnabled ?? isAutoCiFollowupEnabledForRepository;
        if (!await isEnabled(target.owner, target.repo)) return;
        const redis = dependencies.redisClient ?? getUltrafixStateRedis();
        const getOctokit = dependencies.getOctokit
            ?? (async () => await getAuthenticatedOctokit() as unknown as InfrastructureOctokit);
        const octokit: InfrastructureOctokit = { request: async (route, parameters) => (await getOctokit()).request(route, parameters) };
        await resumeDeferredInfrastructureRerun({ ...target, redis, octokit }, log);
    } catch (error) {
        log.debug({ error: (error as Error).message }, 'Could not check for a deferred runner-problem re-run');
    }
}
