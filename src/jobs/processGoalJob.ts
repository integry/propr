/* eslint-disable max-lines -- native goal execution and its fenced result reconciliation share one worker boundary */
import fs from 'node:fs';
import type { Job } from 'bullmq';
import {
    AgentRegistry,
    GOAL_CONTINUE_INPUT,
    TaskStates,
    buildGoalPolicyEnvironment,
    cleanupPreparedVisualPreviewEvidence,
    createWorktreeForIssue,
    db,
    ensureGitRepository,
    ensureRepoCloned,
    getAuthenticatedOctokit,
    getRepoUrl,
    getStateManager,
    goalAttemptLabel,
    goalTitleFallback,
    hasNativeGoalControl,
    logger,
    loadRepositoryVisualPreviewSettings,
    prepareVisualPreviewEvidence,
    publishGoalActivity,
    publishGoalTransition,
    recordLLMMetrics,
    runWithExecutionAbortSignal,
    type AgentExecutionResult,
    type Agent,
    type GoalJobData,
    parseGoalArtifacts,
    parseGoalCheckpointDeclaration,
    validateGoalArtifacts,
} from '@propr/core';
import { createContainerIdCallback } from './issueJobCallbacks.js';
import {
    claimGoalAttempt,
    createGoalExecutionControl,
    fencedGoal,
    fencedGoalUpdate,
    firstPendingGoalInput,
    saveFencedGoalSession,
    type GoalRow,
} from './goalAttemptState.js';
import { enqueueNextGoalAttempt } from './goalAttemptScheduling.js';
import {
    publishDirectGoalCheckpoint,
    rejectDirectGoalCheckpoint,
} from './goalCheckpointPublisher.js';
import { publishGoalVisualPreviews } from './goalVisualPreviewPublisher.js';
import { labelCompletedGoalPullRequest } from './goalPullRequestLabel.js';
import { updateCompletedGoalPullRequest } from './goalPullRequestCompletion.js';
import { buildWorkNotificationRecap } from './notificationRecap.js';

function isRecoverableInterruption(result: AgentExecutionResult): boolean {
    if (result.terminationReason) return true;
    if (result.exitCode != null && [125, 137, 143].includes(result.exitCode)) return true;
    return /(?:docker|container|socket hang up|ECONNRESET|ECONNREFUSED|SIGKILL|terminated|execution aborted|App Server exited)/i
        .test(result.error || '');
}

function goalNotificationSummary(result: AgentExecutionResult): string | undefined {
    const checkpoint = parseGoalCheckpointDeclaration(result.summary);
    if (checkpoint && !('rejected' in checkpoint)) return checkpoint.summary ?? checkpoint.message;
    return result.summary;
}

async function ensureGoalWorktree(
    goal: GoalRow,
    job: GoalJobData,
    token: string,
): Promise<{ worktreePath: string; branchName: string }> {
    if (Boolean(goal.worktree_path) !== Boolean(goal.branch_name)) {
        throw new Error('Saved goal worktree identity is incomplete; exact-session recovery cannot continue');
    }
    if (goal.worktree_path && goal.branch_name) {
        if (!fs.existsSync(goal.worktree_path) || !fs.statSync(goal.worktree_path).isDirectory()) {
            throw new Error('Saved goal worktree is missing; exact-session recovery cannot continue');
        }
        return { worktreePath: goal.worktree_path, branchName: goal.branch_name };
    }
    const [repoOwner, repoName] = goal.repository.split('/');
    await ensureGitRepository(logger as never);
    const localRepoPath = await ensureRepoCloned({
        repoUrl: getRepoUrl({ repoOwner, repoName }), owner: repoOwner, repoName,
        authToken: token, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
    });
    const worktree = await createWorktreeForIssue(localRepoPath, {
        issueId: `goal-${goal.goal_id.slice(0, 8)}`,
        issueTitle: goal.objective,
        owner: repoOwner,
        repoName,
    }, { baseBranch: goal.base_branch, modelName: goal.requested_model });
    const saved = await db('goals').where({
        goal_id: goal.goal_id,
        run_generation: job.generation,
        run_claim: job.claimId,
        desired_state: 'running',
    }).whereNull('result_state').whereNull('worktree_path').update({
        worktree_path: worktree.worktreePath,
        branch_name: worktree.branchName,
        attempt_heartbeat_at: db.fn.now(),
        updated_at: db.fn.now(),
    });
    if (saved !== 1) throw new Error('Goal worktree allocation lost its attempt claim');
    return worktree;
}

