import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { parseTruthyEnvValue } from '@propr/shared';
import {
    RoutingResumeResyncCoordinator,
    createKnexResumeResyncStore,
    fetchIssuesForRepo,
    getAuthenticatedOctokit,
    getRepos,
    invalidateRepositoryIntents,
    listIntentRepositories,
    logger,
    processDetectedIssue,
    reconcileTaskIntents,
    recoverCiFailureFollowups,
    reevaluatePRAutoMerge,
    settleWithdrawalCleanups,
    sweepConflictedPullRequests,
    type ResumeResyncReconciler,
    type ResumeResyncStore,
    type ResyncRepositoryStepContext,
    type ResyncRepositoryStepResult,
} from '@propr/core';
import { pollForPullRequestComments, reconcileUltrafixForPR } from '../polling/prCommentPolling.js';
import { sweepUltrafixResumeCandidates } from '../jobs/ultrafixLoopContinuation.js';

/**
 * The daemon's executable reconciliation matrix for a Routing installation
 * suspension gap (see RESUME_RESYNC_RECONCILIATION_MATRIX in @propr/core for the
 * event-by-event mapping and the transitions that cannot be reconstructed).
 *
 * Every step reuses the existing idempotent polling/sweep path for its family,
 * in a strict mode that throws instead of logging, so a failed repository can
 * never be mistaken for a converged one. The repository set includes every
 * repository durable local work still references; one that lost access or left
 * the configuration has its task intents invalidated locally (the runner marks
 * its GitHub-dependent families inapplicable).
 */

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

interface OpenPullRequest {
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    head: { ref: string; sha?: string };
}

export interface ResumeResyncReconcilerDeps {
    redisClient: Redis;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    MODEL_LABEL_PATTERN: string;
    getOctokit?: () => Promise<Octokit>;
    listRepositories?: () => string[] | Promise<string[]>;
    listReferencedRepositories?: () => string[] | Promise<string[]>;
}

/** Current access as authoritative state: only a 404 proves the installation lost the repository. */
async function checkRepositoryAccess(octokit: Octokit, ctx: ResyncRepositoryStepContext): Promise<ResyncRepositoryStepResult> {
    try {
        await octokit.request('GET /repos/{owner}/{repo}', { owner: ctx.owner, repo: ctx.repo });
        return { access: 'accessible' };
    } catch (error) {
        // A 403 may still be the suspension itself or a rate limit, so it retries.
        if ((error as { status?: number }).status === 404) return { access: 'inaccessible' };
        throw error;
    }
}

/**
 * GitHub-checked withdrawal for a configured, accessible repository; local
 * invalidation otherwise. An accessible repository that left the configuration
 * still settles its retained withdrawal cleanups on GitHub; an inaccessible one
 * keeps them, which only keeps its issues out of discovery until access returns.
 */
async function reconcileRepositoryIntents(redisClient: Redis, ctx: ResyncRepositoryStepContext): Promise<void> {
    if (ctx.access !== 'inaccessible' && ctx.configured) {
        await reconcileTaskIntents(redisClient, [ctx.repository], { strict: true });
        return;
    }
    await invalidateRepositoryIntents(redisClient, ctx.repository);
    if (ctx.access === 'accessible') {
        await settleWithdrawalCleanups(redisClient, target => `${target.repoOwner}/${target.repoName}`.toLowerCase() === ctx.repository.toLowerCase());
    }
}

async function reconcilePullRequestHeads(octokit: Octokit, ctx: ResyncRepositoryStepContext, redisClient: Redis): Promise<void> {
    const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner: ctx.owner, repo: ctx.repo, state: 'open', per_page: 100,
    }) as unknown as OpenPullRequest[];
    const repoContext = { owner: ctx.owner, repo: ctx.repo, repoFullName: ctx.repository, correlationId: ctx.correlationId };
    for (const pr of prs) {
        if (ctx.signal.aborted) throw new Error('aborted');
        await reconcileUltrafixForPR(pr, repoContext, redisClient, { throwOnError: true });
        if (pr.head.sha) await recoverCiFailureFollowups(ctx.owner, ctx.repo, pr.number, pr.head.sha);
        await reevaluatePRAutoMerge(ctx.owner, ctx.repo, pr.number, ctx.correlationId);
    }
}

