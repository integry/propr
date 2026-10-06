import { createHash, randomUUID } from 'node:crypto';
import { buildIssueTaskId } from '@propr/shared';
import type { IssueJobData } from '@propr/core';
import {
    describeReplacementSkip,
    MAX_INFRA_LOST_REPLACEMENTS,
    stopReasonExclusion,
    type ReplacementCause,
    type ReplacementSkipReason,
} from './policy.js';
import type { LineageAttempt, ReplaceableTask, TaskReplacementStore } from './store.js';

export const REPLACEMENT_JOB_NAME = 'processGitHubIssue';
/** A pending decision older than this is completed by the reconciler. */
export const PENDING_REPLACEMENT_RECOVERY_MS = 5 * 60 * 1000;

export interface ReplacementRequest {
    taskId: string;
    cause: ReplacementCause;
    /** Terminal reason of the failed run, when known. */
    terminalReason?: string | null;
    /** Failure message recorded with the timeline events. */
    error?: string;
}

export type ReplacementEvaluation =
    | {
        eligible: true;
        task: ReplaceableTask;
        lineage: LineageAttempt[];
        attemptNumber: number;
        maxReplacements: number;
        remainingBudgetUsd?: number;
    }
    | {
        eligible: false;
        reason: ReplacementSkipReason;
        task: ReplaceableTask;
        lineage: LineageAttempt[];
        maxReplacements: number;
    }
    /** Nothing to decide: unknown task, or the attempt already has its replacement. */
    | { eligible: false; reason: null };

export type ReplacementOutcome =
    | { action: 'dispatched'; replacementTaskId: string; attemptNumber: number; lineage: LineageAttempt[] }
    | { action: 'skipped'; reason: ReplacementSkipReason; exhausted: boolean; lineage: LineageAttempt[] }
    | { action: 'none' };

export interface IssueStateReader {
    (repoOwner: string, repoName: string, issueNumber: number): Promise<{ state: string } | null>;
}

export interface TaskReplacementLogger {
    info(object: Record<string, unknown>, message: string): void;
    warn(object: Record<string, unknown>, message: string): void;
}