async function saveSessionAndTaskState(
    options: {
        job: GoalJobData;
        goal: GoalRow;
        sessionId: string;
        conversationId?: string;
        acknowledgeControls: boolean;
    },
): Promise<void> {
    const { job, goal, sessionId, conversationId, acknowledgeControls } = options;
    if (!await saveFencedGoalSession(job, sessionId, conversationId)) throw new Error('Goal session identity write was fenced');
    if (!await fencedGoalUpdate(job, {
        ...(acknowledgeControls ? { control_ack_generation: goal.control_generation } : {}),
    })) throw new Error('Goal control acknowledgement was fenced');
    const stateManager = getStateManager();
    const state = await stateManager.getTaskState(goal.current_task_id);
    const terminalStates = new Set<string>([TaskStates.CANCELLED, TaskStates.COMPLETED, TaskStates.FAILED]);
    if (!state || terminalStates.has(state.state)) return;
    const metadata = { sessionId, conversationId, requestedModel: goal.requested_model, executionMode: 'goal' };
    if (state.state === TaskStates.CLAUDE_EXECUTION) {
        await stateManager.updateHistoryMetadata(goal.current_task_id, TaskStates.CLAUDE_EXECUTION, metadata);
    } else {
        await stateManager.updateTaskState(goal.current_task_id, TaskStates.CLAUDE_EXECUTION, {
            reason: 'Native goal execution started',
            claudeResult: { success: false, sessionId, conversationId },
            historyMetadata: metadata,
        });
    }
}

async function initializeGoalTask(goal: GoalRow): Promise<void> {
    const [repoOwner, repoName] = goal.repository.split('/');
    const stateManager = getStateManager();
    let state = await stateManager.getTaskState(goal.current_task_id);
    if (!state) {
        state = await stateManager.createTaskState(goal.current_task_id, {
            number: 0, repoOwner, repoName, type: 'goal', modelName: goal.requested_model,
            agentAlias: goal.agent_alias, title: goal.title || goalTitleFallback(goal.objective), goalId: goal.goal_id,
        }, goal.goal_id);
    }
    await stateManager.updateTaskState(goal.current_task_id, TaskStates.PROCESSING, {
        ...(state.state === TaskStates.FAILED ? { isRetry: true } : {}),
        reason: goal.session_id ? 'Resuming native goal session' : 'Preparing native goal session',
        historyMetadata: { executionMode: 'goal', generation: goal.run_generation },
    });
}

async function saveProviderResult(
    job: GoalJobData,
    goal: GoalRow,
    result: AgentExecutionResult,
): Promise<{ finalPr?: { number: number; url: string } }> {
    const providerSessionId = result.sessionId ?? goal.session_id;
    if (providerSessionId
        && !await saveFencedGoalSession(job, providerSessionId, result.conversationId)) {
        throw new Error('Goal provider identity write was fenced');
    }
    const validated = await validateGoalArtifacts({
        context: { repository: goal.repository, branchName: goal.branch_name, baseBranch: goal.base_branch },
        existing: parseGoalArtifacts(goal.artifact_refs),
        output: `${result.rawOutput || ''}\n${result.logs || ''}\n${result.summary || ''}`,
    });
    const saved = await fencedGoalUpdate(job, {
        ...(result.providerModel ? { effective_model: result.providerModel } : {}),
        final_pr_number: validated.finalPr?.number ?? null,
        final_pr_url: validated.finalPr?.url ?? null,
        artifact_refs: JSON.stringify(validated.artifacts),
        artifact_stats: JSON.stringify(validated.stats),
        artifacts_checked_at: db.fn.now(),
        attempt_heartbeat_at: db.fn.now(),
    });
    if (!saved) throw new Error('Goal provider result write was fenced');
    return { finalPr: validated.finalPr };
}

