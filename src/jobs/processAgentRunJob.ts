import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AgentRunState } from '@propr/shared';
import {
    AgentRegistry,
    getAgentRunById,
    getAuthenticatedOctokit,
    getStateManager,
    listPreviousReports,
    logger,
    transitionAgentRun,
    UsageLimitError,
    validateAgentDefinitionRuntime,
    TaskStates,
    type Agent,
    type AgentRunJobData,
    type IssueRef,
    type JobResult,
    type StoredAgentDefinition,
    type StoredAgentRun,
    type WorkerStateManager,
} from '@propr/core';
import { agentTaskOptions } from './agentRuns/agentTaskOptions.js';
import { advanceAfterReport } from './agentRuns/autonomy.js';
import { buildAgentReportPrompt } from './agentRuns/reportPrompt.js';
import { AgentRunPersistenceError, AgentRunReportError, AgentRunSettlementError, reportFromResult } from './agentRuns/runErrors.js';
import { definitionReadsRepositories, prepareAgentRunWorkspace, splitRepository, type AgentRunWorkspace, type PrepareAgentRunWorkspace } from './agentRuns/workspace.js';
import type { GitHubToken } from './githubTypes.js';
import { compactNotificationRecap } from './notificationRecap.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { defaultRunCostCapDeps, withRunCostCap, writeTimelineEvent } from './runCostCap.js';

/**
 * Report-run executor for ProPR Agents.
 *
 * Turns a queued `agent_runs` row into an ordinary isolated task run (visible
 * in the Tasks UI, cancellable with `stopTaskExecution`) and stores the
 * agent's free-form report. Nothing is committed or pushed: the worktree
 * branch exists only so the shared worktree helpers can be reused.
 */

export { AgentRunPersistenceError, AgentRunSettlementError } from './agentRuns/runErrors.js';
export type { AgentRunToolPolicy } from './agentRuns/agentTaskOptions.js';

export const AGENT_RUN_USAGE_LIMIT_REASON = 'provider usage limit reached; trigger again later';
export const AGENT_RUN_ABANDONED_REASON = 'The worker running this report stopped before it finished; trigger the agent again';

export interface ResolvedAgentRunAgent {
    agent: Pick<Agent, 'executeTask'>;
    alias: string;
    model: string | undefined;
}

/** The run and report task one delivery is working on. */
interface RunContext { runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger }

export type AgentRunStateManager = Pick<WorkerStateManager, 'createTaskStateIfAbsent' | 'getTaskState' | 'updateTaskState' | 'markTaskCompleted' | 'markTaskFailed' | 'markTaskCancelled'>;

export interface AgentRunProcessorDeps {
    getRun: (runId: string) => Promise<StoredAgentRun | undefined>;
    transitionRun: typeof transitionAgentRun;
    validateDefinition: (definition: StoredAgentDefinition) => Promise<string | null>;
    listPreviousReports: typeof listPreviousReports;
    stateManager: () => AgentRunStateManager;
    /** Installation token and octokit used for cloning; read-only scoped inside agent containers. */
    getGitHubAccess: () => Promise<{ token: string; octokit: unknown }>;
    prepareWorkspace: PrepareAgentRunWorkspace;
    resolveAgent: (definition: StoredAgentDefinition, log: Logger) => Promise<ResolvedAgentRunAgent>;
    buildPrompt: typeof buildAgentReportPrompt;
    /** Runs the agent inside the instance spend cap (`default_max_cost_usd`). */
    withCostCap: <T>(target: { taskId: string; repoOwner: string; repoName: string; modelName?: string; logger: Logger }, operation: () => Promise<T>) => Promise<T>;
    advanceAfterReport: (run: StoredAgentRun) => Promise<StoredAgentRun | null>;
}

async function defaultResolveAgent(definition: StoredAgentDefinition, log: Logger): Promise<ResolvedAgentRunAgent> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    if (definition.agentAlias === null) {
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, log);
        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);
        return { agent, alias: resolvedAlias, model: resolvedModel };
    }
    const agent = registry.getAgentByAlias(definition.agentAlias);
    if (!agent) throw new Error(`Agent not found: ${definition.agentAlias}`);
    return { agent, alias: definition.agentAlias, model: definition.modelName ?? agent.config.defaultModel ?? undefined };
}

