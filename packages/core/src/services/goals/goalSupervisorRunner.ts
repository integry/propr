import { isTerminalGoalState } from '@propr/shared';
import logger from '../../utils/logger.js';
import { GoalArtifactRepository } from './goalArtifactRepository.js';
import {
  GoalExecutionRepository,
  buildNativeGoalCommand,
  buildNativeGoalPolicy,
  deterministicGoalWorkspace,
} from './goalExecutionRepository.js';
import { GoalRepository } from './goalRepository.js';
import { GoalRuntimeControlRepository } from './goalRuntimeControlRepository.js';
import { GoalSupervisorControl } from './goalSupervisorControl.js';
import { GoalSupervisorObservations } from './goalSupervisorObservations.js';
import type { Goal, GoalLeaseFence } from './goalTypes.js';
import type {
  GoalArtifactVerifier, GoalProviderRuntime, GoalProviderRuntimeResolver,
  GoalRuntimeExecution, GoalRuntimeResult, GoalWorkspaceIdentity,
} from './goalRuntimeTypes.js';
import {
  abortableDelay,
  durableGoalKey,
  isExpectedOwnershipEnd,
  runtimeAuthority,
} from './goalSupervisorUtilities.js';

export interface GoalSupervisorRunnerOptions {
  repository: GoalRepository;
  runtimes: GoalProviderRuntimeResolver;
  controllerId: string;
  leaseTtlMs: number;
  controlPollMs: number;
  settlementTimeoutMs: number;
  resolveBaseBranch(goal: Goal): Promise<string>;
  allocateWorkspace(goal: Goal, workspace: GoalWorkspaceIdentity): Promise<GoalWorkspaceIdentity>;
  artifactVerifier: GoalArtifactVerifier;
  isStopped(): boolean;
}

export class GoalSupervisorRunner {
  private readonly executions: GoalExecutionRepository;
  private readonly artifacts: GoalArtifactRepository;
  private readonly runtimeControls: GoalRuntimeControlRepository;
  private readonly control: GoalSupervisorControl;
  private readonly observations: GoalSupervisorObservations;

  constructor(private readonly options: GoalSupervisorRunnerOptions) {
    const database = options.repository.database;
    this.executions = new GoalExecutionRepository(database);
    this.artifacts = new GoalArtifactRepository(database);
    this.runtimeControls = new GoalRuntimeControlRepository(database);
    this.control = new GoalSupervisorControl(
      options.repository,
      this.executions,
      this.runtimeControls,
      {
        leaseTtlMs: options.leaseTtlMs,
        controlPollMs: options.controlPollMs,
        settlementTimeoutMs: options.settlementTimeoutMs,
      }
    );
    this.observations = new GoalSupervisorObservations(
      options.repository, this.executions, this.artifacts, this.runtimeControls
    );
  }

  async drive(goalId: string, abort: AbortController): Promise<void> {
    let fence: GoalLeaseFence | null = null;
    let execution: GoalRuntimeExecution | null = null;
    let runtime: GoalProviderRuntime | null = null;
    try {
      const lease = await this.options.repository.claimLease(
        goalId, this.options.controllerId, this.options.leaseTtlMs
      );
      fence = { leaseOwner: this.options.controllerId, leaseEpoch: lease.epoch };
      await this.executeClaimed(goalId, fence, abort, update => {
        execution = update.execution;
        runtime = update.runtime ?? runtime;
      });
    } catch (error) {
      abort.abort(error);
      if (execution && runtime && fence && this.options.isStopped()) {
        await this.control.settleRuntime(execution, runtime, fence).catch(() => undefined);
      }
      if (!isExpectedOwnershipEnd(error)) {
        await this.recordInterruption(goalId, execution, fence, error);
        throw error;
      }
    } finally {
      if (fence) await this.releaseLease(goalId, fence);
    }
  }

  private async executeClaimed(
    goalId: string,
    fence: GoalLeaseFence,
    abort: AbortController,
    track: (update: {
      execution: GoalRuntimeExecution;
      runtime?: GoalProviderRuntime;
    }) => void
  ): Promise<void> {
    let goal = await this.enterControllerState(
      await this.options.repository.requireGoal(goalId), fence
    );
    let execution = await this.prepareExecution(goal, fence);
    track({ execution });
    const runtime = await this.options.runtimes.resolve(execution.agent);
    track({ execution, runtime });
    execution = await this.recoverLegacyIdentity(goal, execution, fence);
    track({ execution, runtime });
    if (await this.runtimeControls.hasPendingCancellation(goalId)) {
      await this.control.cancelAtBoundary(goal, execution, runtime, fence);
      return;
    }
    if (goal.state === 'pausing') {
      await this.control.pauseAtBoundary(goal, execution, runtime, fence);
      return;
    }
    if (execution.providerThreadId && goal.requestedModel !== execution.effectiveModel) {
      execution = await this.control.applyPendingModel(goal, execution, runtime, fence);
      track({ execution, runtime });
      goal = await this.options.repository.requireGoal(goalId);
    }
    execution = await this.executions.updateState({
      goalId, executionId: execution.executionId,
      state: execution.providerThreadId ? 'interrupted' : 'starting', fence,
    });
    execution = await this.dispatch({
      goal, execution, runtime, fence, abort,
      track: current => track({ execution: current, runtime }),
    });
    track({ execution, runtime });
  }