async function finalizeGoal(
    job: GoalJobData,
    resultState: 'completed' | 'failed',
    failureReason?: string,
): Promise<boolean> {
    const query = db('goals').where({
        goal_id: job.goalId,
        run_generation: job.generation,
        run_claim: job.claimId,
        desired_state: 'running',
    }).whereNull('result_state');
    const finalized = await query.update({
        result_state: resultState,
        failure_reason: failureReason ?? null,
        active_turn_id: null,
        completed_at: db.fn.now(),
        updated_at: db.fn.now(),
    }) === 1;
    // The single terminal write for a goal attempt, and fenced: publishing here
    // announces the completion exactly once, after it is durable, instead of
    // leaving the Goals console to poll for it.
    if (finalized) {
        await publishGoalActivity({
            goal_id: job.goalId,
            repository: `${job.repoOwner}/${job.repoName}`,
            desired_state: 'running',
            result_state: resultState,
            current_task_id: job.taskId,
        });
    }
    return finalized;
}

async function markGoalTaskReconciled(job: GoalJobData, resultState: string): Promise<void> {
    await db('goals').where({
        goal_id: job.goalId,
        run_generation: job.generation,
        run_claim: job.claimId,
        result_state: resultState,
    }).whereNull('task_reconciled_at').update({ task_reconciled_at: db.fn.now(), updated_at: db.fn.now() });
}

async function recordGoalMetrics(goal: GoalRow, job: GoalJobData, result: AgentExecutionResult): Promise<void> {
    if (!await fencedGoal(job)) throw new Error('Goal metrics write was fenced');
    const [repoOwner, repoName] = goal.repository.split('/');
    await recordLLMMetrics({
        success: result.success, sessionId: result.sessionId, conversationId: result.conversationId,
        executionTime: result.executionTimeMs, model: result.modelUsed,
        conversationLog: result.conversationLog, tokenUsage: result.tokenUsage, error: result.error,
    }, { number: 0, repoOwner, repoName }, {
        jobType: 'issue', correlationId: goal.goal_id, taskId: goal.current_task_id,
    });
}

async function publishOrchestratedGoalVisualPreviews(
    goal: GoalRow,
    pullRequest: { number: number },
    worktreePath: string,
): Promise<void> {
    let prepared: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>> | undefined;
    try {
        prepared = await prepareVisualPreviewEvidence({
            worktreePath,
            settings: await loadRepositoryVisualPreviewSettings(goal.repository),
            taskId: goal.goal_id,
        });
        const octokit = await getAuthenticatedOctokit();
        await publishGoalVisualPreviews(
            { ...goal, worktree_path: worktreePath },
            pullRequest,
            prepared,
            octokit,
        );
    } finally {
        await cleanupPreparedVisualPreviewEvidence(prepared);
    }
}

interface PreparedGoalAttempt {
    goal: GoalRow;
    agent: Agent;
    githubToken: string;
    worktree: { worktreePath: string; branchName: string };
    pendingInput: { input_id: string; message: string; kind: string } | null;
    checkpointFeedback?: string;
}

type GoalPreparation = { ready: true; value: PreparedGoalAttempt }
    | { ready: false; result: { status: string; reason?: string } };

async function previousCheckpointFeedback(
    goal: GoalRow,
    pendingInput: PreparedGoalAttempt['pendingInput'],
): Promise<string | undefined> {
    if (!goal.session_id || pendingInput) return undefined;
    const checkpoint = await db('goal_checkpoints').where({
        goal_id: goal.goal_id,
        owner_id: goal.owner_id,
        requested_generation: goal.run_generation - 1,
    }).whereIn('state', ['completed', 'skipped', 'rejected'])
        .orderBy('created_at', 'desc').first('state', 'commit_sha', 'error') as {
            state?: string; commit_sha?: string | null; error?: string;
        } | undefined;
    if (checkpoint?.state === 'rejected' && checkpoint.error) {
        return `ProPR rejected your checkpoint declaration: ${checkpoint.error}. No checkpoint was committed. Correct the declaration and continue working toward the goal.`;
    }
    if (checkpoint?.state === 'completed' && checkpoint.commit_sha) {
        return `ProPR accepted and published your checkpoint as commit ${checkpoint.commit_sha}. Continue working toward the goal.`;
    }
    if (checkpoint?.state === 'skipped') {
        return 'ProPR accepted your checkpoint, but there were no matching changes to commit. Continue working toward the goal.';
    }
    return undefined;
}

