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
import type {
    FailureNoticeRecord,
    LineageAttempt,
    ReplaceableTask,
    ReplacementRequestRecord,
    ReplayJobData,
    TaskReplacementStore,
} from './store.js';
import { createReplacementDelivery, REPLACEMENT_JOB_NAME, TERMINAL_STATES } from './delivery.js';
import { deliverExhaustedComment } from './exhaustedComment.js';

export { REPLACEMENT_JOB_NAME } from './delivery.js';
export { exhaustedCommentMarker, MAX_EXHAUSTED_COMMENT_ATTEMPTS } from './exhaustedComment.js';
/** A pending decision older than this is completed by the reconciler. */
export const PENDING_REPLACEMENT_RECOVERY_MS = 5 * 60 * 1000;

export interface ReplacementRequest {
    taskId: string;
    cause: ReplacementCause;
    /** Terminal reason of the failed run, when known. */
    terminalReason?: string | null;
    /** Failure message recorded with the timeline events. */
    error?: string;
    /**
     * `finalizedBy` of the failure transition the caller is about to write. The
     * decision is completed only if the task's latest transition carries it.
     */
    finalizedBy?: string;
}

export type ReplacementEvaluation =
    | {
        eligible: true;
        task: ReplaceableTask;
        lineage: LineageAttempt[];
        attemptNumber: number;
        maxReplacements: number;
        remainingBudgetUsd?: number;
        /** The pending decision `prepare` recorded, for `withdraw`. */
        request?: ReplacementRequestRecord;
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
    /** Claimed, but the queue did not confirm delivery; recovery redelivers the same job ID. */
    | { action: 'delivery_pending'; replacementTaskId: string; attemptNumber: number }
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
    /** Whether a comment containing `marker` is on the issue. */
    findIssueComment?(repoOwner: string, repoName: string, issueNumber: number, marker: string): Promise<boolean>;
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
    /**
     * Withdraws a decision `prepare` recorded when its failure was not written,
     * unless it changed since or a replacement was already claimed for it.
     */
    withdraw(taskId: string, request: ReplacementRequestRecord): Promise<boolean>;
    /**
     * Completes decisions a restart interrupted between `prepare` and `complete`, and
     * redelivers replacements claimed before their queue job was confirmed.
     */
    resumePending(options?: { limit?: number }): Promise<{ resumed: number; cleared: number }>;
    /**
     * Whether the task is a claimed replacement whose queue delivery is not confirmed
     * yet; reconciliation must leave it to `resumePending` rather than fail it as orphaned.
     */
    awaitingDelivery(taskId: string): Promise<boolean>;
    /** Attempts of the task's lineage, oldest first (just the task itself outside a lineage). */
    lineage(taskId: string): Promise<LineageAttempt[]>;
    /** Markdown list of a lineage's attempts with links to each task. */
    formatAttempts(lineage: LineageAttempt[]): string;
}

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

