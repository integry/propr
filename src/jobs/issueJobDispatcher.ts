import { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
    db, findIssueSubmission, resolveTaskSubmissionRetry, admittedSubmissionTriggers, logger, selectRetryRun, consumeIssueRetryRequest,
    confirmIssueRetryPublication, redisRetryOutcomeEvidence, queueRetryRunEvidence, enqueueIssueRetryRun, recordIssueRetryRunReceipt,
    acceptedRunTrigger, submissionTriggerEvents,
    type IssueRetryRequest, type RetryPublicationOutcome, type RetryRun, type RetryRunChild, type RetryRunReceipt, type SubmissionRetry,
    type RunReceiptFence, type TriggerLabelEvent,
} from '@propr/core';
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
    /**
     * The run a delivery dispatches for the issue's open request: it on its
     * own admitted trigger, none, or a deferral while it cannot be reconciled.
     */
    select(issue: IssueJobData, delivery: { submission: Submission }): Promise<RetryRun>;
    /** The outcome of the request's current trigger write that the route could not record and kept as durable evidence, if any. */
    evidence(issue: IssueJobData, request: IssueRetryRequest): Promise<RetryPublicationOutcome | null>;
    /** Durably records the outcome of the request's trigger write, as the route learned it, then drops its evidence. */
    confirm(issue: IssueJobData, request: IssueRetryRequest, publication: RetryPublicationOutcome): Promise<void>;
    /**
     * Adds the request's children together with the queue's record of its run, which
     * keeps it carried until it is recorded consumed, and fences any later add of them;
     * `receiptEventId` is the latest trigger the run consumes. Resolves false when the
     * queue had already accepted the run from another dispatch, and added nothing.
     */
    enqueue(issue: IssueJobData, request: IssueRetryRequest, children: RetryRunChild[], receiptEventId: string | null): Promise<boolean>;
    /** The run the queue accepted for the request, by whichever dispatch, retired or not, or null when it accepted none. */
    accepted(issue: IssueJobData, request: IssueRetryRequest): Promise<RetryRunReceipt | null>;
    /** Durably records that the dispatch carried the request into its run, which releases it and retires the record of its run. */
    consume(issue: IssueJobData, request: IssueRetryRequest): Promise<void>;
}