async function prepareClaimedGoalAttempt(data: GoalJobData, claimed: GoalRow): Promise<GoalPreparation> {
    await initializeGoalTask(claimed);

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(claimed.agent_id) || registry.getAgentByAlias(claimed.agent_alias);
    if (!agent?.goalCapable) throw new Error(`Agent ${claimed.agent_alias} has no goal-session execution path`);
    const capability = (await registry.getGoalCapabilities()).find(item => item.agentId === agent.config.id);
    if (!capability?.goalCapable) throw new Error(capability?.reason || `Pinned ${claimed.agent_alias} runtime has no proven goal-session transport`);

    const octokit = await getAuthenticatedOctokit();
    const githubToken = await octokit.auth({ type: 'installation' }) as { token: string };
    const worktree = await ensureGoalWorktree(claimed, data, githubToken.token);
    let boundaryGoal = await fencedGoal(data);
    if (!boundaryGoal) return { ready: false, result: { status: 'skipped', reason: 'goal_boundary_fence' } };
    if (boundaryGoal.desired_state === 'paused') {
        await fencedGoalUpdate(data, { pause_confirmed_at: db.fn.now(), active_turn_id: null });
        const confirmed = await fencedGoal(data);
        if (confirmed?.resume_requested) await enqueueNextGoalAttempt({ ...confirmed, pause_confirmed_at: new Date().toISOString() }, data);
        return { ready: false, result: { status: 'paused' } };
    }
    if (boundaryGoal.desired_state !== 'running') return { ready: false, result: { status: 'skipped', reason: 'goal_boundary_fence' } };
    if (boundaryGoal.launch_strategy === 'direct' && !boundaryGoal.final_pr_url) {
        await publishDirectGoalCheckpoint(data, { kind: 'bootstrap' });
        boundaryGoal = await fencedGoal(data);
        if (!boundaryGoal) return { ready: false, result: { status: 'skipped', reason: 'goal_bootstrap_fence' } };
    }
    const pendingInput = await firstPendingGoalInput(boundaryGoal);
    const checkpointFeedback = await previousCheckpointFeedback(boundaryGoal, pendingInput);
    return {
        ready: true,
        value: { goal: boundaryGoal, agent, githubToken: githubToken.token, worktree, pendingInput, checkpointFeedback },
    };
}

export async function executePreparedGoal(data: GoalJobData, prepared: PreparedGoalAttempt): Promise<AgentExecutionResult> {
    const { goal, agent, githubToken, worktree, pendingInput, checkpointFeedback } = prepared;
    const freshSession = !goal.session_id;
    // Native goal providers (Codex, Claude) steer the durable delivery context
    // into the live session themselves. Whole-session providers have no steer
    // capability, so their first invocation must carry the context inside the
    // initial prompt to govern from the start.
    const liveControl = hasNativeGoalControl(goal.agent_type);
    const initialContextInput = freshSession && !liveControl && pendingInput?.kind === 'context'
        ? pendingInput
        : null;
    const prompt = freshSession
        ? initialContextInput
            ? `${goal.initial_prompt}\n\n${initialContextInput.message}`
            : goal.initial_prompt
        : pendingInput?.message
            ?? checkpointFeedback
            ?? GOAL_CONTINUE_INPUT;
    const control = createGoalExecutionControl(data);
    const executionController = new AbortController();
    return runWithExecutionAbortSignal(
        executionController.signal,
        () => agent.executeTask({
            worktreePath: worktree.worktreePath,
            issueRef: { number: 0, repoOwner: data.repoOwner, repoName: data.repoName },
            prompt,
            model: goal.requested_model,
            githubToken,
            branchName: worktree.branchName,
            taskId: goal.current_task_id,
            executionMode: 'goal',
            nativeGoalObjective: goal.initial_prompt,
            resumeSessionId: goal.session_id ?? undefined,
            resumeConversationId: goal.conversation_id ?? undefined,
            initialControlInputId: liveControl ? pendingInput?.input_id : undefined,
            initialControlInputMessage: liveControl ? pendingInput?.message : undefined,
            initialGoalFeedback: liveControl ? checkpointFeedback : undefined,
            goalControl: control,
            environment: buildGoalPolicyEnvironment(goal.launch_strategy),
            onSessionId: async (sessionId, conversationId) => {
                await saveSessionAndTaskState({
                    job: data, goal, sessionId, conversationId,
                    acknowledgeControls: !pendingInput,
                });
                if (pendingInput && !liveControl && (!freshSession || initialContextInput)) {
                    await control.markInputDelivered(pendingInput.input_id, `session:${sessionId}`);
                }
                if (freshSession && !liveControl) {
                    const boundary = await control.load();
                    if (boundary.desiredState !== 'running') {
                        executionController.abort(new Error('Goal stopped after its whole-session identity was persisted'));
                    } else if (boundary.pendingInputs.length > 0) {
                        const paused = await db('goals').where({
                            goal_id: data.goalId, current_task_id: data.taskId,
                            run_generation: data.generation, run_claim: data.claimId,
                            desired_state: 'running',
                        }).whereNull('result_state').update({
                            desired_state: 'paused', paused_at: db.fn.now(), pause_confirmed_at: null,
                            resume_requested: true, attempt_heartbeat_at: db.fn.now(),
                            updated_at: db.fn.now(),
                        });
                        if (paused === 1 || (await control.load()).desiredState !== 'running') {
                            executionController.abort(new Error('Goal correction queued for whole-session resume'));
                        }
                    }
                }
            },
            onContainerId: createContainerIdCallback(
                goal.current_task_id, getStateManager(), logger as never, worktree.worktreePath,
            ),
        }),
        goalAttemptLabel(data.generation, data.claimId),
    );
}

