import { runWithNetworkPolicy } from './networkEgress.js';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
    claimAgentRunAction,
    createAgentRunCostGate,
    logger,
    pauseUnclaimedAgentRunAction,
    recordAgentRunActingMutations,
    TaskStates,
    transitionAgentRun,
    UsageLimitError,
    type AgentRunGate,
    type AgentRunJobData,
    type AgentRunTransitionPatch,
    type IssueRef,
    type JobResult,
    type StoredAgentDefinition,
    type StoredAgentRun,
} from '@propr/core';
import { buildAgentActionPrompt } from './agentRuns/actionPrompt.js';
import { agentRunExecutionUpdate, agentTaskOptions } from './agentRuns/agentTaskOptions.js';
import { actingPausedReason, notifyAgentReportAwaitingApproval } from './agentRuns/autonomy.js';
import { requestAgentRunMcpGrant, revokeAgentRunMcpGrant, revokeGrantQuietly, type IssuedAgentRunMcpGrant } from './agentRuns/mcpGrantClient.js';
import { actionSummaryFromResult, AgentRunPersistenceError, AgentRunReportError, AgentRunSettlementError } from './agentRuns/runErrors.js';
import { definitionReadsRepositories, type AgentRunWorkspace, type PrepareAgentRunWorkspace } from './agentRuns/workspace.js';
import {
    AGENT_RUN_USAGE_LIMIT_REASON,
    agentReportRecap,
    agentRunIssueRef,
    defaultAgentRunProcessorDeps,
    type AgentRunProcessorDeps,
    type AgentRunStateManager,
} from './processAgentRunJob.js';

/**
 * Acting-step executor for ProPR Agents.
 *
 * A second ordinary isolated task run whose input is the stored report and
 * whose only means of acting is the ProPR MCP tools, reached through a grant
 * issued for this phase and revoked when it ends. ProPR itself never parses
 * the report; all judgment about what to do lives in the acting agent.
 */

export const AGENT_ACTION_ABANDONED_REASON = 'The worker running the acting step stopped before it finished; trigger the agent again';

export interface AgentActionProcessorDeps extends Pick<AgentRunProcessorDeps,
    'getRun' | 'transitionRun' | 'validateDefinition' | 'stateManager' | 'getGitHubAccess' | 'resolveAgent' | 'withCostCap' | 'mcpGrants' | 'evaluateStreak'> {
    /** Records the action task on an `acting` run; null when another delivery claimed it first. */
    claimAction: (runId: string, actionTaskId: string) => Promise<StoredAgentRun | null>;
    prepareWorkspace: PrepareAgentRunWorkspace;
    buildPrompt: typeof buildAgentActionPrompt;
    /**
     * Cost gate (issue 11), re-checked for acting steps no human approved:
     * usage may have crossed the threshold while the action job was queued.
     */
    gate: AgentRunGate;
    /** Returns an unclaimed, unapproved `acting` run to `awaiting_approval`; null when it was claimed or left `acting`. */
    pauseAction: (runId: string, skipReason: string) => Promise<StoredAgentRun | null>;
    /** Tells the owner a held-back run waits for approval; best-effort. */
    notifyAwaitingApproval: (run: StoredAgentRun) => Promise<void>;
    /**
     * Stores the grant's mutation count on a run another writer failed or cancelled
     * while this acting step held the grant; null when no such run matched.
     */
    recordMutations: (runId: string, record: { actionTaskId: string; actingMutations: number }) => Promise<StoredAgentRun | null>;
}

