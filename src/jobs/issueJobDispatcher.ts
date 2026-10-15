import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { db, findIssueSubmission, resolveTaskSubmissionRetry, admittedSubmissionTriggers, logger, findIssueRetryRequests, selectRetryRun, consumeIssueRetryRequest, settleIssueRetryRequest, type IssueRetryRequest, type RetryRun, type SubmissionRetry } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { validateRepositoryInfo } from '@propr/core';
import type { RepoValidationResult } from '@propr/core';

type RepoValidation = RepoValidationResult;
import { issueQueue, type IssueJobData, type JobResult } from '@propr/core';
import { getDefaultModel, resolveLlmLabel, loadSettings, resolveCustomLabel, getAllCustomLabels, NoDefaultModelConfiguredError } from '@propr/core';
import { AgentRegistry } from '@propr/core';
import { isReasoningLevelLabel, parseReasoningLevelFromLabels } from '@propr/shared';

interface CurrentIssueData {
    data: {
        labels: Array<{ name: string }>;
    };
}

interface BaseToProcess {
    branch: string;
    label: string | null;
}

interface AgentModelToProcess {
    agentAlias: string;
    model: string;
    label: string | null;
}

type IssueQueueAdd = typeof issueQueue.add;

type Submission = Awaited<ReturnType<typeof findIssueSubmission>>;

interface RetryRequestStore {
    find(issue: IssueJobData): Promise<IssueRetryRequest[]>;
    /**
     * The run a delivery dispatches for the held requests: one on its own
     * admitted, unconsumed trigger, none, or a deferral while one cannot be
     * reconciled. `commentId` is the request a direct job names.
     */
    select(issue: IssueJobData, requests: IssueRetryRequest[], delivery: { commentId?: number; submission: Submission }): Promise<RetryRun>;
    /** Durably records that the dispatch carried the request into its run. */
    consume(issue: IssueJobData, request: IssueRetryRequest): Promise<void>;
    settle(issue: IssueJobData, request: IssueRetryRequest): Promise<void>;
}

interface DispatcherDeps {
    findSubmission: typeof findIssueSubmission;
    recordDispatch: (id: string, triggerEventId?: string) => Promise<void>;
    resolveSubmissionRetry: typeof resolveTaskSubmissionRetry;
    recordDispatchFailure: (id: string, error: string) => Promise<void>;
    getAuthenticatedOctokit: typeof getAuthenticatedOctokit;
    withRetry: typeof withRetry;
    retryConfigs: typeof retryConfigs;
    validateRepositoryInfo: typeof validateRepositoryInfo;
    issueQueue: { add: IssueQueueAdd };
    getDefaultModel: typeof getDefaultModel;
    resolveLlmLabel: typeof resolveLlmLabel;
    resolveCustomLabel: typeof resolveCustomLabel;
    getAllCustomLabels: typeof getAllCustomLabels;
    resolveDefaultAgentForDispatcher: typeof resolveDefaultAgentForDispatcher;
    retryRequests?: RetryRequestStore;
}

async function resolveDefaultAgentForDispatcher(correlatedLogger: Logger): Promise<{ agentAlias: string; modelToUse: string | undefined }> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    // First, try to use the configured default agent from settings
    try {
        const settings = await loadSettings();
        if (settings.default_agent_alias) {
            const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
            if (configuredAgent && configuredAgent.config.enabled) {
                const agentAlias = settings.default_agent_alias as string;
                const modelToUse = configuredAgent.config.defaultModel;
                correlatedLogger.debug({ configuredDefaultAgent: agentAlias, defaultModel: modelToUse }, 'Using default agent from settings');
                return { agentAlias, modelToUse };
            }
        }
    } catch (settingsError) {
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    // Fallback to registry default if settings didn't provide an agent
    const defaultAgent = registry.getDefaultAgent();
    const agentAlias = defaultAgent?.config.alias || 'default';
    const modelToUse = defaultAgent?.config.defaultModel;
    correlatedLogger.debug({ fallbackAgent: agentAlias, fallbackModel: modelToUse }, 'Using fallback default agent');
    return { agentAlias, modelToUse };
}