async function acknowledgeWholeSessionInput(data: GoalJobData, prepared: PreparedGoalAttempt): Promise<void> {
    const { pendingInput, goal } = prepared;
    if (!pendingInput || hasNativeGoalControl(goal.agent_type) || !goal.session_id) return;
    await db.transaction(async trx => {
        const owned = await trx('goals').where({
            goal_id: data.goalId,
            current_task_id: data.taskId,
            run_generation: data.generation,
            run_claim: data.claimId,
        }).whereNull('result_state').forUpdate().first('owner_id');
        if (!owned) throw new Error('Goal input acknowledgement was fenced');
        const changed = await trx('goal_inputs').where({
            input_id: pendingInput.input_id,
            goal_id: goal.goal_id,
            owner_id: owned.owner_id,
            state: 'pending',
        }).update({
            state: 'delivered',
            delivered_generation: data.generation,
            delivered_claim: data.claimId,
            delivered_at: trx.fn.now(),
        });
        if (changed !== 1) {
            const delivered = await trx('goal_inputs').where({
                input_id: pendingInput.input_id,
                goal_id: goal.goal_id,
                owner_id: owned.owner_id,
                state: 'delivered',
                delivered_generation: data.generation,
                delivered_claim: data.claimId,
            }).first('input_id');
            if (!delivered) throw new Error('Goal input was already delivered or superseded');
        }
        await trx('goals').where({
            goal_id: data.goalId,
            run_generation: data.generation,
            run_claim: data.claimId,
        }).whereNull('result_state').update({
            control_ack_generation: trx.raw('control_generation'),
            updated_at: trx.fn.now(),
        });
    });
}

async function withAttemptHeartbeat<T>(data: GoalJobData, operation: () => Promise<T>): Promise<T> {
    let heartbeat = Promise.resolve();
    const update = (): void => {
        heartbeat = heartbeat.then(() => fencedGoalUpdate(data, { attempt_heartbeat_at: db.fn.now() })).then(() => undefined);
    };
    const timer = setInterval(update, 30_000);
    try {
        return await operation();
    } finally {
        clearInterval(timer);
        await heartbeat;
    }
}

async function handleStoppedGoal(
    data: GoalJobData,
    goal: GoalRow,
    latest: GoalRow | null,
): Promise<{ status: string } | null> {
    if (!latest) return { status: 'skipped' };
    if (latest.desired_state === 'cancelled') {
        const task = await getStateManager().markTaskCancelled(goal.current_task_id, 'user');
        if (task.state !== TaskStates.CANCELLED) throw new Error('Goal cancellation could not reconcile its backing task');
        const cancelled = await fencedGoalUpdate(data, {
            result_state: 'cancelled',
            active_turn_id: null,
            completed_at: db.fn.now(),
            task_reconciled_at: db.fn.now(),
        });
        // Normally silent: whoever requested the cancellation already announced
        // it, and finalizing it changes nothing a consumer can act on. Routed
        // through the transition rule anyway so a goal that somehow reaches this
        // write without having been announced is still reported once.
        if (cancelled) {
            await publishGoalTransition({
                previous: latest,
                next: { ...latest, result_state: 'cancelled' },
            });
        }
        return { status: 'cancelled' };
    }
    if (latest.desired_state !== 'paused') return null;
    await fencedGoalUpdate(data, { pause_confirmed_at: db.fn.now(), active_turn_id: null });
    await getStateManager().updateTaskState(goal.current_task_id, TaskStates.PROCESSING, {
        reason: 'Goal paused at a provider turn boundary', historyMetadata: { paused: true },
    });
    if (latest.resume_requested) {
        await enqueueNextGoalAttempt({ ...latest, pause_confirmed_at: new Date().toISOString() }, data);
    }
    return { status: 'paused' };
}