export const defaultAgentActionProcessorDeps: AgentActionProcessorDeps = {
    getRun: defaultAgentRunProcessorDeps.getRun,
    transitionRun: transitionAgentRun,
    validateDefinition: defaultAgentRunProcessorDeps.validateDefinition,
    stateManager: defaultAgentRunProcessorDeps.stateManager,
    getGitHubAccess: defaultAgentRunProcessorDeps.getGitHubAccess,
    resolveAgent: defaultAgentRunProcessorDeps.resolveAgent,
    withCostCap: defaultAgentRunProcessorDeps.withCostCap,
    mcpGrants: { request: requestAgentRunMcpGrant, revoke: revokeAgentRunMcpGrant },
    evaluateStreak: defaultAgentRunProcessorDeps.evaluateStreak,
    claimAction: (runId, actionTaskId) => claimAgentRunAction(runId, actionTaskId),
    prepareWorkspace: defaultAgentRunProcessorDeps.prepareWorkspace,
    buildPrompt: buildAgentActionPrompt,
    gate: createAgentRunCostGate(),
    pauseAction: (runId, skipReason) => pauseUnclaimedAgentRunAction(runId, skipReason),
    notifyAwaitingApproval: run => notifyAgentReportAwaitingApproval(run),
    recordMutations: (runId, record) => recordAgentRunActingMutations(runId, record),
};

/**
 * Whether the acting agent is told it may merge: the definition asks with the
 * `merge` capability and the grant actually holds the scope. An instance scope
 * ceiling that withholds it is logged, since the automation's prompt likely
 * expects merges to happen.
 */
export function actionMayMerge(definition: Pick<StoredAgentDefinition, 'id' | 'capabilities'>, grant: Pick<IssuedAgentRunMcpGrant, 'grantId' | 'scopes'>, log: Logger): boolean {
    if (!definition.capabilities.includes('merge')) return false;
    if (grant.scopes.includes('merge')) return true;
    log.warn({ definitionId: definition.id, grantId: grant.grantId, scopes: grant.scopes },
        'Automation has the merge capability, but the MCP grant was issued without the merge scope: the instance scope ceiling excludes merge, so the acting step cannot merge pull requests');
    return false;
}

export function agentRunActionTaskId(runId: string): string {
    return `agent-run-${runId}-action`;
}

export function agentRunActionIssueRef(definition: StoredAgentDefinition): IssueRef {
    return { ...agentRunIssueRef(definition), subtitle: 'Acting on report' };
}