// Loaded on first use so importing the injected-deps entry point never opens a Redis connection.
const workerRedis = async () => (await import('./issueJob/config.js')).redisClient;

export async function handleDispatch(job: Job<IssueJobData>): Promise<JobResult> {
    return handleDispatchWithDeps(job, {
        findSubmission: findIssueSubmission,
        resolveSubmissionRetry: resolveTaskSubmissionRetry,
        recordDispatchFailure: async (id, error) => { await db('task_submissions').where({ id, dispatch_complete: false }).update({ state: 'failed', error }); },
        recordDispatch: async (id, triggerEventId) => { await db('task_submissions').where({ id }).update({ dispatch_complete: true, state: 'queued', error: null, ...(triggerEventId ? { retry_event_id: triggerEventId } : {}) }); },
        getAuthenticatedOctokit,
        withRetry,
        retryConfigs,
        validateRepositoryInfo,
        issueQueue,
        getDefaultModel,
        resolveLlmLabel,
        resolveCustomLabel,
        getAllCustomLabels,
        resolveDefaultAgentForDispatcher,
        retryRequests: {
            find: async issue => findIssueRetryRequests(await workerRedis(), issue),
            select: (issue, requests, { commentId, submission }) => selectRetryRun(issue, requests, {
                commentId,
                ...(submission ? { admitted: events => admittedSubmissionTriggers(submission, events) } : {}),
            }),
            consume: async (_issue, request) => consumeIssueRetryRequest(db, request),
            settle: async (issue, request) => settleIssueRetryRequest(await workerRedis(), issue, request),
        },
    });
}

async function resolveDispatchTargets(
    context: { currentIssueData: CurrentIssueData; repoValidation: RepoValidation; issueNumber: number },
    deps: DispatcherDeps,
    correlatedLogger: Logger,
) {
    const { currentIssueData, repoValidation, issueNumber } = context;
    const defaultBranch = repoValidation.repoData?.defaultBranch || 'main';
    const labels = currentIssueData.data.labels.map(l => l.name);

    const baseLabels = labels.filter(l => l.startsWith('base-'));
    const llmLabels = labels.filter(l => l.startsWith('llm-'));
    const reasoningLevel = parseReasoningLevelFromLabels(currentIssueData.data.labels);
    const reasoningLevelLabels = labels.filter(isReasoningLevelLabel);
    if (reasoningLevelLabels.length > 1) {
        correlatedLogger.warn({
            issue: issueNumber,
            reasoningLevel,
            labels: reasoningLevelLabels
        }, 'Multiple reasoning level labels found; using highest-priority label');
    }

    // Get all configured custom labels from agents
    const customLabels = await deps.getAllCustomLabels();
    const customLabelMatches = labels.filter(l =>
        customLabels.some(cl => cl.toLowerCase() === l.toLowerCase())
    );

    const basesToProcess: BaseToProcess[] = baseLabels.length > 0
        ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
        : [{ branch: defaultBranch, label: null }];

    // Resolve LLM labels and custom labels to agent + model pairs
    const agentModelsToProcess: AgentModelToProcess[] = [];

    // First, process standard llm- prefixed labels
    if (llmLabels.length > 0) {
        for (const label of llmLabels) {
            const llmPart = label.substring('llm-'.length);
            const resolution = await deps.resolveLlmLabel(llmPart);
            agentModelsToProcess.push({
                agentAlias: resolution.agentAlias,
                model: resolution.model,
                label
            });
            correlatedLogger.debug({
                label,
                resolvedAgent: resolution.agentAlias,
                resolvedModel: resolution.model
            }, 'Resolved LLM label');
        }
    }

    // Then, process custom labels (that don't overlap with llm- labels)
    if (customLabelMatches.length > 0) {
        for (const label of customLabelMatches) {
            const resolution = await deps.resolveCustomLabel(label);
            if (resolution) {
                agentModelsToProcess.push({
                    agentAlias: resolution.agentAlias,
                    model: resolution.model,
                    label
                });
                correlatedLogger.debug({
                    label,
                    resolvedAgent: resolution.agentAlias,
                    resolvedModel: resolution.model
                }, 'Resolved custom label');
            }
        }
    }

    // If no LLM or custom labels found, use the default agent
    if (agentModelsToProcess.length === 0) {
        // No LLM or custom labels - use default agent from settings
        const { agentAlias, modelToUse } = await deps.resolveDefaultAgentForDispatcher(correlatedLogger);
        const resolvedModel = modelToUse || process.env.DEFAULT_CLAUDE_MODEL || deps.getDefaultModel();

        if (!resolvedModel) {
            throw new NoDefaultModelConfiguredError();
        }

        agentModelsToProcess.push({
            agentAlias,
            model: resolvedModel,
            label: null
        });
    }

    return { basesToProcess, agentModelsToProcess, reasoningLevel };
}