async function scheduleFurtherWork(
    data: GoalJobData,
    latest: GoalRow,
    result: AgentExecutionResult,
    checkpointPublished = false,
): Promise<{ status: string } | null> {
    if (await firstPendingGoalInput(latest)) {
        await enqueueNextGoalAttempt(latest, data);
        return { status: 'continuing' };
    }
    if (checkpointPublished) {
        await enqueueNextGoalAttempt(latest, data);
        return { status: 'continuing' };
    }
    const recoverable = !result.success && isRecoverableInterruption(result)
        && Boolean(latest.session_id) && Boolean(latest.worktree_path);
    if (!recoverable) return null;
    await enqueueNextGoalAttempt(latest, data, true);
    return { status: 'recovering' };
}

// eslint-disable-next-line complexity -- preserve the ordered post-execution fences and terminal reconciliation
async function handleGoalResult(
    data: GoalJobData,
    prepared: PreparedGoalAttempt,
    result: AgentExecutionResult,
    operations: GoalResultOperations = defaultGoalResultOperations,
) {
    const { goal, worktree } = prepared;
    const postExecution = await operations.loadGoal(goal.goal_id);
    if (!postExecution
        || postExecution.run_generation !== data.generation
        || postExecution.run_claim !== data.claimId
        || postExecution.result_state === 'cancelled') {
        return { status: postExecution?.result_state === 'cancelled' ? 'cancelled' : 'skipped', reason: 'goal_post_execution_fence' };
    }
    await operations.acknowledgeInput(data, prepared);
    await operations.recordMetrics(goal, data, result);
    const boundary = await operations.fencedGoal(data);
    const declaration = result.success && goal.launch_strategy === 'direct' && !hasNativeGoalControl(goal.agent_type)
        ? parseGoalCheckpointDeclaration(result.summary)
        : null;
    if (boundary?.launch_strategy === 'direct' && boundary.desired_state !== 'cancelled' && declaration) {
        if ('rejected' in declaration) {
            await operations.rejectCheckpoint(data, {
                kind: 'agent', error: declaration.error, commitMessage: declaration.message,
                include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
            });
        } else {
            await operations.publishCheckpoint(data, {
                kind: 'agent', commitMessage: declaration.message,
                include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
            });
        }
    }
    const boundaryStop = await operations.handleStopped(data, goal, boundary);
    if (boundaryStop) return boundaryStop;
    let artifacts = await operations.saveProviderResult(data, { ...goal, branch_name: worktree.branchName }, result);
    if (goal.launch_strategy !== 'direct' && artifacts.finalPr) {
        await operations.publishVisualPreviews(goal, artifacts.finalPr, worktree.worktreePath);
    }
    const latest = await operations.fencedGoal(data);
    const stopped = await operations.handleStopped(data, goal, latest);
    if (stopped) return stopped;
    const furtherWork = await operations.scheduleFurtherWork(data, latest!, result, Boolean(declaration));
    if (furtherWork) return furtherWork;
    if (goal.launch_strategy === 'direct') {
        await operations.publishCheckpoint(data, { kind: 'final' });
        const checkpointedGoal = await operations.fencedGoal(data);
        if (!checkpointedGoal) return { status: 'skipped', reason: 'goal_final_checkpoint_fence' };
        artifacts = await operations.saveProviderResult(
            data,
            { ...checkpointedGoal, branch_name: worktree.branchName },
            result,
        );
    }

    const missingFinalPr = result.success && !artifacts.finalPr;
    const failure = missingFinalPr
        ? 'Provider completed without the required open draft PR for the saved goal branch and expected base'
        : result.error || 'Native goal execution failed';
    const resultState = result.success && !missingFinalPr ? 'completed' : 'failed';
    const completed = await operations.finalizeGoal(data, resultState, resultState === 'failed' ? failure : undefined);
    if (!completed) return { status: 'skipped', reason: 'goal_finalize_fence' };
    if (result.success && artifacts.finalPr) {
        await operations.updatePullRequestDescription(goal, artifacts.finalPr.number, result);
        await operations.labelPullRequest(goal.repository, artifacts.finalPr.number);
        const task = await operations.stateManager().markTaskCompleted(goal.current_task_id, {
            prNumber: artifacts.finalPr.number, prUrl: artifacts.finalPr.url,
            notificationRecap: buildWorkNotificationRecap(goalNotificationSummary(result), {
                filesChanged: new Set(result.modifiedFiles).size,
                createdPullRequest: true,
            }),
        });
        if (task.state !== TaskStates.COMPLETED) throw new Error('Completed goal could not reconcile its backing task');
        await operations.markTaskReconciled(data, resultState);
        return { status: 'complete', goalId: goal.goal_id };
    }
    const task = await operations.stateManager().markTaskFailed(goal.current_task_id, new Error(failure));
    if (task.state !== TaskStates.FAILED) throw new Error('Failed goal could not reconcile its backing task');
    await operations.markTaskReconciled(data, resultState);
    return { status: 'failed', goalId: goal.goal_id };
}