  private async prepareExecution(goal: Goal, fence: GoalLeaseFence): Promise<GoalRuntimeExecution> {
    const existing = await this.executions.get(goal.goalId);
    if (existing) return existing;
    const planned = deterministicGoalWorkspace(
      goal, await this.options.resolveBaseBranch(goal)
    );
    const workspace = await this.options.allocateWorkspace(goal, planned);
    return this.executions.allocate(goal, {
      workspace, policy: buildNativeGoalPolicy(goal),
    }, fence);
  }

  private async recoverLegacyIdentity(
    goal: Goal,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    if (execution.providerThreadId) return execution;
    const legacy = await this.options.repository.getProviderSession(goal.goalId, goal.agent);
    if (!legacy?.provider_thread_id) return execution;
    return this.observations.persistIdentity(goal, execution, {
      providerSessionId: legacy.session_id,
      providerThreadId: legacy.provider_thread_id,
      runtimeId: legacy.runtime_id,
      worktreeId: legacy.worktree_id ?? execution.workspace.worktreeId,
    }, fence);
  }

  private async dispatch(input: {
    goal: Goal;
    execution: GoalRuntimeExecution;
    runtime: GoalProviderRuntime;
    fence: GoalLeaseFence;
    abort: AbortController;
    track(execution: GoalRuntimeExecution): void;
  }): Promise<GoalRuntimeExecution> {
    let execution = input.execution;
    const callbacks = this.observations.callbacks(
      input.goal, execution, input.fence, value => {
        execution = value;
        input.track(value);
      }
    );
    if (execution.providerThreadId
        && (input.goal.state === 'planning' || input.goal.state === 'recovering')) {
      await this.options.repository.transition(input.goal.goalId, {
        toState: 'running', ...input.fence, reason: 'provider_session_resumed',
        idempotencyKey: durableGoalKey(
          'running', execution.executionId, input.fence.leaseEpoch
        ),
      });
    }
    const request = {
      goal: input.goal,
      execution,
      command: buildNativeGoalCommand(input.goal.objective, execution.policy),
      authority: runtimeAuthority(this.options.repository, input.goal.goalId, input.fence),
      callbacks,
      signal: input.abort.signal,
    };
    await request.authority.assertCurrent();
    const runtimePromise = (execution.providerThreadId
      ? input.runtime.resume(request)
      : input.runtime.start(request)).then(result => ({ source: 'runtime' as const, result }));
    const controls = this.control.run({
      goalId: input.goal.goalId, execution, runtime: input.runtime,
      fence: input.fence, abort: input.abort,
    });
    const winner = await Promise.race([
      runtimePromise,
      controls.then(outcome => ({ source: 'control' as const, outcome })),
    ]);
    if (winner.source === 'runtime' && winner.result.outcome === 'completed') {
      await this.closeSteering(input.goal.goalId, input.fence, input.abort.signal);
    }
    input.abort.abort();
    await Promise.allSettled([controls]);
    await this.control.settleRuntime(execution, input.runtime, input.fence);
    if (winner.source === 'control') return execution;
    execution = await this.executions.get(input.goal.goalId) ?? execution;
    input.track(execution);
    if (!execution.providerSessionId || !execution.providerThreadId) {
      throw new Error('Provider finished before persisting a recoverable session identity');
    }
    await this.finish({
      goalId: input.goal.goalId, execution, result: winner.result,
      runtime: input.runtime, fence: input.fence,
    });
    return execution;
  }