export const defaultAgentRunProcessorDeps: AgentRunProcessorDeps = {
    getRun: runId => getAgentRunById(runId),
    transitionRun: transitionAgentRun,
    validateDefinition: definition => validateAgentDefinitionRuntime(definition),
    listPreviousReports,
    stateManager: () => getStateManager(),
    getGitHubAccess: async () => {
        const octokit = await getAuthenticatedOctokit();
        const token = await octokit.auth({ type: 'installation' }) as GitHubToken;
        return { token: token.token, octokit };
    },
    prepareWorkspace: prepareAgentRunWorkspace,
    resolveAgent: defaultResolveAgent,
    buildPrompt: buildAgentReportPrompt,
    // A report run has no issue or pull request to comment on, so a spend-cap
    // stop is recorded on the task timeline only.
    withCostCap: (target, operation) => withRunCostCap(
        { ...target, number: 0, kind: 'issue' },
        () => operation(),
        { ...defaultRunCostCapDeps, recordExceeded: (capTarget, snapshot) => writeTimelineEvent(capTarget, snapshot) },
    ),
    advanceAfterReport: run => advanceAfterReport(run),
};

export function agentRunReportTaskId(runId: string): string {
    return `agent-run-${runId}-report`;
}

export function agentRunIssueRef(definition: StoredAgentDefinition): IssueRef {
    const primary = definition.repositories[0];
    const { owner, repo } = primary ? splitRepository(primary) : { owner: '', repo: '' };
    return {
        number: 0,
        repoOwner: owner,
        repoName: repo,
        type: 'agent-run',
        title: `Agent: ${definition.name}`,
        subtitle: 'Report run',
    };
}

/** First line of the report with content, compacted for the Inbox; a bare "Summary" heading is skipped. */
export function agentReportRecap(report: string): string | undefined {
    for (const line of report.split(/\r?\n/)) {
        const recap = compactNotificationRecap(line);
        if (recap) return recap;
    }
    return undefined;
}