function lineageCostCap(replay: ReplayJobData): number | undefined {
    const cap = replay.lineageCostCapUsd;
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

/** The lineage's original cost cap minus what every attempt of the lineage spent, when a cap is set. */
function remainingBudget(replay: ReplayJobData, lineage: LineageAttempt[]): number | undefined {
    const cap = lineageCostCap(replay);
    if (cap === undefined) return undefined;
    const spent = lineage.reduce((total, attempt) => total + attempt.costUsd, 0);
    return Math.round((cap - spent) * 1e6) / 1e6;
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

    function lineageOrSelf(task: ReplaceableTask, lineage: LineageAttempt[]): LineageAttempt[] {
        return lineage.length > 0 ? lineage : [{
            taskId: task.taskId, attemptNumber: task.attemptNumber, replacementCause: task.replacementCause, state: task.latestState, costUsd: 0,
        }];
    }

    function newNotice(task: ReplaceableTask, fields: Omit<FailureNoticeRecord, 'id' | 'publish' | 'recordedAt'>): FailureNoticeRecord {
        // The failure alert was held back only while a replacement was expected.
        return { id: (deps.randomId ?? randomUUID)(), ...fields, publish: task.replacementState === 'pending', recordedAt: now().toISOString() };
    }

    /**
     * Runs the follow-up of a released decision: its timeline events, the final
     * comment of an exhausted lineage, and the held-back failure alert. The decision
     * is already released, so the alert projects as final; the notice is cleared
     * only after the comment was delivered too, and recovery repeats an interrupted
     * or failed follow-up.
     */
    async function deliverFailureNotice(task: ReplaceableTask, notice: FailureNoticeRecord, knownLineage?: LineageAttempt[]): Promise<void> {
        const { reason, cause, recordedAt: timestamp } = notice;
        let commentPending = false;
        if (reason) {
            await deps.store.appendEvent({
                taskId: task.taskId, event: 'replacement.skipped', reason: `Replacement skipped: ${describeReplacementSkip(reason)}`, timestamp,
                once: notice.id,
                metadata: {
                    reason, cause, noticeId: notice.id,
                    ...(notice.maxReplacements === undefined ? {} : { maxReplacements: notice.maxReplacements }),
                    ...(notice.failure ? { failure: notice.failure } : {}),
                    ...(notice.replacementTaskId ? { replacementTaskId: notice.replacementTaskId, attemptNumber: notice.attemptNumber } : {}),
                },
            });
        }
        if (reason && notice.exhausted) {
            const lineage = lineageOrSelf(task, knownLineage ?? await deps.store.loadLineage(task.lineageRootTaskId));
            await deps.store.appendEvent({
                taskId: task.taskId, event: 'replacement.exhausted', reason: `All ${lineage.length} attempts failed`, timestamp,
                once: notice.id,
                metadata: {
                    reason, cause, noticeId: notice.id,
                    ...(notice.maxReplacements === undefined ? {} : { maxReplacements: notice.maxReplacements }),
                    attempts: lineage.map(({ taskId, attemptNumber, state }) => ({ taskId, attemptNumber, state })),
                },
            });
            commentPending = !await deliverExhaustedComment(deps, task, notice, { count: lineage.length, formatted: formatAttempts(lineage) });
        }
        // A withdrawn decision awaited a failure that may never have been written.
        if (notice.publish && (reason || task.latestState === 'failed')) await deps.publishTaskUpdate?.({
            taskId: task.taskId,
            state: 'failed',
            repository: task.repository,
            ...(task.issueNumber ? { issueNumber: task.issueNumber } : {}),
            timestamp: now().toISOString(),
            ...(reason ? { metadata: { reason: `No replacement attempt: ${describeReplacementSkip(reason)}`, replacementSkipped: reason } } : {}),
        });
        if (commentPending) {
            // Recovery retries the comment; the alert is already out.
            if (notice.publish) await deps.store.updateFailureNotice(task.taskId, notice.id, { publish: false });
            return;
        }
        await deps.store.clearFailureNotice(task.taskId, notice.id);
    }

    /** Releases the decision as skipped (or exhausted) before anything projects its failure. */
    async function releaseSkipped(
        task: ReplaceableTask,
        state: 'skipped' | 'exhausted',
        fields: Omit<FailureNoticeRecord, 'id' | 'publish' | 'recordedAt'>,
        lineage?: LineageAttempt[],
    ): Promise<void> {
        const notice = newNotice(task, fields);
        await deps.store.recordSkipped(task.taskId, state, notice);
        await deliverFailureNotice(task, notice, lineage);
    }

    const delivery = createReplacementDelivery(deps, { now, releaseSkipped });

    async function recordSkip(
        evaluation: Extract<ReplacementEvaluation, { eligible: false; task: ReplaceableTask }>,
        request: ReplacementRequest,
    ): Promise<ReplacementOutcome> {
        const { task, reason, maxReplacements } = evaluation;
        const lineage = lineageOrSelf(task, evaluation.lineage);
        const exhausted = EXHAUSTING_REASONS.has(reason);
        await releaseSkipped(task, exhausted ? 'exhausted' : 'skipped', {
            cause: request.cause, reason, exhausted, maxReplacements,
            ...(request.error ? { failure: request.error.slice(0, 500) } : {}),
        }, lineage);
        deps.logger?.info({ taskId: task.taskId, cause: request.cause, reason, exhausted }, 'Task replacement skipped');
        return { action: 'skipped', reason, exhausted, lineage };
    }

    async function dispatch(
        evaluation: Extract<ReplacementEvaluation, { eligible: true }>,
        request: ReplacementRequest,
    ): Promise<ReplacementOutcome> {
        const { task, attemptNumber, remainingBudgetUsd } = evaluation;
        const originalCap = lineageCostCap(task.replayJobData!);
        // Lineage bookkeeping, not queue payload: the replacement's replay data carries it on.
        const replay: ReplayJobData = { ...task.replayJobData! };
        delete replay.lineageCostCapUsd;
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
            // The run's spend cap guard enforces the original cap minus what these attempts spent.
            ...(originalCap === undefined ? {} : { maxCostUsd: originalCap }),
            costBudgetTaskIds: [...new Set([...evaluation.lineage.map(attempt => attempt.taskId), task.taskId])],
        };
        const timestamp = now().toISOString();
        // Budgets are always recomputed from the original cap and the whole lineage's spend.
        const replayData: ReplayJobData = { ...jobData, ...(originalCap === undefined ? {} : { lineageCostCapUsd: originalCap }) };
        const failure = request.error?.slice(0, 500);
        const claimed = await deps.store.createReplacement({
            original: task, replacementTaskId, jobId, correlationId, attemptNumber, cause: request.cause, jobData, replayData, timestamp,
            maxReplacements: evaluation.maxReplacements,
            ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
            ...(failure ? { failure } : {}),
        });
        if (!claimed) return { action: 'none' };
        try {
            await deps.enqueue(REPLACEMENT_JOB_NAME, jobData, jobId);
        } catch (error) {
            // A rejected add does not prove the queue did not accept the job, so the claim
            // and its dispatch record stay pending; recovery redelivers the same job ID.
            deps.logger?.warn({ taskId: task.taskId, replacementTaskId, error: (error as Error).message },
                'Queue delivery of replacement attempt is unconfirmed; recovery will redeliver it');
            return { action: 'delivery_pending', replacementTaskId, attemptNumber };
        }
        await delivery.confirmDispatched(task, request.cause, {
            replacementTaskId, jobId, jobData, attemptNumber, maxReplacements: evaluation.maxReplacements,
            ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
            ...(failure ? { failure } : {}),
            claimedAt: timestamp,
        }, { timestamp, announceState: 'pending' });
        const lineage = [...evaluation.lineage, {
            taskId: replacementTaskId, attemptNumber, replacementCause: request.cause, state: 'pending', costUsd: 0,
        }];
        return { action: 'dispatched', replacementTaskId, attemptNumber, lineage };
    }

    async function withdraw(taskId: string, request: ReplacementRequestRecord): Promise<boolean> {
        // The failure alert was held back while this decision was pending.
        const notice: FailureNoticeRecord = {
            id: (deps.randomId ?? randomUUID)(), cause: request.cause, publish: true, recordedAt: now().toISOString(),
        };
        if (!await deps.store.withdrawRequest(taskId, request, notice)) return false;
        deps.logger?.info({ taskId, cause: request.cause, finalizedBy: request.finalizedBy }, 'Withdrew replacement decision');
        const task = await deps.store.loadTask(taskId);
        if (task) await deliverFailureNotice(task, notice);
        return true;
    }

    /** Withdraws a decision bound to a failure the task's latest transition was not. */
    async function withdrawUnbound(task: ReplaceableTask, finalizedBy: string): Promise<boolean> {
        const request = task.replacementState === 'pending' ? task.replacementRequest : null;
        if (!request || request.dispatch || request.finalizedBy !== finalizedBy) return false;
        return withdraw(task.taskId, request);
    }

    async function complete(request: ReplacementRequest): Promise<ReplacementOutcome> {
        if (request.finalizedBy) {
            const task = await deps.store.loadTask(request.taskId);
            if (task && !task.replacedByTaskId && task.latestFinalizedBy !== request.finalizedBy) {
                await withdrawUnbound(task, request.finalizedBy);
                return { action: 'none' };
            }
        }
        const evaluation = await evaluate(request);
        if (evaluation.eligible) return dispatch(evaluation, request);
        if (evaluation.reason === null) return { action: 'none' };
        return recordSkip(evaluation, request);
    }

    return {
        async prepare(request) {
            const evaluation = await evaluate(request);
            if (evaluation.eligible) {
                const record: ReplacementRequestRecord = {
                    cause: request.cause,
                    ...(request.terminalReason ? { terminalReason: request.terminalReason } : {}),
                    requestedAt: now().toISOString(),
                    ...(request.finalizedBy ? { finalizedBy: request.finalizedBy } : {}),
                };
                if (await deps.store.markRequested(request.taskId, record)) return { ...evaluation, request: record };
            }
            return evaluation;
        },

        complete,
        withdraw,

        async resumePending(options = {}) {
            const cutoff = new Date(now().getTime() - PENDING_REPLACEMENT_RECOVERY_MS).toISOString();
            const pending = await deps.store.listPendingRequests(cutoff, options.limit ?? 20);
            let resumed = 0;
            let cleared = 0;
            for (const entry of pending) {
                if (entry.replacedByTaskId && entry.request.dispatch) {
                    if (await delivery.resumeClaimed(entry.taskId, entry.request.cause, entry.request.dispatch)) resumed++;
                } else if (entry.request.finalizedBy && entry.latestState && TERMINAL_STATES.has(entry.latestState)
                    && entry.latestFinalizedBy !== entry.request.finalizedBy) {
                    // Another writer ended the task; the failure this decision awaited never happened.
                    if (await withdraw(entry.taskId, entry.request)) cleared++;
                } else if (entry.latestState === 'failed') {
                    await complete({
                        taskId: entry.taskId, cause: entry.request.cause, terminalReason: entry.request.terminalReason,
                        ...(entry.request.finalizedBy ? { finalizedBy: entry.request.finalizedBy } : {}),
                    });
                    resumed++;
                } else if (entry.latestState && TERMINAL_STATES.has(entry.latestState)) {
                    // Completed or cancelled after all; nothing replaces it.
                    await deps.store.setState(entry.taskId, null);
                    cleared++;
                }
            }
            // Released decisions whose events or failure alert an interruption left undelivered.
            for (const { taskId, notice } of await deps.store.listFailureNotices(cutoff, options.limit ?? 20)) {
                const task = await deps.store.loadTask(taskId);
                if (!task) continue;
                await deliverFailureNotice(task, notice);
                resumed++;
            }
            return { resumed, cleared };
        },

        awaitingDelivery: delivery.awaitingDelivery,

        async lineage(taskId) {
            const task = await deps.store.loadTask(taskId);
            return task ? deps.store.loadLineage(task.lineageRootTaskId) : [];
        },

        formatAttempts,
    };
}