export interface TaskReplacementDependencies {
    store: TaskReplacementStore;
    enqueue(jobName: string, data: IssueJobData, jobId: string): Promise<void>;
    loadMaxProviderReplacements(): Promise<number>;
    infraLostEnabled(): boolean;
    readIssueState?: IssueStateReader;
    publishTaskUpdate?(payload: {
        taskId: string;
        state: string;
        repository?: string;
        issueNumber?: number;
        timestamp?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    postIssueComment?(repoOwner: string, repoName: string, issueNumber: number, body: string): Promise<void>;
    frontendUrl?: string;
    now?: () => Date;
    randomId?: () => string;
    logger?: TaskReplacementLogger;
}

export interface TaskReplacementService {
    /** Decides whether a failing task will be replaced, before it is marked failed. */
    prepare(request: ReplacementRequest): Promise<ReplacementEvaluation>;
    /** Dispatches the replacement for a failed task, or records why there is none. */
    complete(request: ReplacementRequest): Promise<ReplacementOutcome>;
    /** Completes decisions a restart interrupted between `prepare` and `complete`. */
    resumePending(options?: { limit?: number }): Promise<{ resumed: number; cleared: number }>;
    /** Attempts of the task's lineage, oldest first (just the task itself outside a lineage). */
    lineage(taskId: string): Promise<LineageAttempt[]>;
    /** Markdown list of a lineage's attempts with links to each task. */
    formatAttempts(lineage: LineageAttempt[]): string;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const EXHAUSTING_REASONS = new Set<ReplacementSkipReason>(['cap_reached', 'budget_exhausted']);

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function splitRepository(repository: string): [string, string] | null {
    const [owner, name, ...rest] = repository.split('/');
    return owner && name && rest.length === 0 ? [owner, name] : null;
}

function causeCount(lineage: LineageAttempt[], cause: ReplacementCause): number {
    return lineage.filter(attempt => attempt.replacementCause === cause).length;
}

/** Tasks that are never replaced, whatever their lineage. */
function exclusionFor(task: ReplaceableTask, request: ReplacementRequest, maxReplacements: number): ReplacementSkipReason | null {
    if (task.taskType === 'goal') return 'goal_task';
    const stopped = stopReasonExclusion(request.terminalReason) ?? stopReasonExclusion(task.latestTerminalReason)
        ?? (task.latestState === 'cancelled' ? 'user_cancelled' : null);
    if (stopped) return stopped;
    if (maxReplacements === 0) return 'disabled';
    const replay = task.replayJobData;
    if ((task.taskType ?? 'issue') !== 'issue' || !replay?.agentAlias || !replay.modelName || !task.issueNumber) return 'unsupported_task';
    return null;
}

/** The per-run cost cap minus what every attempt of the lineage spent, when a cap is set. */
function remainingBudget(replay: IssueJobData, lineage: LineageAttempt[]): number | undefined {
    if (typeof replay.costCapUsd !== 'number' || !Number.isFinite(replay.costCapUsd)) return undefined;
    const spent = lineage.reduce((total, attempt) => total + attempt.costUsd, 0);
    return Math.round((replay.costCapUsd - spent) * 1e6) / 1e6;
}

export function createTaskReplacementService(deps: TaskReplacementDependencies): TaskReplacementService {
    const now = () => (deps.now ?? (() => new Date()))();
    const frontendUrl = (deps.frontendUrl ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    const taskUrl = (taskId: string) => `${frontendUrl}/tasks/${encodeURIComponent(taskId)}`;

    function formatAttempts(lineage: LineageAttempt[]): string {
        return lineage.map(attempt => {
            const cause = attempt.replacementCause === 'infra_lost'
                ? ' — replaced a run lost with its worker'
                : attempt.replacementCause === 'provider_transient' ? ' — replaced a run ended by a provider error' : '';
            return `${attempt.attemptNumber}. [${attempt.taskId}](${taskUrl(attempt.taskId)}) — ${attempt.state ?? 'unknown'}${cause}`;
        }).join('\n');
    }

    async function closedIssue(task: ReplaceableTask): Promise<boolean> {
        const repository = splitRepository(task.repository);
        if (!deps.readIssueState || !repository || !task.issueNumber) return false;
        try {
            const issue = await deps.readIssueState(repository[0], repository[1], task.issueNumber);
            return issue?.state === 'closed';
        } catch (error) {
            // The replacement re-checks the issue before it starts work.
            deps.logger?.warn({ taskId: task.taskId, error: (error as Error).message }, 'Could not read issue state before replacement');
            return false;
        }
    }

    async function evaluate(request: ReplacementRequest): Promise<ReplacementEvaluation> {
        const task = await deps.store.loadTask(request.taskId);
        if (!task || task.replacedByTaskId) return { eligible: false, reason: null };
        const lineage = await deps.store.loadLineage(task.lineageRootTaskId);
        const maxReplacements = request.cause === 'infra_lost'
            ? (deps.infraLostEnabled() ? MAX_INFRA_LOST_REPLACEMENTS : 0)
            : await deps.loadMaxProviderReplacements();
        const skip = (reason: ReplacementSkipReason): ReplacementEvaluation => ({ eligible: false, reason, task, lineage, maxReplacements });

        const excluded = exclusionFor(task, request, maxReplacements);
        if (excluded) return skip(excluded);
        if (causeCount(lineage, request.cause) >= maxReplacements) return skip('cap_reached');
        const remainingBudgetUsd = remainingBudget(task.replayJobData!, lineage);
        if (remainingBudgetUsd !== undefined && remainingBudgetUsd <= 0) return skip('budget_exhausted');
        if (await closedIssue(task)) return skip('issue_closed');

        const attemptNumber = Math.max(task.attemptNumber, ...lineage.map(attempt => attempt.attemptNumber)) + 1;
        return {
            eligible: true, task, lineage, attemptNumber, maxReplacements,
            ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
        };
    }

    async function publishFailureAgain(task: ReplaceableTask, reason: ReplacementSkipReason, timestamp: string): Promise<void> {
        // The failure alert was held back while a replacement was expected.
        if (task.replacementState !== 'pending' || !deps.publishTaskUpdate) return;
        await deps.publishTaskUpdate({
            taskId: task.taskId,
            state: 'failed',
            repository: task.repository,
            ...(task.issueNumber ? { issueNumber: task.issueNumber } : {}),
            timestamp,
            metadata: { reason: `No replacement attempt: ${describeReplacementSkip(reason)}`, replacementSkipped: reason },
        });
    }

    async function postExhaustedComment(task: ReplaceableTask, lineage: LineageAttempt[], request: ReplacementRequest): Promise<void> {
        const repository = splitRepository(task.repository);
        if (!deps.postIssueComment || !repository || !task.issueNumber || request.cause !== 'infra_lost') return;
        const body = `❌ **Failed to process this issue after ${lineage.length} attempts**\n\n`
            + 'The last attempt was lost with its worker (no queue job or running task container remained), '
            + 'and a second loss in the same lineage is final.\n\n'
            + `**Attempts:**\n${formatAttempts(lineage)}\n\n`
            + '---\n*Re-apply the trigger label to start a new run.*';
        try {
            await deps.postIssueComment(repository[0], repository[1], task.issueNumber, body);
        } catch (error) {
            deps.logger?.warn({ taskId: task.taskId, error: (error as Error).message }, 'Failed to post the final replacement failure comment');
        }
    }

    async function recordSkip(
        evaluation: Extract<ReplacementEvaluation, { eligible: false; task: ReplaceableTask }>,
        request: ReplacementRequest,
    ): Promise<ReplacementOutcome> {
        const { task, reason, maxReplacements } = evaluation;
        const lineage = evaluation.lineage.length > 0 ? evaluation.lineage : [{
            taskId: task.taskId, attemptNumber: task.attemptNumber, replacementCause: task.replacementCause, state: task.latestState, costUsd: 0,
        }];
        const exhausted = EXHAUSTING_REASONS.has(reason);
        const timestamp = now().toISOString();
        await deps.store.setState(task.taskId, exhausted ? 'exhausted' : 'skipped');
        await deps.store.appendEvent({
            taskId: task.taskId, event: 'replacement.skipped', reason: `Replacement skipped: ${describeReplacementSkip(reason)}`, timestamp,
            metadata: { reason, cause: request.cause, maxReplacements, ...(request.error ? { failure: request.error.slice(0, 500) } : {}) },
        });
        if (exhausted) {
            await deps.store.appendEvent({
                taskId: task.taskId, event: 'replacement.exhausted', reason: `All ${lineage.length} attempts failed`, timestamp,
                metadata: {
                    reason, cause: request.cause, maxReplacements,
                    attempts: lineage.map(({ taskId, attemptNumber, state }) => ({ taskId, attemptNumber, state })),
                },
            });
            await postExhaustedComment(task, lineage, request);
        }
        await publishFailureAgain(task, reason, timestamp);
        deps.logger?.info({ taskId: task.taskId, cause: request.cause, reason, exhausted }, 'Task replacement skipped');
        return { action: 'skipped', reason, exhausted, lineage };
    }

    async function dispatch(
        evaluation: Extract<ReplacementEvaluation, { eligible: true }>,
        request: ReplacementRequest,
    ): Promise<ReplacementOutcome> {
        const { task, attemptNumber, remainingBudgetUsd } = evaluation;
        const replay = task.replayJobData!;
        const correlationId = (deps.randomId ?? randomUUID)();
        const replacementTaskId = buildIssueTaskId({
            repoOwner: replay.repoOwner, repoName: replay.repoName, issueNumber: replay.number,
            agentAlias: replay.agentAlias!, modelName: replay.modelName!, correlationId,
        });
        const jobId = `issue-${replay.repoOwner}-${replay.repoName}-${replay.number}-replacement-${shortHash(replacementTaskId)}`;
        const jobData: IssueJobData = {
            ...replay,
            correlationId,
            isChildJob: true,
            replacesTaskId: task.taskId,
            attemptNumber,
            lineageRootTaskId: task.lineageRootTaskId,
            replacementCause: request.cause,
            ...(task.branchName ? { replacementBranch: task.branchName } : {}),
            ...(remainingBudgetUsd === undefined ? {} : { costCapUsd: remainingBudgetUsd }),
        };
        const timestamp = now().toISOString();
        // Budgets are always recomputed from the original cap and the whole lineage's spend.
        const replayData: IssueJobData = { ...jobData, ...(remainingBudgetUsd === undefined ? {} : { costCapUsd: replay.costCapUsd }) };
        const claimed = await deps.store.createReplacement({
            original: task, replacementTaskId, jobId, correlationId, attemptNumber, cause: request.cause, jobData, replayData, timestamp,
        });
        if (!claimed) return { action: 'none' };
        try {
            await deps.enqueue(REPLACEMENT_JOB_NAME, jobData, jobId);
        } catch (error) {
            deps.logger?.warn({ taskId: task.taskId, replacementTaskId, error: (error as Error).message }, 'Failed to queue replacement attempt');
            await deps.store.revertReplacement(task.taskId, replacementTaskId);
            return recordSkip({ ...evaluation, eligible: false, reason: 'dispatch_failed' }, request);
        }
        await deps.store.setState(task.taskId, 'dispatched');
        await deps.store.appendEvent({
            taskId: task.taskId, event: 'replacement.dispatched', reason: `Replacement attempt ${attemptNumber} dispatched`, timestamp,
            metadata: {
                cause: request.cause,
                replacementTaskId,
                attemptNumber,
                maxReplacements: evaluation.maxReplacements,
                ...(task.branchName ? { branch: task.branchName } : {}),
                ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
                ...(request.error ? { failure: request.error.slice(0, 500) } : {}),
            },
        });
        await deps.publishTaskUpdate?.({
            taskId: replacementTaskId,
            state: 'pending',
            repository: task.repository,
            ...(task.issueNumber ? { issueNumber: task.issueNumber } : {}),
            timestamp,
            metadata: { replacesTaskId: task.taskId, attemptNumber, replacementCause: request.cause },
        });
        deps.logger?.info({ taskId: task.taskId, replacementTaskId, attemptNumber, cause: request.cause }, 'Dispatched task replacement attempt');
        const lineage = [...evaluation.lineage, {
            taskId: replacementTaskId, attemptNumber, replacementCause: request.cause, state: 'pending', costUsd: 0,
        }];
        return { action: 'dispatched', replacementTaskId, attemptNumber, lineage };
    }

    async function complete(request: ReplacementRequest): Promise<ReplacementOutcome> {
        const evaluation = await evaluate(request);
        if (evaluation.eligible) return dispatch(evaluation, request);
        if (evaluation.reason === null) return { action: 'none' };
        return recordSkip(evaluation, request);
    }

    return {
        async prepare(request) {
            const evaluation = await evaluate(request);
            if (evaluation.eligible) {
                await deps.store.markRequested(request.taskId, {
                    cause: request.cause,
                    ...(request.terminalReason ? { terminalReason: request.terminalReason } : {}),
                    requestedAt: now().toISOString(),
                });
            }
            return evaluation;
        },

        complete,

        async resumePending(options = {}) {
            const cutoff = new Date(now().getTime() - PENDING_REPLACEMENT_RECOVERY_MS).toISOString();
            const pending = await deps.store.listPendingRequests(cutoff, options.limit ?? 20);
            let resumed = 0;
            let cleared = 0;
            for (const entry of pending) {
                if (entry.latestState === 'failed') {
                    await complete({ taskId: entry.taskId, cause: entry.request.cause, terminalReason: entry.request.terminalReason });
                    resumed++;
                } else if (entry.latestState && TERMINAL_STATES.has(entry.latestState)) {
                    // Completed or cancelled after all; nothing replaces it.
                    await deps.store.setState(entry.taskId, null);
                    cleared++;
                }
            }
            return { resumed, cleared };
        },

        async lineage(taskId) {
            const task = await deps.store.loadTask(taskId);
            return task ? deps.store.loadLineage(task.lineageRootTaskId) : [];
        },

        formatAttempts,
    };
}
