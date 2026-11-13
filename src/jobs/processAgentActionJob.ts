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
import { requestAgentRunMcpGrant, revokeAgentRunMcpGrant, revokeGrantQuietly, type IssuedAgentRunMcpGrant, type RevokedAgentRunMcpGrant } from './agentRuns/mcpGrantClient.js';
import {
    actionSummaryFromResult,
    AgentRunMutationsSettlementError,
    AgentRunPersistenceError,
    AgentRunReportError,
    AgentRunSettlementError,
} from './agentRuns/runErrors.js';
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
     * Settles the grant's mutation count (null when unknown) on a run another writer
     * failed or cancelled while this acting step held the grant; null when no such run matched.
     */
    recordMutations: (runId: string, record: { actionTaskId: string; actingMutations: number | null }) => Promise<StoredAgentRun | null>;
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
const ENDED_RUN_STATES = new Set<StoredAgentRun['state']>(['completed', 'failed', 'cancelled']);

/**
 * The run when its flags are final: it ended and no claimed step's count is still
 * outstanding (the delivery holding that count evaluates the run once it settles it).
 */
function withFinalFlags(run: StoredAgentRun | undefined): StoredAgentRun | null {
    return run && ENDED_RUN_STATES.has(run.state) && !run.actingMutationsPending ? run : null;
}

interface ActionContext {
    runId: string; taskId: string; stateManager: AgentRunStateManager; log: Logger; correlationId: string;
    /**
     * Mutating operations the acting grant performed, set once the grant has ended
     * (null when that count is unknown), so whichever state ends the run keeps it.
     */
    actingMutations?: number | null;
    /**
     * True once this delivery claimed the acting step (or is the retry of one that
     * kept the count it still owed with the job, or took over the claim of a worker
     * that stopped): it then owes the run the settlement of the step's count, even
     * when another writer ended the run.
     */
    ownsClaim?: boolean;
}

/** The context of a delivery; a retry takes over the claim and count an earlier delivery of the job still owed. */
function actionContext(job: Job<AgentRunJobData>, stateManager: AgentRunStateManager, log: Logger): ActionContext {
    const { runId, correlationId, actingMutationsOwed: owed } = job.data;
    const context: ActionContext = { runId, taskId: agentRunActionTaskId(runId), stateManager, log, correlationId };
    return owed ? { ...context, ownsClaim: true, actingMutations: owed.actingMutations } : context;
}

/**
 * A delivery that claimed the step and is about to fail (so BullMQ retries) keeps
 * the step's count with the job: the grant that counted it is revoked, so nothing
 * else could tell the retry what it changed. Never throws; the delivery's own error wins.
 */
async function keepOwedMutationsWithJob(job: Job<AgentRunJobData>, context: ActionContext): Promise<void> {
    if (!context.ownsClaim || typeof job.updateData !== 'function') return;
    const actingMutations = typeof context.actingMutations === 'number' ? context.actingMutations : null;
    if (job.data.actingMutationsOwed?.actingMutations === actingMutations) return;
    try {
        await job.updateData({ ...job.data, actingMutationsOwed: { actingMutations } });
    } catch (error) {
        context.log.error({ runId: context.runId, actingMutations, err: error }, 'Could not keep the acting step mutation count with its job for the retry');
    }
}

/** Errors that fail the delivery so BullMQ retries it, instead of failing the run. */
function isRetriedDeliveryError(error: unknown): boolean {
    return error instanceof AgentRunSettlementError || error instanceof AgentRunPersistenceError || error instanceof AgentRunMutationsSettlementError;
}

/**
 * The ended grant's count as a transition patch (none while it is held or unknown).
 * A worker writing the run's final state settles the count either way.
 */
function mutationsPatch(context: ActionContext): AgentRunTransitionPatch {
    const settled: AgentRunTransitionPatch = { actingMutationsPending: false };
    return typeof context.actingMutations === 'number' ? { ...settled, actingMutations: context.actingMutations } : settled;
}