export function createResumeResyncReconciler(deps: ResumeResyncReconcilerDeps): ResumeResyncReconciler {
    const getOctokit = deps.getOctokit ?? getAuthenticatedOctokit;
    const { redisClient } = deps;
    return {
        listRepositories: deps.listRepositories ?? getRepos,
        listReferencedRepositories: deps.listReferencedRepositories ?? (() => listIntentRepositories(redisClient)),
        repositorySteps: [
            { family: 'repository_access', run: async ctx => checkRepositoryAccess(await getOctokit(), ctx) },
            { family: 'task_intents', run: ctx => reconcileRepositoryIntents(redisClient, ctx) },
            {
                family: 'labelled_issues',
                run: async ctx => {
                    const issues = await fetchIssuesForRepo(await getOctokit(), ctx.repository, ctx.correlationId, { throwOnError: true });
                    for (const issue of issues) await processDetectedIssue(issue, ctx.correlationId, redisClient, { strict: true });
                },
            },
            {
                family: 'pull_request_comments',
                // Regardless of ENABLE_PR_COMMENT_POLLING: the gap's comments were never delivered.
                run: async ctx => pollForPullRequestComments(await getOctokit(), ctx.repository, ctx.correlationId, {
                    redisClient,
                    PR_FOLLOWUP_TRIGGER_KEYWORDS: deps.PR_FOLLOWUP_TRIGGER_KEYWORDS,
                    MODEL_LABEL_PATTERN: deps.MODEL_LABEL_PATTERN,
                    throwOnError: true,
                    skipUltrafixReconcile: true,
                    createdSince: ctx.gapStartedAt,
                }),
            },
            { family: 'pull_request_heads', run: async ctx => reconcilePullRequestHeads(await getOctokit(), ctx, redisClient) },
            {
                family: 'merge_conflicts',
                run: async ctx => {
                    await sweepConflictedPullRequests({ repositories: [ctx.repository], redisClient, correlationId: ctx.correlationId, strict: true });
                },
            },
        ],
        installationSteps: [
            {
                family: 'ultrafix_continuations',
                run: async ctx => {
                    await sweepUltrafixResumeCandidates(redisClient, () => logger as unknown as Logger, {
                        fullScan: true, strict: true, excludeRepositories: ctx.unavailableRepositories,
                    });
                },
            },
        ],
    };
}

/** Resolve the installation the routed stack is attached to, or null when unknown. */
export function resolveResumeResyncInstallationId(env: NodeJS.ProcessEnv = process.env): number | null {
    const raw = env.GH_INSTALLATION_ID?.trim();
    if (!raw || !/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Build the coordinator for routing_websocket mode, or null when it must not be
 * advertised: without a known installation every control frame would be foreign,
 * and Routing would hold intake for a client that can never complete a resync.
 * `PROPR_ROUTING_RESUME_RESYNC=false` opts out (the legacy protocol).
 */
export function createRoutingResumeResync(
    deps: ResumeResyncReconcilerDeps & { store?: ResumeResyncStore; env?: NodeJS.ProcessEnv },
): RoutingResumeResyncCoordinator | null {
    const env = deps.env ?? process.env;
    if (env.PROPR_ROUTING_RESUME_RESYNC !== undefined && !parseTruthyEnvValue(env.PROPR_ROUTING_RESUME_RESYNC)) {
        logger.info('Routing installation resume resync disabled by PROPR_ROUTING_RESUME_RESYNC');
        return null;
    }
    const installationId = resolveResumeResyncInstallationId(env);
    if (installationId === null) {
        logger.warn('GH_INSTALLATION_ID is not set; not advertising routing installation resume resync');
        return null;
    }
    return new RoutingResumeResyncCoordinator({
        installationId,
        store: deps.store ?? createKnexResumeResyncStore(),
        reconciler: createResumeResyncReconciler(deps),
    });
}