interface GoalResultOperations {
    loadGoal(goalId: string): Promise<GoalRow | null>;
    fencedGoal: typeof fencedGoal;
    acknowledgeInput: typeof acknowledgeWholeSessionInput;
    recordMetrics: typeof recordGoalMetrics;
    handleStopped: typeof handleStoppedGoal;
    saveProviderResult: typeof saveProviderResult;
    scheduleFurtherWork: typeof scheduleFurtherWork;
    publishCheckpoint: typeof publishDirectGoalCheckpoint;
    rejectCheckpoint: typeof rejectDirectGoalCheckpoint;
    publishVisualPreviews: typeof publishOrchestratedGoalVisualPreviews;
    finalizeGoal: typeof finalizeGoal;
    updatePullRequestDescription: typeof updateCompletedGoalPullRequest;
    labelPullRequest: typeof labelCompletedGoalPullRequest;
    markTaskReconciled: typeof markGoalTaskReconciled;
    stateManager(): Pick<ReturnType<typeof getStateManager>, 'markTaskCompleted' | 'markTaskFailed'>;
}

const defaultGoalResultOperations: GoalResultOperations = {
    loadGoal: async goalId => await db<GoalRow>('goals').where({ goal_id: goalId }).first() ?? null,
    fencedGoal,
    acknowledgeInput: acknowledgeWholeSessionInput,
    recordMetrics: recordGoalMetrics,
    handleStopped: handleStoppedGoal,
    saveProviderResult,
    scheduleFurtherWork,
    publishCheckpoint: publishDirectGoalCheckpoint,
    rejectCheckpoint: rejectDirectGoalCheckpoint,
    publishVisualPreviews: publishOrchestratedGoalVisualPreviews,
    finalizeGoal,
    updatePullRequestDescription: updateCompletedGoalPullRequest,
    labelPullRequest: labelCompletedGoalPullRequest,
    markTaskReconciled: markGoalTaskReconciled,
    stateManager: getStateManager,
};

export interface GoalJobProcessorDependencies {
    claim: typeof claimGoalAttempt;
    withHeartbeat: typeof withAttemptHeartbeat;
    prepare: typeof prepareClaimedGoalAttempt;
    execute: typeof executePreparedGoal;
    result: GoalResultOperations;
}

const defaultGoalJobProcessorDependencies: GoalJobProcessorDependencies = {
    claim: claimGoalAttempt,
    withHeartbeat: withAttemptHeartbeat,
    prepare: prepareClaimedGoalAttempt,
    execute: executePreparedGoal,
    result: defaultGoalResultOperations,
};

export async function processGoalJob(
    job: Job<GoalJobData>,
    dependencies: GoalJobProcessorDependencies = defaultGoalJobProcessorDependencies,
) {
    const claimed = await dependencies.claim(job.data);
    if (!claimed) return { status: 'skipped', reason: 'goal_claim_fence' };
    return dependencies.withHeartbeat(job.data, async () => {
        const preparation = await dependencies.prepare(job.data, claimed);
        if (!preparation.ready) return preparation.result;
        const result = await dependencies.execute(job.data, preparation.value);
        return handleGoalResult(job.data, preparation.value, result, dependencies.result);
    });
}