export function createAgentActionProcessor(overrides: Partial<AgentActionProcessorDeps> = {}) {
    const deps: AgentActionProcessorDeps = { ...defaultAgentActionProcessorDeps, ...overrides };

    /** Run ids whose acting step this process is executing. */
    const activeRuns = new Set<string>();

    /** acting → failed; null when the run already left `acting`. Persistence errors are retried. */
    async function failActingRun(runId: string, reason: string, log: Logger, patch: AgentRunTransitionPatch = {}): Promise<StoredAgentRun | null> {
        try {
            return await deps.transitionRun(runId, ['acting'], 'failed', { ...patch, failureReason: reason });
        } catch (error) {
            log.error({ runId, err: error }, 'Could not mark agent run failed');
            throw new AgentRunPersistenceError(runId, error);
        }
    }

    /**
     * The streak check once a run's flags are final, whichever state ended it.
     * A failed or cancelled acting step that changed nothing is an unproductive
     * run like a completed one, and the streak it extends must be noticed now:
     * a schedule set to pause on such a streak would otherwise keep running
     * until some later run happened to complete. Never throws.
     */
    async function evaluateEndedRun(run: StoredAgentRun | null): Promise<void> {
        if (run) await deps.evaluateStreak(run);
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
     * still keeps what the grant changed. Until this settles the count (known, or
     * unknown when the revoke failed or no grant was issued), the run stays out of
     * streaks. Only the delivery that claimed the step settles it (or the retry it
     * left the count to), and only once its grant has ended. A write that fails is
     * returned rather than dropped: the run keeps its end, but the obligation stays
     * open, so the delivery fails and its retry settles the count kept with the job.
     * `recorded` is the run this settled the count on, null when none matched.
     */
    async function keepMutationsOfEndedRun(context: ActionContext): Promise<{ recorded: StoredAgentRun | null; unsettled: AgentRunMutationsSettlementError | null }> {
        const { runId, taskId, log } = context;
        if (!context.ownsClaim) return { recorded: null, unsettled: null };
        const actingMutations = typeof context.actingMutations === 'number' ? context.actingMutations : null;
        let recorded: StoredAgentRun | null;
        try {
            recorded = await deps.recordMutations(runId, { actionTaskId: taskId, actingMutations });
        } catch (error) {
            log.error({ runId, taskId, actingMutations, err: error }, 'Could not store the acting step mutation count on its ended run; retrying');
            return { recorded: null, unsettled: new AgentRunMutationsSettlementError(runId, error) };
        }
        // Settling the count made the run's flags final, so this is where its streak is evaluated.
        await evaluateEndedRun(recorded);
        return { recorded, unsettled: null };
    }

    /**
     * Ends a still-open action task to match a run that already ended: another
     * writer ended it (cancel endpoint, a failure stored by an earlier attempt), or
     * an earlier delivery of this job stored the run's end and count and then failed
     * on the task write. The task follows the run even when the count could not be
     * settled; the delivery then fails.
     */
    async function taskFollowsRun(context: ActionContext): Promise<JobResult> {
        const { runId, taskId, correlationId } = context;
        const { recorded, unsettled } = await keepMutationsOfEndedRun(context);
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
        if (unsettled) throw unsettled;
        // Nothing was settled here, yet the run may be final and unevaluated: an earlier delivery
        // stored its end and count, then failed on the task write before its own check, and its
        // retry records nothing new (a completed run takes no count, a stored one is never
        // replaced). A repeated check is harmless: the streak's Inbox item and pause are each made once.
        if (!recorded) await evaluateEndedRun(withFinalFlags(current));
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
        const failed = await failActingRun(runId, reason, log, mutationsPatch(context));
        if (!failed) return taskFollowsRun(context);
        await settleTask(context, manager => manager.markTaskFailed(taskId, usageLimit ? new Error(reason) : error as Error));
        await evaluateEndedRun(failed);
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
        await evaluateEndedRun(cancelled);
        return { status: 'cancelled', runId, taskId, correlationId };
    }

    /**
     * Takes over the claim of an acting step whose worker stopped before it settled
     * the step's count: BullMQ redelivers a claimed step only once the worker
     * executing it lost its lock, and the caller leaves a step this process is still
     * executing alone. That worker's only record of what the step changed is the
     * action grant it held, which nothing else revokes until the terminal-run sweep:
     * ending it here stops any container the lost worker left behind and yields the
     * count. A worker that stopped after its own revoke, before it stored the count,
     * left the grant ended but still named by the API, which counts that grant's
     * operations the same way (`revoked` is then false). Only a grant never issued,
     * or a revoke that fails, leaves the count unknown, as it does for the claiming
     * delivery. From here on this delivery owes the run the settlement, exactly like
     * the delivery that claimed the step; a worker that merely lost its lock and is
     * still executing then stores nothing new: a count is never stored twice.
     */
    async function adoptAbandonedClaim(context: ActionContext): Promise<void> {
        if (context.ownsClaim) return;
        const { runId, taskId, log } = context;
        context.ownsClaim = true;
        let revoked: RevokedAgentRunMcpGrant | null | undefined = null;
        try {
            revoked = await deps.mcpGrants.revoke(runId, { phase: 'action' });
        } catch (error) {
            log.warn({ runId, taskId, err: error instanceof Error ? error.message : String(error) }, 'Could not end the MCP grant of an acting step its worker abandoned; its mutation count is unknown');
        }
        // A grant ended now, or one the phase ended before that the API still names: either way its count.
        const counted = revoked?.revoked === true || Boolean(revoked?.grantId);
        context.actingMutations = counted ? revoked?.mutatingOperations ?? null : null;
        log.info({ runId, taskId, grantId: revoked?.grantId ?? null, endedBefore: revoked?.revoked === false, actingMutations: context.actingMutations }, 'Took over the mutation count of an acting step its worker abandoned');
    }

    /**
     * A delivery for a run whose action task was already recorded: another
     * delivery claimed it. One still live in this process is left alone; one
     * left behind by a worker that stopped is failed rather than run twice,
     * with the count its grant recorded before it is ended.
     */
    async function recoverClaimedRun(run: StoredAgentRun, context: ActionContext): Promise<JobResult> {
        const { runId, taskId, log, correlationId } = context;
        if (activeRuns.has(runId)) {
            log.warn({ runId, taskId }, 'Agent run acting step is already executing in this worker; ignoring duplicate delivery');
            return { status: 'skipped', runId, taskId, correlationId };
        }
        log.warn({ runId, taskId }, 'Agent run acting step was left running by an interrupted worker; failing it');
        await adoptAbandonedClaim(context);
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
    async function runAction(job: Job<AgentRunJobData>, context: ActionContext): Promise<JobResult> {
        const { runId, taskId, stateManager, log, correlationId } = context;

        // 1. Only an `acting` run is acted on: dry runs, rejections and cancels never get here.
        const run = await deps.getRun(runId);
        if (!run || run.state !== 'acting') {
            if (run?.actionTaskId) {
                // Ended by another writer while a claimed step's count was still outstanding, and
                // that step's worker stopped before settling it (this delivery neither owes the
                // count nor executes the step): take the count over, or the run stays pending forever.
                if (ENDED_RUN_STATES.has(run.state) && run.actingMutationsPending && !activeRuns.has(runId)) await adoptAbandonedClaim(context);
                return taskFollowsRun(context);
            }
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
            // No acting count: the run's report flags alone decide its verdict, which is final now.
            await evaluateEndedRun(await failActingRun(runId, reason, log));
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
        context.ownsClaim = true;

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
            const prompt = deps.buildPrompt({ definition, run: { id: runId, triggerEvent: run.triggerEvent }, report: run.report ?? '', operatorNote: run.operatorNote ?? job.data.operatorNote, mergeAllowed });
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
            const completed = await deps.transitionRun(runId, ['acting'], 'completed', { actionSummary, actingMutations, actingMutationsPending: false });
            if (!completed) return taskFollowsRun(context);
            await settleTask(context, manager => manager.markTaskCompleted(taskId, { status: 'complete', notificationRecap: agentReportRecap(actionSummary) }));
            actionSucceeded = true;
            log.info({ runId, taskId, agentAlias: alias, model, actingMutations }, 'Agent run acting step completed');
            await deps.evaluateStreak(completed);
            return { status: 'complete', runId, taskId, state: 'completed', correlationId };
        } catch (error) {
            if (isRetriedDeliveryError(error)) throw error;
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
    }

    return async function processAgentAction(job: Job<AgentRunJobData>): Promise<JobResult> {
        const log: Logger = logger.withCorrelation(job.data.correlationId);
        const context = actionContext(job, deps.stateManager(), log);
        try {
            return await runAction(job, context);
        } catch (error) {
            // Runs after the step's `finally`, so the grant has ended and its count is final.
            await keepOwedMutationsWithJob(job, context);
            throw error;
        }
    };
}

export const processAgentActionJob = createAgentActionProcessor();