const UNREADABLE_DEFINITION_REASON = 'The agent definition snapshot is unreadable';
const TERMINAL_TASK_STATES = new Set<string>([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

export function createAgentRunProcessor(overrides: Partial<AgentRunProcessorDeps> = {}) {
    const deps: AgentRunProcessorDeps = { ...defaultAgentRunProcessorDeps, ...overrides };

    /** Run ids this process is executing; a redelivery of one of them competes with a live attempt. */
    const activeRuns = new Set<string>();

    /**
     * Returns false when the run had already left `from` (another writer got
     * there first). Throws `AgentRunPersistenceError` when the transition
     * itself could not be stored.
     */
    async function failRun(runId: string, from: AgentRunState[], reason: string, log: Logger): Promise<boolean> {
        let failed: StoredAgentRun | null;
        try {
            failed = await deps.transitionRun(runId, from, 'failed', { failureReason: reason });
        } catch (error) {
            log.error({ runId, err: error }, 'Could not mark agent run failed');
            throw new AgentRunPersistenceError(runId, error);
        }
        if (!failed) log.info({ runId }, 'Agent run left its state before it could be marked failed');
        return failed !== null;
    }

    /**
     * Ends the task to match a run whose terminal state another writer set
     * (cancel endpoint, abandoned-run recovery). A task the cancel endpoint
     * already stopped stays as it is: terminal task states are never replaced.
     * Errors propagate as `AgentRunSettlementError` so the delivery is retried,
     * and the redelivery reconciles the task from the run.
     */
    async function settleTaskWithRun(
        { runId, taskId, stateManager, log }: { runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger },
    ): Promise<AgentRunState | null> {
        try {
            const current = await deps.getRun(runId);
            if (current?.state === 'cancelled') {
                await stateManager.markTaskCancelled(taskId, 'system', { reason: 'Agent run was cancelled' });
            } else if (current?.state === 'failed') {
                await stateManager.markTaskFailed(taskId, new Error(current.failureReason ?? 'Agent run failed'));
            } else {
                log.warn({ runId, taskId, state: current?.state ?? null }, 'Agent run task left unsettled: run is not cancelled or failed');
            }
            return current?.state ?? null;
        } catch (error) {
            log.error({ runId, taskId, err: error }, 'Could not settle agent run task');
            throw new AgentRunSettlementError(runId, taskId, error);
        }
    }

    /** Ends the task with a run another writer cancelled or failed; reports the run's end. */
    async function taskFollowsEndedRun(context: RunContext, correlationId: string): Promise<JobResult> {
        const state = await settleTaskWithRun(context);
        return { status: state === 'failed' ? 'failed' : 'cancelled', runId: context.runId, taskId: context.taskId, correlationId };
    }

    /** Fails the task of a run already stored as failed; errors propagate so the delivery is retried. */
    async function markRunTaskFailed(
        { runId, taskId, stateManager, log }: { runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger },
        error: Error,
    ): Promise<void> {
        try {
            await stateManager.markTaskFailed(taskId, error);
        } catch (stateError) {
            log.error({ runId, taskId, err: stateError }, 'Could not mark agent run task failed');
            throw new AgentRunSettlementError(runId, taskId, stateError);
        }
    }

    /** Fails a claimed run and its task; returns the stored failure reason. */
    async function failRunningRun(
        { runId, taskId, stateManager, log }: { runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger },
        error: unknown,
    ): Promise<string> {
        const usageLimit = error instanceof UsageLimitError;
        const reason = usageLimit ? AGENT_RUN_USAGE_LIMIT_REASON : (error as Error).message;
        log[error instanceof AgentRunReportError ? 'warn' : 'error']({ runId, taskId, err: error }, 'Agent run report failed');
        if (!await failRun(runId, ['running', 'report_ready'], reason, log)) {
            // Cancelled meanwhile: the task follows the run, not this failure.
            await settleTaskWithRun({ runId, taskId, stateManager, log });
            return reason;
        }
        await markRunTaskFailed({ runId, taskId, stateManager, log }, usageLimit ? new Error(reason) : error as Error);
        return reason;
    }

    /**
     * Settles a claimed run whose execution threw. A task stopped directly
     * cancels the run instead of failing it. If the task cannot be read or the
     * run cannot be cancelled, the failure is recorded so the run still ends.
     */
    async function settleExecutionError(context: RunContext, error: unknown, correlationId: string): Promise<JobResult> {
        try {
            const stopped = await followCancelledTask(context, correlationId, 'before its run failed');
            if (stopped) return stopped;
        } catch (checkError) {
            if (checkError instanceof AgentRunSettlementError) throw checkError;
            context.log.error({ runId: context.runId, taskId: context.taskId, err: checkError }, 'Could not check whether the agent run task was cancelled');
        }
        const reason = await failRunningRun(context, error);
        return { status: 'failed', runId: context.runId, taskId: context.taskId, reason, correlationId };
    }

    /** The run left `running` (cancelled, or failed as abandoned) while the agent was executing. */
    async function discardLateReport(
        context: { runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger },
        correlationId: string,
    ): Promise<JobResult> {
        const { runId, taskId, log } = context;
        log.info({ runId, taskId }, 'Agent run left running before its report was stored');
        // The cancel endpoint may have failed to stop the task; end it with the run.
        return taskFollowsEndedRun(context, correlationId);
    }

    /**
     * A redelivered job whose run is still `running`. BullMQ only redelivers an
     * active job once its lock lapsed, i.e. the claiming worker died (process
     * termination skips catch/finally) or stopped renewing its lock. Executing
     * again could double-run the agent, so the abandoned run and task are
     * failed; a delivery competing with an attempt still live in this process
     * is skipped instead.
     */
    async function recoverAbandonedRun(run: StoredAgentRun, correlationId: string, log: Logger): Promise<JobResult> {
        const runId = run.id;
        const taskId = run.reportTaskId ?? agentRunReportTaskId(runId);
        if (activeRuns.has(runId)) {
            log.warn({ runId, taskId }, 'Agent run is already executing in this worker; ignoring duplicate delivery');
            return { status: 'skipped', runId, taskId, correlationId };
        }
        log.warn({ runId, taskId }, 'Agent run was left running by an interrupted worker; failing it');
        const stateManager = deps.stateManager();
        // A task stopped directly before the worker stopped cancels the run instead.
        const taskStopped = await followCancelledTask({ runId, taskId, stateManager, log }, correlationId, 'before its worker stopped');
        if (taskStopped) return taskStopped;
        if (!await failRun(runId, ['running'], AGENT_RUN_ABANDONED_REASON, log)) {
            const state = await settleTaskWithRun({ runId, taskId, stateManager, log });
            return { status: state === 'cancelled' ? 'cancelled' : 'skipped', runId, taskId, correlationId };
        }
        await markRunTaskFailed({ runId, taskId, stateManager, log }, new Error(AGENT_RUN_ABANDONED_REASON));
        return { status: 'failed', runId, taskId, reason: AGENT_RUN_ABANDONED_REASON, correlationId };
    }

    /**
     * Advances a run whose report is stored and completes its report task.
     * Idempotent, so a redelivery after an interrupted attempt can finish it:
     * a run already advanced is not advanced again, and a task that already
     * ended is left as it is. Errors propagate so the delivery is retried.
     */
    async function finalizeReportedRun(
        { run, taskId, stateManager, log }: { run: StoredAgentRun; taskId: string; stateManager: AgentRunStateManager; log: Logger },
    ): Promise<StoredAgentRun | null> {
        let settled = run.state === 'report_ready' ? await deps.advanceAfterReport(run) : run;
        // Another writer moved the run on; follow what it stored.
        if (!settled) settled = await deps.getRun(run.id) ?? null;
        if (!settled || (settled.state !== 'report_ready' && settled.state !== 'completed')) {
            await settleTaskWithRun({ runId: run.id, taskId, stateManager, log });
            return settled;
        }
        const task = await stateManager.getTaskState(taskId);
        if (task && !TERMINAL_TASK_STATES.has(task.state)) {
            await stateManager.markTaskCompleted(taskId, { status: 'complete', notificationRecap: agentReportRecap(settled.report ?? run.report ?? '') });
        }
        return settled;
    }

    /**
     * A redelivered job whose report is already stored: the worker stopped
     * between storing the report and finishing the run or its task. The agent
     * is not executed again; only the remaining lifecycle steps run.
     */
    async function recoverReportedRun(run: StoredAgentRun, correlationId: string, log: Logger): Promise<JobResult> {
        const runId = run.id;
        const taskId = run.reportTaskId ?? agentRunReportTaskId(runId);
        if (activeRuns.has(runId)) {
            log.warn({ runId, taskId }, 'Agent run is already finishing in this worker; ignoring duplicate delivery');
            return { status: 'skipped', runId, taskId, correlationId };
        }
        log.info({ runId, taskId, state: run.state }, 'Finishing agent run whose report was stored by an interrupted attempt');
        const settled = await finalizeReportedRun({ run, taskId, stateManager: deps.stateManager(), log });
        return reportedRunResult(settled, { runId, taskId, correlationId });
    }

    function reportedRunResult(settled: StoredAgentRun | null, ids: { runId: string; taskId: string; correlationId: string }): JobResult {
        const state = settled?.state ?? null;
        if (state === 'report_ready' || state === 'completed') return { status: 'complete', ...ids, state };
        return { status: state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'skipped', ...ids };
    }

    /** Entry for a delivery whose run is no longer `queued`. */
    async function handleUnqueuedRun(
        run: StoredAgentRun | undefined,
        { runId, correlationId, log }: { runId: string; correlationId: string; log: Logger },
    ): Promise<JobResult> {
        if (run?.state === 'running') return recoverAbandonedRun(run, correlationId, log);
        if (run?.report != null && (run.state === 'report_ready' || run.state === 'completed')) {
            return recoverReportedRun(run, correlationId, log);
        }
        if (run?.state === 'failed' || run?.state === 'cancelled') return reconcileEndedRun(run, correlationId, log);
        log.info({ runId, state: run?.state ?? null }, 'Agent run is not queued; skipping');
        return { status: 'skipped', runId, correlationId };
    }

    /**
     * A redelivered job whose run already failed or was cancelled. An earlier
     * attempt may have stored the run's end and stopped before its task
     * followed; the task is ended now. A run that never got a task is skipped.
     */
    async function reconcileEndedRun(run: StoredAgentRun, correlationId: string, log: Logger): Promise<JobResult> {
        const runId = run.id;
        const taskId = run.reportTaskId ?? agentRunReportTaskId(runId);
        const stateManager = deps.stateManager();
        const task = await stateManager.getTaskState(taskId);
        if (!task || TERMINAL_TASK_STATES.has(task.state)) {
            log.info({ runId, state: run.state }, 'Agent run is not queued; skipping');
            return { status: 'skipped', runId, correlationId };
        }
        log.warn({ runId, taskId, state: run.state, taskState: task.state }, 'Ending the task of an agent run that already ended');
        const state = await settleTaskWithRun({ runId, taskId, stateManager, log });
        return { status: state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'skipped', runId, taskId, correlationId };
    }

    /**
     * The run or its task may have been cancelled while the workspace was
     * prepared (the cancel endpoint stops the task before any container
     * exists). Returns the settled result when execution must not start;
     * a cancel concurrent with the launch itself is left to the execution layer.
     */
    async function stoppedBeforeLaunch(context: RunContext, correlationId: string): Promise<JobResult | null> {
        const { runId, taskId, log } = context;
        const current = await deps.getRun(runId);
        if (current?.state !== 'running') {
            log.info({ runId, taskId, state: current?.state ?? null }, 'Agent run left running before its agent started');
            return taskFollowsEndedRun(context, correlationId);
        }
        return followCancelledTask(context, correlationId, 'before its agent started');
    }

    /**
     * The task was stopped directly (Tasks UI `stopTaskExecution`), which does
     * not touch the run: the still-running run follows the task to `cancelled`
     * and whatever the agent produced is discarded. Returns null while the
     * task is not cancelled. The task store and the run store are separate,
     * so a stop landing after this check is not seen by it.
     */
    async function followCancelledTask(context: RunContext, correlationId: string, when: string): Promise<JobResult | null> {
        const { runId, taskId, stateManager, log } = context;
        const task = await stateManager.getTaskState(taskId);
        if (task?.state !== TaskStates.CANCELLED) return null;
        log.info({ runId, taskId }, `Agent run task was cancelled ${when}`);
        const cancelled = await deps.transitionRun(runId, ['running'], 'cancelled');
        if (!cancelled) return taskFollowsEndedRun(context, correlationId);
        return { status: 'cancelled', runId, taskId, correlationId };
    }

    /**
     * The `queued → running` claim lost to another writer. Only a run that
     * actually ended (cancelled or failed) has its shared task ended to match;
     * a run another delivery claimed (a stalled-job redelivery that read the
     * run after this one) is left with its task to that claimant.
     */
    async function claimLost(context: RunContext, correlationId: string): Promise<JobResult> {
        const { runId, taskId, log } = context;
        const current = await deps.getRun(runId);
        if (current?.state !== 'cancelled' && current?.state !== 'failed') {
            log.warn({ runId, taskId, state: current?.state ?? null }, 'Agent run was claimed by another delivery; leaving it and its task alone');
            return { status: 'skipped', runId, taskId, correlationId };
        }
        log.info({ runId, taskId, state: current.state }, 'Agent run ended before it started');
        return taskFollowsEndedRun(context, correlationId);
    }

    async function invalidDefinitionReason(definition: StoredAgentDefinition | null): Promise<string | null> {
        return definition ? deps.validateDefinition(definition) : UNREADABLE_DEFINITION_REASON;
    }

    async function previousReportsFor(definition: StoredAgentDefinition, run: StoredAgentRun) {
        if (!definition.includePreviousReports) return [];
        return deps.listPreviousReports(definition.id, {
            limit: definition.previousReportsLimit,
            beforeCreatedAt: run.createdAt,
            excludeRunId: run.id,
        });
    }

    /** Only a checkout needs installation credentials; a repository-free run must not depend on them. */
    async function gitHubAccessFor(definition: StoredAgentDefinition): Promise<{ token: string; octokit: unknown }> {
        return definitionReadsRepositories(definition) ? deps.getGitHubAccess() : { token: '', octokit: undefined };
    }

    return async function processAgentRun(job: Job<AgentRunJobData>): Promise<JobResult> {
        const { runId, correlationId } = job.data;
        const log: Logger = logger.withCorrelation(correlationId);

        // 1. A run cancelled or skipped before pickup does nothing; one left
        //    running by an interrupted attempt is recovered, and one whose
        //    report was stored has its remaining lifecycle steps finished.
        const run = await deps.getRun(runId);
        if (!run || run.state !== 'queued') return handleUnqueuedRun(run, { runId, correlationId, log });

        // 2. Execute the definition as it was when the run was triggered.
        const definition = run.definitionSnapshot;
        const invalid = await invalidDefinitionReason(definition);
        if (!definition || invalid) {
            await failRun(runId, ['queued'], invalid ?? UNREADABLE_DEFINITION_REASON, log);
            return { status: 'failed', runId, reason: invalid, correlationId };
        }

        // 3. The receipt in the Tasks UI.
        const taskId = agentRunReportTaskId(runId);
        const issueRef = agentRunIssueRef(definition);
        const stateManager = deps.stateManager();
        await stateManager.createTaskStateIfAbsent(taskId, issueRef, correlationId, job.id === undefined ? null : String(job.id));

        // 4. Claim the run; null means another writer moved it first.
        const running = await deps.transitionRun(runId, ['queued'], 'running', { reportTaskId: taskId });
        if (!running) return claimLost({ runId, taskId, stateManager, log }, correlationId);

        activeRuns.add(runId);
        let workspace: AgentRunWorkspace | undefined;
        let reportStored = false;
        try {
            await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Preparing agent workspace' });
            const { token, octokit } = await gitHubAccessFor(definition);

            // 5. Sandboxed checkout, or an empty git directory without repository_read.
            workspace = await deps.prepareWorkspace({ runId, definition, githubToken: token, octokit, logger: log });

            // 6. Previous reports and the prompt.
            const previousReports = await previousReportsFor(definition, run);
            const prompt = deps.buildPrompt({
                definition,
                run: { id: run.id, trigger: run.trigger, triggerSource: run.triggerSource, createdAt: run.createdAt },
                previousReports,
                attachments: workspace.attachments,
                workspace: workspace.promptWorkspace,
            });

            // 7. Execute in a container within the spend cap.
            const { agent, alias, model } = await deps.resolveAgent(definition, log);
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: `Running agent ${alias}` });
            const stopped = await stoppedBeforeLaunch({ runId, taskId, stateManager, log }, correlationId);
            if (stopped) return stopped;
            const options = agentTaskOptions({ runId, taskId, definition, issueRef, prompt, model, token, workspace });
            const result = await deps.withCostCap(
                { taskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, modelName: model, logger: log },
                () => agent.executeTask(options),
            );

            // 8. A task stopped directly during execution discards the result.
            const taskStopped = await followCancelledTask({ runId, taskId, stateManager, log }, correlationId, 'while its agent was executing');
            if (taskStopped) return taskStopped;

            // The report is the agent's final message.
            const report = reportFromResult(result);

            // 9. Store the report, then advance by autonomy mode.
            await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Storing agent report' });
            // A stop landing during that update keeps the task cancelled; the run must follow it
            // before the report is stored, since a reported run can no longer be cancelled.
            const stoppedBeforeReport = await followCancelledTask({ runId, taskId, stateManager, log }, correlationId, 'before its report was stored');
            if (stoppedBeforeReport) return stoppedBeforeReport;
            const reported = await deps.transitionRun(runId, ['running'], 'report_ready', { report });
            if (!reported) {
                return discardLateReport({ runId, taskId, stateManager, log }, correlationId);
            }
            reportStored = true;

            // 10. Close the task. A redelivery repeats this if it is interrupted.
            const settled = await finalizeReportedRun({ run: reported, taskId, stateManager, log });
            log.info({ runId, taskId, agentAlias: alias, model, state: settled?.state ?? null }, 'Agent run report stored');
            return reportedRunResult(settled, { runId, taskId, correlationId });
        } catch (error) {
            // The report is kept; the retried delivery finishes the run.
            // A task that could not follow its run is reconciled by the retry.
            if (reportStored || error instanceof AgentRunSettlementError) throw error;
            return settleExecutionError({ runId, taskId, stateManager, log }, error, correlationId);
        } finally {
            // 11. Nothing was committed or pushed; just remove the workspace.
            activeRuns.delete(runId);
            await workspace?.cleanup();
        }
    };
}

export const processAgentRunJob = createAgentRunProcessor();

/**
 * Placeholder for the acting phase (issue 10). The run is failed explicitly so
 * it does not stay `acting` forever.
 */
export async function processAgentActionJob(job: Job<AgentRunJobData>): Promise<JobResult> {
    const message = `Not implemented: agent run ${job.data.phase} phase`;
    try {
        await transitionAgentRun(job.data.runId, ['acting'], 'failed', { failureReason: message });
    } catch (error) {
        logger.error({ runId: job.data.runId, err: error }, 'Could not mark agent run failed');
    }
    throw new Error(message);
}
