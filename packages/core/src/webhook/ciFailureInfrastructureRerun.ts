/**
 * Handling of an infrastructure-only CI failure (ciFailureInfrastructure):
 * no code follow-up is started, so no follow-up implementation suspends the
 * pull request's validation. Instead the failed jobs of the workflow run are
 * re-run once, and the pull request's status block says what happened. When
 * the run is still running (GitHub only re-runs jobs of a finished run), the
 * re-run is kept per workflow run (ciInfrastructureRerunPending) and sent by
 * the next completed check of the head, ordinary failure recovery, or the
 * daemon's sweep once the run has finished; when re-running
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
    CI_INFRASTRUCTURE_NOTICE_TTL_SECONDS, ciInfrastructureNoticeKey,
    type CiInfrastructureNotice, type CiInfrastructureNoticeAction,
} from './ciInfrastructureNotice.js';
import {
    CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS, listPendingReruns, readPendingRerun, recordPendingRerun, releasePendingRerun,
    withPendingRerunLock, type PendingRerunRedis, type PendingRerunSnapshot,
} from './ciInfrastructureRerunPending.js';

type Log = ReturnType<typeof logger.withCorrelation>;

export interface InfrastructureOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export type InfrastructureRedis = Pick<Redis, 'get' | 'set'> & PendingRerunRedis;

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
 * Sends a pending re-run once its workflow run has finished, under the run's
 * lock and only while the exact pending entry is still recorded, so the hook,
 * ordinary recovery and the sweep never send it twice. An entry older than
 * {@link CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS} is given up on with an
 * actionable notice instead. Returns null when another caller holds the run
 * or the entry was already released.
 */
async function resumePendingRerun(
    params: { octokit: InfrastructureOctokit; redis: InfrastructureRedis; snapshot: PendingRerunSnapshot; now?: number },
    log: Log,
): Promise<CiInfrastructureNoticeAction | null> {
    const { octokit, redis, snapshot } = params;
    const { entry } = snapshot;
    return await withPendingRerunLock(redis, entry, async () => {
        const current = await readPendingRerun(redis, `${entry.owner}/${entry.repo}`, entry.runId);
        if (!current || current.raw !== snapshot.raw) return null;
        const now = params.now ?? Date.now();
        let action: CiInfrastructureNoticeAction;
        if (now - entry.deferredAt > CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS) {
            log.warn({ ...entry }, 'A deferred runner-problem re-run waited too long for its workflow run; asking for a manual re-run');
            action = 'rerun_unavailable';
        } else {
            action = await rerunFailedJobs(octokit, { owner: entry.owner, repo: entry.repo, runId: entry.runId }, log);
            if (action === 'rerun_deferred') return action;
        }
        // Released before the notice: a failed notice write must not send the re-run again.
        await releasePendingRerun(redis, current);
        await writeNotice(redis, entry, {
            headSha: entry.headSha, job: entry.job, runId: entry.runId, runAttempt: entry.runAttempt, action, at: now,
        });
        return action;
    });
}

/**
 * Classifies the failure and, when it is infrastructure-only, re-runs it once
 * instead of starting a code follow-up. Any failure to read the evidence keeps
 * the failure a code failure (handled: false), as before. `annotations` is
 * undefined when they could not be read: without them a source-file
 * annotation that marks a code failure cannot be ruled out.
 */