interface DispatcherDeps {
    findSubmission: typeof findIssueSubmission;
    /** Records the submission's dispatch receipt through `triggerEventId`, fenced on the receipt the dispatch read. */
    recordDispatch: (id: string, triggerEventId: string | undefined, fence: RunReceiptFence) => Promise<void>;
    /** The trigger events of the submission's issue, read afresh, which order a receipt another dispatch recorded since. */
    submissionTriggers?: (submission: NonNullable<Submission>) => Promise<TriggerLabelEvent[]>;
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

export async function handleDispatch(job: Job<IssueJobData>): Promise<JobResult> {
    // Read through the issue queue's own connection, and only when a request is deferred.
    const retryOutcomes = redisRetryOutcomeEvidence(() => issueQueue.client);
    const retryRuns = queueRetryRunEvidence(() => issueQueue);
    return handleDispatchWithDeps(job, {
        findSubmission: findIssueSubmission,
        resolveSubmissionRetry: resolveTaskSubmissionRetry,
        recordDispatchFailure: async (id, error) => { await db('task_submissions').where({ id, dispatch_complete: false }).update({ state: 'failed', error }); },
        recordDispatch: async (id, triggerEventId, fence) => { await recordIssueRetryRunReceipt(db, id, triggerEventId, fence); },
        submissionTriggers: submission => submissionTriggerEvents(submission),
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
            select: (issue, { submission }) => selectRetryRun(issue, submission
                ? { admitted: events => admittedSubmissionTriggers(submission, events), consumedEventId: submission.retry_event_id, runs: request => retryRuns.read(request) }
                : { runs: request => retryRuns.read(request) }),
            evidence: (_issue, request) => retryOutcomes.read(request),
            confirm: async (_issue, request, publication) => { await confirmIssueRetryPublication({ database: db, evidence: retryOutcomes }, request, publication); },
            enqueue: (_issue, request, children, receiptEventId) => enqueueIssueRetryRun(issueQueue, request, children, { receiptEventId }),
            accepted: (_issue, request) => retryRuns.accepted(request),
            consume: async (_issue, request) => consumeIssueRetryRequest({ database: db, evidence: retryOutcomes, runs: retryRuns }, request),
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
 * The run the delivery dispatches. The open request is selected by the same
 * rules for a direct job and a recovering relabel or poll: only on its own
 * admitted trigger, so a newer, independent trigger runs a request still owed
 * a run instead of stranding it. Without one, the delivery's latest trigger,
 * read from the same history, runs without any request.
 */
async function resolveRun(
    issueRef: IssueJobData,
    submission: Submission,
    deps: DispatcherDeps,
): Promise<{ run: RetryRun; trigger: SubmissionRetry | null }> {
    if (submission) [issueRef.repoOwner, issueRef.repoName] = submission.repository.split('/');
    const run: RetryRun = deps.retryRequests ? await deps.retryRequests.select(issueRef, { submission }) : { request: null };
    if ('deferred' in run || !submission) return { run, trigger: null };
    if (run.request) return { run, trigger: { eventId: run.triggerEventId } };
    return { run, trigger: run.trigger !== undefined ? run.trigger : await deps.resolveSubmissionRetry(submission) };
}

/**
 * Whether the job is the one the route queued for the deferred request's
 * current trigger write. The route queues a request's job only once GitHub
 * confirmed that write, so the job is the evidence of the outcome the route
 * could not record; a job of an earlier write of a restarted request is not.
 */
function confirmsPublication(issueRef: IssueJobData, request: IssueRetryRequest): boolean {
    return request.publication === 'pending' && request.commentId !== null && request.publishedAt !== null
        && issueRef.retryCommentId === request.commentId && issueRef.retryRequesterId === request.requesterId
        && issueRef.retryPublishedAt === request.publishedAt;
}

/**
 * The run the delivery dispatches, after recording the outcome of a deferred
 * request's trigger write that the job itself confirms or that the route kept
 * as durable evidence, so any later delivery reconciles it after the route's
 * process or the job carrying it is gone. A refusal releases the request, and
 * the delivery runs without it. A failure to record it fails the dispatch,
 * whose retry or a later delivery reconciles again, with the evidence kept,
 * rather than completing it as deferred for good.
 */
async function resolveConfirmedRun(issueRef: IssueJobData, submission: Submission, deps: DispatcherDeps): ReturnType<typeof resolveRun> {
    const resolved = await resolveRun(issueRef, submission, deps);
    if (!('deferred' in resolved.run) || !deps.retryRequests) return resolved;
    const request = resolved.run.deferred;
    if (request.publication !== 'pending' || request.publishedAt === null) return resolved;
    const outcome = confirmsPublication(issueRef, request) ? 'possible' : await deps.retryRequests.evidence(issueRef, request);
    if (!outcome) return resolved;
    logger.info({ issue: issueRef.number, retryCommentId: request.commentId, outcome }, 'Recording the retry trigger outcome its publication left');
    await deps.retryRequests.confirm(issueRef, request, outcome);
    return resolveRun(issueRef, submission, deps);
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
        if (request.commentId !== null) issueRef.retryCommentId = request.commentId;
    } else if (submission && issueRef.retryCommentId !== undefined) {
        logger.info({ issue: issueRef.number, triggerEventId: retry?.eventId }, 'Queued retry request does not own the dispatched trigger; dispatching it without the request');
        delete issueRef.retryRequesterId;
        delete issueRef.retryCommentId;
        delete issueRef.retryPublishedAt;
    }
    if (submission) {
        issueRef.userId = submissionRunOwner(submission.user_id, issueRef, Boolean(retry));
        issueRef.correlationId = retry ? `${submission.id}-${retry.eventId}` : submission.id;
    } else if (issueRef.retryRequesterId) {
        issueRef.userId = issueRef.retryRequesterId;
    }
}

/**
 * A requested retry's children run under IDs of the request's own, the same
 * across restarts of its publication, so they are never taken for another
 * request's children, nor another request's for its own; other runs keep the
 * IDs of their trigger, or of the issue.
 */
function childRunSuffix(request: IssueRetryRequest | null, retry: SubmissionRetry | null): string {
    if (request) return `-request-${request.id}-${request.commentId}`;
    return retry ? `-trigger-${retry.eventId}` : '';
}

/**
 * Once the children carry the request it is consumed, durably, so neither a
 * redelivery nor a later trigger runs it again. A submission's consumed
 * trigger also releases it. Until then, the queue's record of its run, which
 * its children were added with, keeps it carried: a request whose
 * consumption cannot be recorded fails the dispatch, whose retry, or a later
 * delivery or follow-up, records it consumed by that record instead of adding
 * its children again, however much later.
 */
async function releaseRetryRequest(issueRef: IssueJobData, request: IssueRetryRequest | null, deps: DispatcherDeps): Promise<void> {
    if (request) await deps.retryRequests?.consume(issueRef, request);
}

/**
 * The fence of the submission's dispatch receipt this dispatch records: the
 * receipt it read when it began, which its selection admitted triggers after.
 */
function receiptFence(submission: NonNullable<Submission>, deps: DispatcherDeps, fence: Partial<RunReceiptFence> = {}): RunReceiptFence {
    return {
        observedEventId: submission.retry_event_id ?? null,
        history: () => deps.submissionTriggers ? deps.submissionTriggers(submission) : Promise.reject(new Error('The issue\'s trigger history cannot be read')),
        ...fence,
    };
}

/**
 * Records, in the submission's dispatch receipt, the trigger the queue's
 * record of a request's accepted run names, whichever dispatch accepted it:
 * not a trigger this dispatch's own, possibly stale, selection would have run
 * it on. A receipt that already records it or a later trigger is kept. A
 * receipt that cannot be read, ordered or written fails, so the request is
 * not recorded consumed and its record is not retired.
 */
async function recordAcceptedRun(submission: NonNullable<Submission>, request: IssueRetryRequest, run: RetryRunReceipt, deps: DispatcherDeps): Promise<void> {
    const fence = receiptFence(submission, deps);
    const { eventId, events } = await acceptedRunTrigger(request, run, fence);
    await deps.recordDispatch(submission.id, eventId, { ...fence, events });
}

/**
 * Settles a request whose run another dispatch, such as one that recovered
 * this job while it was stalled, accepted since this one selected it: the
 * submission's receipt records that run's trigger, as the queue's record
 * names it, not this stale selection's, before the request is recorded
 * consumed; it stays open, with its record, until it is.
 */
async function settleAcceptedRequest(issueRef: IssueJobData, submission: Submission, request: IssueRetryRequest | null, deps: DispatcherDeps): Promise<void> {
    if (submission && request) {
        const accepted = await deps.retryRequests?.accepted(issueRef, request);
        if (accepted) await recordAcceptedRun(submission, request, accepted, deps);
    }
    await releaseRetryRequest(issueRef, request, deps);
}

/**
 * Records the consumption of requests an earlier dispatch carried into its
 * run, as its receipt of their own triggers or the queue's record of their
 * runs shows, after recording that consumption itself failed; a submission's
 * receipt first records the trigger the run consumed, as the record names it.
 * Selection already owes them nothing, so a failure here is left to a later
 * delivery or follow-up, which settles them on the same records, rather than
 * holding back this delivery.
 */
async function settleCarriedRequests(issueRef: IssueJobData, submission: Submission, run: RetryRun, deps: DispatcherDeps): Promise<void> {
    for (const request of run.carried ?? []) {
        logger.info({ issue: issueRef.number, retryCommentId: request.commentId }, 'Recording the consumption of a retry request an earlier dispatch carried');
        try {
            if (submission && request.run) await recordAcceptedRun(submission, request, request.run, deps);
            await deps.retryRequests?.consume(issueRef, request);
        } catch (error) {
            logger.warn({ issue: issueRef.number, retryCommentId: request.commentId, errMessage: (error as Error).message }, 'Could not record a carried retry request as consumed');
        }
    }
}

/**
 * A queued issue-only request runs only on its own trigger, by the rules
 * recovery uses; a delivery whose selection is not it runs nothing. A retry
 * of the dispatch that enqueued its run finds the request carried. Any
 * delivery whose latest trigger a carried request's run consumed, such as a
 * poll after that dispatch is gone, only settles the request: the run was
 * that trigger's, so nothing more runs on it, for the delivery or anyone.
 */
function unownedRequest(issueRef: IssueJobData, submission: Submission, run: RetryRun): JobResult | null {
    const request = 'request' in run ? run.request : null;
    if (request || submission) return null;
    if ('trigger' in run && run.trigger === null) {
        logger.info({ issue: issueRef.number, retryCommentId: issueRef.retryCommentId }, 'A carried retry request\'s run consumed the latest trigger; not dispatching it again');
        return { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: issueRef.number };
    }
    if (issueRef.retryCommentId === undefined) return null;
    if (run.carried?.some(held => held.commentId === issueRef.retryCommentId && held.requesterId === issueRef.retryRequesterId)) {
        logger.info({ issue: issueRef.number, retryCommentId: issueRef.retryCommentId }, 'Queued retry request already had its run enqueued; not dispatching it again');
        return { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: issueRef.number };
    }
    logger.warn({ issue: issueRef.number, retryCommentId: issueRef.retryCommentId }, 'Queued retry request does not own a published trigger; not dispatching it');
    return { status: 'skipped', reason: 'retry_request_not_owed', issueNumber: issueRef.number };
}

/**
 * The latest trigger the run consumes, which the submission's dispatch receipt records, and the queue's record
 * of a request's run keeps for an issue-only one: a run of a request's own trigger also consumes newer
 * triggers it was dispatched past.
 */
function consumedTrigger(run: RetryRun, trigger: SubmissionRetry | null): string | undefined {
    if ('request' in run && run.request) return run.latestTriggerEventId ?? run.triggerEventId;
    return trigger?.eventId;
}

/**
 * Adds the run's children: a requested retry's with the queue's record of its run, in one transaction; any
 * other's as they are. False when the queue had already accepted the request's run from another dispatch.
 */
async function enqueueChildren(
    issueRef: IssueJobData, { request, receiptEventId }: { request: IssueRetryRequest | null; receiptEventId: string | undefined },
    children: RetryRunChild[], deps: DispatcherDeps,
): Promise<boolean> {
    if (request && deps.retryRequests) return deps.retryRequests.enqueue(issueRef, request, children, receiptEventId ?? null);
    for (const child of children) await deps.issueQueue.add(child.name, child.data, child.opts);
    return true;
}

export async function handleDispatchWithDeps(job: Job<IssueJobData>, deps: DispatcherDeps): Promise<JobResult> {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const submission = await deps.findSubmission(issueRef);
    const { run, trigger } = await resolveConfirmedRun(issueRef, submission, deps);
    await settleCarriedRequests(issueRef, submission, run, deps);
    if ('deferred' in run) {
        // Its trigger stays unconsumed, so a later delivery retries once its outcome is known.
        logger.warn({ issue: issueRef.number, retryCommentId: run.deferred.commentId }, 'A held retry request may own the trigger but its publication is unreconciled; deferring dispatch');
        return { status: 'skipped', reason: 'retry_request_unreconciled', issueNumber: issueRef.number };
    }
    const unowned = unownedRequest(issueRef, submission, run);
    if (unowned) return unowned;
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

        const children: RetryRunChild[] = [];
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
                const childJobId = `issue-${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${agentModel.agentAlias}-${agentModel.model}-${base.branch}${childRunSuffix(retryRequest, retry)}`;
                children.push({ name: jobName, data: newJobData, opts: {
                    jobId: childJobId,
                    // Retain the initial delivery until its durable dispatch receipt exists.
                    // Late webhook deliveries consult that receipt, even after queue cleanup.
                    removeOnComplete: !submission,
                    removeOnFail: !submission,
                } });
            }
        }

        const receiptEventId = consumedTrigger(run, trigger);
        if (!await enqueueChildren(issueRef, { request: retryRequest, receiptEventId }, children, deps)) {
            correlatedLogger.info({ jobId, issue: issueRef.number, retryCommentId: retryRequest?.commentId }, 'Retry request\'s run was already accepted; adding nothing');
            await settleAcceptedRequest(issueRef, submission, retryRequest, deps);
            return { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: issueRef.number };
        }
        for (const child of children) {
            correlatedLogger.info({
                jobId,
                childJobId: child.opts.jobId,
                issue: issueRef.number,
                base: child.data.baseBranch,
                agent: child.data.agentAlias,
                model: child.data.modelName,
                reasoningLevel
            }, 'Enqueued child job');
        }
        const jobsEnqueued = children.length;

        if (submission) await deps.recordDispatch(submission.id, receiptEventId, receiptFence(submission, deps, { admitted: true }));
        await releaseRetryRequest(issueRef, retryRequest, deps);
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