/** A requested retry runs for its requester; other deliveries keep the submitter. */
function submissionRunOwner(submitterId: string, issueRef: IssueJobData, isRetry: boolean): string {
    return isRetry && issueRef.retryRequesterId ? issueRef.retryRequesterId : submitterId;
}

/**
 * The run the delivery dispatches. Held requests are selected by the same
 * rules for a direct job and a recovering relabel or poll: each only on its
 * own admitted, unconsumed trigger, oldest first, so a newer, independent
 * trigger runs a request still owed a run instead of stranding it. Without
 * one, the delivery's latest trigger runs without any request.
 */
async function resolveRun(
    issueRef: IssueJobData,
    submission: Submission,
    deps: DispatcherDeps,
): Promise<{ run: RetryRun; trigger: SubmissionRetry | null }> {
    if (submission) [issueRef.repoOwner, issueRef.repoName] = submission.repository.split('/');
    const held = await deps.retryRequests?.find(issueRef) ?? [];
    const run: RetryRun = held.length > 0
        ? await deps.retryRequests!.select(issueRef, held, { commentId: issueRef.retryCommentId, submission })
        : { request: null };
    if ('deferred' in run || !submission) return { run, trigger: null };
    if (run.request) return { run, trigger: { eventId: run.triggerEventId! } };
    return { run, trigger: await deps.resolveSubmissionRetry(submission) };
}

/**
 * Fixes who the run is for and which retry request it carries. A relabel
 * delivery recovering a requested retry carries neither the requester nor the
 * comment to exempt; the selected request does. A job the route queued whose
 * trigger run is another, independent one runs without its request.
 */
function applyRunRequest(issueRef: IssueJobData, submission: Submission, request: IssueRetryRequest | null, retry: SubmissionRetry | null): void {
    if (request) {
        issueRef.retryRequesterId = request.requesterId;
        issueRef.retryCommentId = request.commentId;
    } else if (submission && issueRef.retryCommentId !== undefined) {
        logger.info({ issue: issueRef.number, triggerEventId: retry?.eventId }, 'Queued retry request does not own the dispatched trigger; dispatching it without the request');
        delete issueRef.retryRequesterId;
        delete issueRef.retryCommentId;
    }
    if (submission) {
        issueRef.userId = submissionRunOwner(submission.user_id, issueRef, Boolean(retry));
        issueRef.correlationId = retry ? `${submission.id}-${retry.eventId}` : submission.id;
    } else if (issueRef.retryRequesterId) {
        issueRef.userId = issueRef.retryRequesterId;
    }
}

/**
 * Once the children carry the request it is consumed: durably, so neither a
 * redelivery nor a later trigger runs it again, then released. A request whose
 * release fails stays bound to the dispatched trigger.
 */
async function releaseRetryRequest(issueRef: IssueJobData, request: IssueRetryRequest | null, deps: DispatcherDeps, log: Logger): Promise<void> {
    if (!request) return;
    await deps.retryRequests?.consume(issueRef, request).catch((error: Error) => {
        log.warn({ issue: issueRef.number, error: error.message }, 'Failed to record the dispatched retry request as consumed');
    });
    await deps.retryRequests?.settle(issueRef, request).catch((error: Error) => {
        log.warn({ issue: issueRef.number, error: error.message }, 'Failed to release the dispatched retry request');
    });
}