export async function handleInfrastructureFailure(
    params: { octokit: InfrastructureOctokit; redis: InfrastructureRedis; request: CiFailureFollowupRequest; annotations: CiFailureAnnotation[] | undefined },
    log: Log,
): Promise<InfrastructureFailureResult> {
    const { octokit, redis, request, annotations } = params;
    const { evidence } = request;
    const notHandled: InfrastructureFailureResult = { handled: false, verdict: { infrastructure: false } };
    if (evidence.kind !== 'check_run' || !annotations) return notHandled;
    const texts = [evidence.fallbackExcerpt, ...annotations.flatMap(item => [item.title, item.message, item.raw_details])];
    if (!hasInfrastructureSignature(texts)) return notHandled;

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
        if (action === 'rerun_deferred') {
            // Kept per run, before the notice: the notice is only the latest summary and a later run may replace it.
            await recordPendingRerun(redis, {
                owner: request.owner, repo: request.repo, prNumber: request.prNumber, headSha: evidence.sha,
                job: evidence.name, runId, runAttempt, deferredAt: Date.now(),
            });
        }
    } else if (await redis.get(claimKey) === String(runAttempt)) {
        // Another failed job of the same attempt already took the one re-run, or deferred it:
        // a deferred one is sent now if its run has finished (recovery may be the only wakeup left).
        const pending = await readPendingRerun(redis, repository, runId);
        const resumed = pending ? await resumePendingRerun({ octokit, redis, snapshot: pending }, log) : null;
        return { handled: true, verdict, action: resumed ?? 'already_requested' };
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
 * Sends the re-runs of a pull request head that were deferred because their
 * workflow runs were still running, once each run has finished. Called for
 * completed checks of the head; never throws.
 */
export async function resumeDeferredInfrastructureRerun(
    params: { octokit: InfrastructureOctokit; redis: InfrastructureRedis; owner: string; repo: string; prNumber: number; headSha: string },
    log: Log,
): Promise<CiInfrastructureNoticeAction[]> {
    const { octokit, redis, owner, repo, prNumber, headSha } = params;
    const actions: CiInfrastructureNoticeAction[] = [];
    try {
        const repository = `${owner}/${repo}`.toLowerCase();
        const pending = (await listPendingReruns(redis)).filter(({ entry }) => `${entry.owner}/${entry.repo}`.toLowerCase() === repository
            && entry.prNumber === prNumber && entry.headSha.toLowerCase() === headSha.toLowerCase());
        for (const snapshot of pending) {
            const action = await resumePendingRerun({ octokit, redis, snapshot }, log);
            if (action) actions.push(action);
        }
    } catch (error) {
        log.debug({ owner, repo, prNumber, error: (error as Error).message }, 'Could not resume a deferred re-run of a runner-problem failure');
    }
    return actions;
}

interface ResumeDependencies {
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getOctokit?: () => Promise<InfrastructureOctokit>;
    redisClient?: InfrastructureRedis;
}

function lazyOctokit(dependencies: ResumeDependencies): InfrastructureOctokit {
    const getOctokit = dependencies.getOctokit
        ?? (async () => await getAuthenticatedOctokit() as unknown as InfrastructureOctokit);
    return { request: async (route, parameters) => (await getOctokit()).request(route, parameters) };
}

/**
 * Sends the re-run of a runner-problem failure that waited for its workflow
 * run to finish; called for completed checks of a pull request head. GitHub
 * is only read when such a re-run is waiting. Never throws.
 */
export async function resumeDeferredCiInfrastructureRerun(
    target: { owner: string; repo: string; prNumber: number; headSha: string },
    correlationId: string,
    dependencies: ResumeDependencies = {},
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    try {
        const isEnabled = dependencies.isEnabled ?? isAutoCiFollowupEnabledForRepository;
        if (!await isEnabled(target.owner, target.repo)) return;
        const redis = dependencies.redisClient ?? getUltrafixStateRedis();
        await resumeDeferredInfrastructureRerun({ ...target, redis, octokit: lazyOctokit(dependencies) }, log);
    } catch (error) {
        log.debug({ error: (error as Error).message }, 'Could not check for a deferred runner-problem re-run');
    }
}

/**
 * The daemon's reconciliation of deferred re-runs: the final check of a
 * workflow run can complete before GitHub marks the run finished, leaving no
 * check event to send the re-run. Each pending re-run whose pull request
 * still has that head is sent once its run has finished, or given up on with
 * an actionable notice after the maximum wait; one for a closed pull request
 * or an obsolete head is dropped. Returns how many were sent or given up on.
 */
export async function retryPendingCiInfrastructureReruns(
    dependencies: ResumeDependencies & { now?: () => number } = {},
    correlationId = `ci-infra-rerun-sweep-${Date.now()}`,
): Promise<number> {
    const log = logger.withCorrelation(correlationId);
    const isEnabled = dependencies.isEnabled ?? isAutoCiFollowupEnabledForRepository;
    const redis = dependencies.redisClient ?? getUltrafixStateRedis();
    const octokit = lazyOctokit(dependencies);
    let settled = 0;
    for (const snapshot of await listPendingReruns(redis)) {
        const { entry } = snapshot;
        try {
            if (!await isEnabled(entry.owner, entry.repo)) continue;
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner: entry.owner, repo: entry.repo, pull_number: entry.prNumber,
            });
            const pr = data as { state?: unknown; head?: { sha?: unknown } } | null;
            const headSha = typeof pr?.head?.sha === 'string' ? pr.head.sha.toLowerCase() : null;
            if (pr?.state !== 'open' || (headSha !== null && headSha !== entry.headSha.toLowerCase())) {
                // A new head or a closed pull request makes the re-run of the old head pointless.
                await withPendingRerunLock(redis, entry, async () => await releasePendingRerun(redis, snapshot));
                continue;
            }
            const action = await resumePendingRerun({ octokit, redis, snapshot, now: dependencies.now?.() }, log);
            if (action && action !== 'rerun_deferred') settled++;
        } catch (error) {
            log.warn({ ...entry, error: (error as Error).message }, 'Could not retry a deferred runner-problem re-run; keeping it for the next sweep');
        }
    }
    return settled;
}