  private async closeSteering(
    goalId: string,
    fence: GoalLeaseFence,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + this.options.settlementTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.runtimeControls.beginCompletion({
        goalId, fence, reason: 'provider_completed_steering_closed',
      })) return;
      await abortableDelay(this.options.controlPollMs, signal);
    }
    throw new Error('Timed out draining messages during provider completion');
  }

  private async finish(input: {
    goalId: string;
    execution: GoalRuntimeExecution;
    result: GoalRuntimeResult;
    runtime: GoalProviderRuntime;
    fence: GoalLeaseFence;
  }): Promise<void> {
    const { goalId, execution, result, runtime, fence } = input;
    if (result.outcome === 'paused') {
      await this.control.pauseAtBoundary(
        await this.options.repository.requireGoal(goalId), execution, runtime, fence
      );
      return;
    }
    if (result.outcome === 'cancelled') {
      if (await this.runtimeControls.hasPendingCancellation(goalId)) {
        await this.control.cancelAtBoundary(
          await this.options.repository.requireGoal(goalId), execution, runtime, fence
        );
      }
      return;
    }
    if (result.outcome === 'interrupted' || (result.outcome === 'failed' && result.recoverable)) {
      const reason = result.outcome === 'interrupted' ? result.reason : result.error;
      const checkpoint = result.outcome === 'interrupted' ? result.checkpoint : undefined;
      await this.executions.updateState({
        goalId, executionId: execution.executionId, state: 'interrupted', fence,
        fields: { checkpoint },
      });
      await this.markRecovering(goalId, execution, fence, reason ?? 'provider_interrupted');
      return;
    }
    if (result.outcome === 'failed') {
      await this.executions.updateState({
        goalId, executionId: execution.executionId, state: 'failed', fence,
      });
      await this.failGoal(goalId, execution, fence, result.error);
      return;
    }
    await this.completeWithVerifiedArtifact(goalId, execution, fence);
  }

  private async completeWithVerifiedArtifact(
    goalId: string,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.executions.updateState({
      goalId, executionId: execution.executionId, state: 'completing', fence,
    });
    const current = await this.options.repository.requireGoal(goalId);
    if (current.state !== 'completing') {
      throw new Error('Completion started without a durable steering close handshake');
    }
    const artifact = await this.artifacts.getFinal(goalId);
    if (!artifact || artifact.executionId !== execution.executionId) {
      await this.failGoal(goalId, execution, fence, 'A durable final epic pull request association is required');
      return;
    }
    try {
      const verified = await this.options.artifactVerifier.verifyFinalPullRequest(artifact);
      await this.artifacts.markVerified({
        goalId, executionId: execution.executionId, verified, fence,
      });
    } catch (error) {
      await this.executions.updateState({
        goalId, executionId: execution.executionId, state: 'failed', fence,
      });
      await this.failGoal(
        goalId, execution, fence,
        `Final epic PR verification failed: ${(error as Error).message}`
      );
      return;
    }
    await this.executions.updateState({
      goalId, executionId: execution.executionId, state: 'completed', fence,
    });
    await this.options.repository.transition(goalId, {
      toState: 'completed', ...fence, terminalReason: 'objective_met',
      reason: 'final_epic_pr_verified_draft_for_human',
      idempotencyKey: durableGoalKey('completed', execution.executionId),
    });
  }

  private async enterControllerState(goal: Goal, fence: GoalLeaseFence): Promise<Goal> {
    if (goal.state === 'queued') return this.options.repository.transition(goal.goalId, {
      toState: 'planning', ...fence, reason: 'native_goal_launch',
      idempotencyKey: durableGoalKey('launch', goal.goalId),
    });
    if (goal.state === 'running') return this.options.repository.transition(goal.goalId, {
      toState: 'recovering', ...fence, reason: 'controller_startup_recovery',
      idempotencyKey: durableGoalKey('recovering', goal.goalId, fence.leaseEpoch),
    });
    return goal;
  }

  private async markRecovering(
    goalId: string,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    reason: string
  ): Promise<void> {
    await this.options.repository.upsertProviderSession(goalId, execution.agent, {
      ...fence,
      lastCheckpoint: execution.lastCheckpoint,
      recoveryMetadata: {
        schemaVersion: 1,
        providerState: execution.providerThreadId ? 'recoverable' : 'interrupted',
        reason: reason.slice(0, 256),
      },
    });
    const goal = await this.options.repository.requireGoal(goalId);
    if (goal.state === 'running') await this.options.repository.transition(goalId, {
      toState: 'recovering', ...fence, reason: reason.slice(0, 1000),
      idempotencyKey: durableGoalKey(
        'interrupted', execution.executionId, fence.leaseEpoch
      ),
    });
  }

  private async failGoal(
    goalId: string,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    error: string
  ): Promise<void> {
    const goal = await this.options.repository.requireGoal(goalId);
    if (isTerminalGoalState(goal.state)) return;
    await this.options.repository.appendEvent(goalId, {
      ...fence,
      kind: 'lifecycle', eventType: 'provider.failed', payload: { error },
      idempotencyKey: durableGoalKey('failed-event', execution.executionId),
    });
    await this.options.repository.transition(goalId, {
      toState: 'failed', ...fence, terminalReason: 'unrecoverable_error',
      reason: error.slice(0, 1000),
      idempotencyKey: durableGoalKey('terminal-failed', execution.executionId),
    });
  }

  private async recordInterruption(
    goalId: string,
    execution: GoalRuntimeExecution | null,
    fence: GoalLeaseFence | null,
    error: unknown
  ): Promise<void> {
    if (!execution || !fence) return;
    try {
      const goal = await this.options.repository.requireGoal(goalId);
      if (isTerminalGoalState(goal.state)) return;
      await this.executions.updateState({
        goalId, executionId: execution.executionId, state: 'interrupted', fence,
      });
      await this.markRecovering(
        goalId, execution, fence, (error as Error).message || 'controller_interrupted'
      );
    } catch (recordError) {
      if (!isExpectedOwnershipEnd(recordError)) logger.warn(
        { goalId, error: (recordError as Error).message },
        'Failed to persist goal interruption'
      );
    }
  }

  private async releaseLease(goalId: string, fence: GoalLeaseFence): Promise<void> {
    try {
      await this.options.repository.releaseLease(goalId, fence.leaseOwner, fence.leaseEpoch);
    } catch (error) {
      if (!isExpectedOwnershipEnd(error)) logger.warn(
        { goalId, error: (error as Error).message },
        'Failed to release goal controller lease'
      );
    }
  }
}