export async function handleDispatchWithDeps(job: Job<IssueJobData>, deps: DispatcherDeps): Promise<JobResult> {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const submission = await deps.findSubmission(issueRef);
    const { run, trigger } = await resolveRun(issueRef, submission, deps);
    if ('deferred' in run) {
        // Its trigger stays unconsumed, so a later delivery retries once its outcome is known.
        logger.warn({ issue: issueRef.number, retryCommentId: run.deferred.commentId }, 'A held retry request may own the trigger but its publication is unreconciled; deferring dispatch');
        return { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: issueRef.number };
    }
    const retry = submission?.dispatch_complete ? trigger : null;
    if (submission?.dispatch_complete && !retry) return { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: issueRef.number };
    const retryRequest = run.request;
    applyRunRequest(issueRef, submission, retryRequest, retry);
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ jobId, issueRef: issueRef.number }, 'Running as matrix dispatcher...');

    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    let currentIssueData: CurrentIssueData;
    let repoValidation: RepoValidation;

    try {
        octokit = await deps.withRetry(
            () => deps.getAuthenticatedOctokit(),
            { ...deps.retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit_dispatcher'
        );

        currentIssueData = await deps.withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
            }),
            { ...deps.retryConfigs.githubApi, correlationId },
            `get_issue_${issueRef.number}_dispatcher`
        ) as CurrentIssueData;

        repoValidation = await deps.validateRepositoryInfo({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number }, octokit, correlationId);
        if (!repoValidation.isValid) {
            const errorMessage = repoValidation.error || 'Repository validation failed';
            throw new Error(errorMessage);
        }

        const { basesToProcess, agentModelsToProcess, reasoningLevel } = await resolveDispatchTargets(
            { currentIssueData, repoValidation, issueNumber: issueRef.number }, deps, correlatedLogger,
        );

        let jobsEnqueued = 0;
        for (const base of basesToProcess) {
            for (const agentModel of agentModelsToProcess) {
                const newJobData: IssueJobData = {
                    ...issueRef,
                    baseBranch: base.branch,
                    baseLabel: base.label,
                    agentAlias: agentModel.agentAlias,
                    modelName: agentModel.model,
                    modelLabel: agentModel.label,
                    reasoningLevel,
                    isChildJob: true,
                    issuePayload: currentIssueData.data as unknown as Record<string, unknown>,
                    repoPayload: repoValidation.repoData as unknown as Record<string, unknown>
                };

                // Deterministic jobId for deduplication - prevents duplicate child jobs
                // when multiple webhook events trigger the dispatcher for the same issue
                const childJobId = `issue-${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${agentModel.agentAlias}-${agentModel.model}-${base.branch}${retry ? `-trigger-${retry.eventId}` : ''}`;

                await deps.issueQueue.add(jobName, newJobData, {
                    jobId: childJobId,
                    // Retain the initial delivery until its durable dispatch receipt exists.
                    // Late webhook deliveries consult that receipt, even after queue cleanup.
                    removeOnComplete: !submission,
                    removeOnFail: !submission,
                });
                jobsEnqueued++;
                correlatedLogger.info({
                    jobId,
                    childJobId,
                    issue: issueRef.number,
                    base: base.branch,
                    agent: agentModel.agentAlias,
                    model: agentModel.model,
                    reasoningLevel
                }, 'Enqueued child job');
            }
        }

        // A run of a request's own trigger also consumes newer triggers it was dispatched past.
        if (submission) await deps.recordDispatch(submission.id, (run.request ? run.latestTriggerEventId : undefined) ?? trigger?.eventId);
        await releaseRetryRequest(issueRef, retryRequest, deps, correlatedLogger);
        correlatedLogger.info({ jobId, issue: issueRef.number, jobsEnqueued }, 'Matrix dispatcher job complete.');
        return { status: 'dispatched', jobsEnqueued, issueNumber: issueRef.number };

    } catch (error) {
        if (submission) await deps.recordDispatchFailure(submission.id, (error as Error).message);
        correlatedLogger.error({
            jobId,
            issue: issueRef.number,
            errMessage: (error as Error).message,
            stack: (error as Error).stack
        }, 'Error in matrix dispatcher, job will fail and not dispatch children');
        throw error;
    }
}