const UNREADABLE_DEFINITION_REASON = 'The agent definition snapshot is unreadable';
const MISSING_REPORT_REASON = 'The run has no stored report to act on';
const TERMINAL_TASK_STATES = new Set<string>([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

interface ActionContext {
    runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger; correlationId: string;
    /**
     * Mutating operations the acting grant performed, set once the grant has ended
     * (null when that count is unknown), so whichever state ends the run keeps it.
     */
    actingMutations?: number | null;
}

/** The ended grant's count as a transition patch; nothing while it is held or unknown. */
function mutationsPatch(context: ActionContext): AgentRunTransitionPatch {
    return typeof context.actingMutations === 'number' ? { actingMutations: context.actingMutations } : {};
}

export function createAgentActionProcessor(overrides: Partial<AgentActionProcessorDeps> = {}) {
    const deps: AgentActionProcessorDeps = { ...defaultAgentActionProcessorDeps, ...overrides };

    /** Run ids whose acting step this process is executing. */
    const activeRuns = new Set<string>();

    /** acting → failed; false when the run already left `acting`. Persistence errors are retried. */
    async function failActingRun(runId: string, reason: string, log: Logger, patch: AgentRunTransitionPatch = {}): Promise<boolean> {
        try {
            return await deps.transitionRun(runId, ['acting'], 'failed', { ...patch, failureReason: reason }) !== null;
        } catch (error) {
            log.error({ runId, err: error }, 'Could not mark agent run failed');
            throw new AgentRunPersistenceError(runId, error);
        }
    }

    /** Wraps task-store writes so a failure is retried by the next delivery. */
    async function settleTask(context: ActionContext, write: (stateManager: AgentRunStateManager) => Promise<unknown>): Promise<void> {
        try {
            await write(context.stateManager);
        } catch (error) {
            context.log.error({ runId: context.runId, taskId: context.taskId, err: error }, 'Could not settle agent run action task');
            throw new AgentRunSettlementError(context.runId, context.taskId, error);
        }
    }

    /**
     * A run another writer failed or cancelled while this acting step held its grant
     * still keeps what the grant changed. Best effort: the run has already ended.
     */
    async function keepMutationsOfEndedRun(context: ActionContext): Promise<void> {
        const { runId, taskId, log, actingMutations } = context;
        if (typeof actingMutations !== 'number') return;
        await deps.recordMutations(runId, { actionTaskId: taskId, actingMutations }).catch(error => {
            log.warn({ runId, taskId, actingMutations, err: error }, 'Could not store the acting step mutation count on its ended run');
        });
    }

    /**
     * Ends a still-open action task to match a run another writer ended
     * (cancel endpoint, a failure stored by an earlier attempt).
     */
    async function taskFollowsRun(context: ActionContext): Promise<JobResult> {
        const { runId, taskId, correlationId } = context;
        await keepMutationsOfEndedRun(context);
        const current = await deps.getRun(runId);
        const task = await context.stateManager.getTaskState(taskId);
        if (task && !TERMINAL_TASK_STATES.has(task.state)) {
            if (current?.state === 'cancelled') {
                await settleTask(context, manager => manager.markTaskCancelled(taskId, 'system', { reason: 'Agent run was cancelled' }));
            } else if (current?.state === 'failed') {
                await settleTask(context, manager => manager.markTaskFailed(taskId, new Error(current.failureReason ?? 'Agent run failed')));
            } else if (current?.state === 'completed') {
                await settleTask(context, manager => manager.markTaskCompleted(taskId, { status: 'complete', notificationRecap: agentReportRecap(current.actionSummary ?? '') }));
            }
        }
        const state = current?.state ?? null;
        const status = state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : state === 'completed' ? 'complete' : 'skipped';
        return { status, runId, taskId, correlationId };
    }

    /** Fails the acting run and its task, unless the run already ended another way. */
    async function failRunAndTask(context: ActionContext, error: unknown): Promise<JobResult> {
        const { runId, taskId, log, correlationId } = context;
        const usageLimit = error instanceof UsageLimitError;
        const reason = usageLimit ? AGENT_RUN_USAGE_LIMIT_REASON : (error as Error).message;
        log[error instanceof AgentRunReportError ? 'warn' : 'error']({ runId, taskId, err: error }, 'Agent run acting step failed');
        if (!await failActingRun(runId, reason, log, mutationsPatch(context))) return taskFollowsRun(context);
        await settleTask(context, manager => manager.markTaskFailed(taskId, usageLimit ? new Error(reason) : error as Error));
        return { status: 'failed', runId, taskId, reason, correlationId };
    }

    /** A task stopped directly from the Tasks UI cancels the run; null while it is not cancelled. */
    async function followCancelledTask(context: ActionContext, when: string): Promise<JobResult | null> {
        const { runId, taskId, log, correlationId } = context;
        const task = await context.stateManager.getTaskState(taskId);
        if (task?.state !== TaskStates.CANCELLED) return null;
        log.info({ runId, taskId }, `Agent run action task was cancelled ${when}`);
        const cancelled = await deps.transitionRun(runId, ['acting'], 'cancelled', mutationsPatch(context));
        if (!cancelled) return taskFollowsRun(context);
        return { status: 'cancelled', runId, taskId, correlationId };
    }

    /**
     * A delivery for a run whose action task was already recorded: another
     * delivery claimed it. One still live in this process is left alone; one
     * left behind by a worker that stopped is failed rather than run twice.
     */
    async function recoverClaimedRun(run: StoredAgentRun, context: ActionContext): Promise<JobResult> {
        const { runId, taskId, log, correlationId } = context;
        if (activeRuns.has(runId)) {
            log.warn({ runId, taskId }, 'Agent run acting step is already executing in this worker; ignoring duplicate delivery');
            return { status: 'skipped', runId, taskId, correlationId };
        }
        log.warn({ runId, taskId }, 'Agent run acting step was left running by an interrupted worker; failing it');
        const stopped = await followCancelledTask(context, 'before its worker stopped');
        if (stopped) return stopped;
        return failRunAndTask(context, new AgentRunReportError(AGENT_ACTION_ABANDONED_REASON));
    }

    /** Reasons the acting step must not start, checked before any task or container exists. */
    async function preflightFailure(run: StoredAgentRun, definition: StoredAgentDefinition | null): Promise<string | null> {
        if (!definition) return UNREADABLE_DEFINITION_REASON;
        const invalid = await deps.validateDefinition(definition);
        if (invalid) return invalid;
        if (!run.report?.trim()) return MISSING_REPORT_REASON;
        return null;
    }

    /**
     * The cost gate's reason for holding back an acting step no human approved,
     * or null when it may start. The gate already let `manual` runs through.
     */
    async function capacityHold(run: StoredAgentRun, definition: StoredAgentDefinition): Promise<string | null> {
        if (run.approvedBy !== null) return null;
        const decision = await deps.gate({ definition, trigger: run.trigger, triggerSource: run.triggerSource, run });
        return !decision || decision.action === 'proceed' ? null : decision.reason;
    }

    /** Hands a held-back acting step back to its owner, before any task or container exists. */
    async function pauseForApproval(context: ActionContext, gateReason: string): Promise<JobResult> {
        const { runId, log, correlationId } = context;
        const reason = actingPausedReason(gateReason);
        const waiting = await deps.pauseAction(runId, reason);
        if (!waiting) return taskFollowsRun(context);
        log.info({ runId, reason }, 'Agent run acting step paused by the cost gate');
        // The run already waits for its owner; a lost Inbox item must not undo that.
        await deps.notifyAwaitingApproval(waiting).catch(error => {
            log.warn({ runId, err: error }, 'Could not notify the owner that an agent report awaits approval');
        });
        return { status: 'skipped', runId, reason, correlationId };
    }

    async function gitHubAccessFor(definition: StoredAgentDefinition): Promise<{ token: string; octokit: unknown }> {
        return definitionReadsRepositories(definition) ? deps.getGitHubAccess() : { token: '', octokit: undefined };
    }

    // eslint-disable-next-line complexity -- one linear lifecycle: preflight, claim, execute, settle
    return async function processAgentAction(job: Job<AgentRunJobData>): Promise<JobResult> {
        const { runId, correlationId } = job.data;
        const log: Logger = logger.withCorrelation(correlationId);
        const taskId = agentRunActionTaskId(runId);
        const stateManager = deps.stateManager();
        const context: ActionContext = { runId, taskId, stateManager, log, correlationId };

        // 1. Only an `acting` run is acted on: dry runs, rejections and cancels never get here.
        const run = await deps.getRun(runId);
        if (!run || run.state !== 'acting') {
            if (run?.actionTaskId) return taskFollowsRun(context);
            log.info({ runId, state: run?.state ?? null }, 'Agent run is not acting; skipping');
            return { status: 'skipped', runId, correlationId };
        }
        if (run.actionTaskId) return recoverClaimedRun(run, context);

        // 2. The definition as it was when the run was triggered, its report and the cost gate.
        const definition = run.definitionSnapshot;
        const refused = await preflightFailure(run, definition);
        if (!definition || refused) {
            const reason = refused ?? UNREADABLE_DEFINITION_REASON;
            log.warn({ runId, reason }, 'Agent run acting step refused');
            await failActingRun(runId, reason, log);
            return { status: 'failed', runId, reason, correlationId };
        }
        const held = await capacityHold(run, definition);
        if (held) return pauseForApproval(context, held);

        // 3. The receipt in the Tasks UI, then the claim.
        const issueRef = agentRunActionIssueRef(definition);
        await stateManager.createTaskStateIfAbsent(taskId, issueRef, correlationId, job.id === undefined ? null : String(job.id));
        const claimed = await deps.claimAction(runId, taskId);
        if (!claimed) {
            log.info({ runId, taskId }, 'Agent run acting step was claimed or ended by another writer');
            return taskFollowsRun(context);
        }

        activeRuns.add(runId);
        let workspace: AgentRunWorkspace | undefined;
        let actionSucceeded = false;
        let mcpGrant: IssuedAgentRunMcpGrant | null = null;
        /**
         * Ends the grant once, before the run's final state is written, so the count of what
         * it changed is final and stored with that state, whichever it is: completed, failed
         * or cancelled. An unknown count (the revoke failed) stays null rather than reading as a no-op.
         */
        const endGrant = async (): Promise<void> => {
            if (!mcpGrant) return;
            const grant = mcpGrant;
            mcpGrant = null;
            const revoked = await revokeGrantQuietly(deps.mcpGrants.revoke, runId, grant, log);
            context.actingMutations = revoked?.mutatingOperations ?? null;
        };
        try {
            await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Preparing agent workspace' });
            const { token, octokit } = await gitHubAccessFor(definition);

            // 4. Same workspace rules as the report; its own directory, since an
            //    auto run's report workspace may not be cleaned up yet.
            workspace = await deps.prepareWorkspace({ runId: `${runId}-action`, definition, githubToken: token, octokit, logger: log });

            // 5. Execute with the action-phase MCP grant, within the spend cap. The
            //    prompt follows the grant, so what it permits is what the tools permit.
            const { agent, alias, model } = await deps.resolveAgent(definition, log);
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, agentRunExecutionUpdate(alias, model));
            const current = await deps.getRun(runId);
            if (current?.state !== 'acting') return taskFollowsRun(context);
            const stopped = await followCancelledTask(context, 'before its agent started');
            if (stopped) return stopped;
            mcpGrant = await deps.mcpGrants.request(runId, 'action');
            const mergeAllowed = actionMayMerge(definition, mcpGrant, log);
            const prompt = deps.buildPrompt({ definition, run: { id: runId }, report: run.report ?? '', operatorNote: run.operatorNote ?? job.data.operatorNote, mergeAllowed });
            const options = agentTaskOptions({ runId, taskId, definition, issueRef, prompt, model, token, workspace, mcpGrant, phase: 'action' });
            const result = await deps.withCostCap(
                { taskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, modelName: model, logger: log },
                () => options.extensionProfile
                    ? runWithNetworkPolicy({ taskId, correlatedLogger: log }, () => agent.executeTask(options))
                    : agent.executeTask(options),
            );

            // 6. The agent is done, so its grant ends. A task stopped during execution
            //    cancels the run; otherwise store the summary.
            await endGrant();
            const taskStopped = await followCancelledTask(context, 'while its agent was executing');
            if (taskStopped) return taskStopped;
            const actionSummary = actionSummaryFromResult(result);
            const actingMutations = context.actingMutations ?? null;
            const completed = await deps.transitionRun(runId, ['acting'], 'completed', { actionSummary, actingMutations });
            if (!completed) return taskFollowsRun(context);
            await settleTask(context, manager => manager.markTaskCompleted(taskId, { status: 'complete', notificationRecap: agentReportRecap(actionSummary) }));
            actionSucceeded = true;
            log.info({ runId, taskId, agentAlias: alias, model, actingMutations }, 'Agent run acting step completed');
            await deps.evaluateStreak(completed);
            return { status: 'complete', runId, taskId, state: 'completed', correlationId };
        } catch (error) {
            if (error instanceof AgentRunSettlementError || error instanceof AgentRunPersistenceError) throw error;
            // A step that changed something before it failed keeps that count on the failed run.
            await endGrant();
            const stopped = await followCancelledTask(context, 'before its run failed').catch(() => null);
            if (stopped) return stopped;
            return failRunAndTask(context, error);
        } finally {
            // 7. The grant ends with the phase, whether the agent succeeded or not.
            activeRuns.delete(runId);
            await endGrant();
            await workspace?.cleanup(actionSucceeded);
        }
    };
}

export const processAgentActionJob = createAgentActionProcessor();
