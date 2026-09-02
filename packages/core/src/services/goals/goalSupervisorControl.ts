import { GoalExecutionRepository } from './goalExecutionRepository.js';
import { GoalRepository } from './goalRepository.js';
import { GoalRuntimeControlRepository } from './goalRuntimeControlRepository.js';
import type { Goal, GoalLeaseFence, GoalMessage } from './goalTypes.js';
import type { GoalProviderRuntime, GoalRuntimeExecution } from './goalRuntimeTypes.js';
import {
  abortableDelay,
  durableGoalKey,
  runtimeAuthority,
} from './goalSupervisorUtilities.js';

interface ControlSettings {
  leaseTtlMs: number;
  controlPollMs: number;
  settlementTimeoutMs: number;
}

export class GoalSupervisorControl {
  constructor(
    private readonly repository: GoalRepository,
    private readonly executions: GoalExecutionRepository,
    private readonly controls: GoalRuntimeControlRepository,
    private readonly settings: ControlSettings
  ) {}

  async run(input: {
    goalId: string;
    execution: GoalRuntimeExecution;
    runtime: GoalProviderRuntime;
    fence: GoalLeaseFence;
    abort: AbortController;
  }): Promise<'paused' | 'cancelled' | null> {
    const { goalId, runtime, fence, abort } = input;
    let execution = input.execution;
    while (!abort.signal.aborted) {
      try {
        await abortableDelay(this.settings.controlPollMs, abort.signal);
        if (abort.signal.aborted) return null;
        const goal = await this.repository.requireGoal(goalId);
        if (await this.controls.hasPendingCancellation(goalId)) {
          execution = await this.executions.get(goalId) ?? execution;
          await this.cancelAtBoundary(goal, execution, runtime, fence);
          return 'cancelled';
        }
        await this.repository.renewLease(
          goalId, fence.leaseOwner, fence.leaseEpoch, this.settings.leaseTtlMs
        );
        execution = await this.executions.heartbeat(goalId, execution.executionId, fence);
        if (goal.state === 'pausing') {
          await this.pauseAtBoundary(goal, execution, runtime, fence);
          return 'paused';
        }
        if (goal.requestedModel !== goal.effectiveModel && execution.providerThreadId) {
          execution = await this.applyPendingModel(goal, execution, runtime, fence);
        }
        if (execution.providerThreadId) {
          await this.deliverMessages(goalId, execution, runtime, fence);
        }
      } catch (error) {
        if (abort.signal.aborted) return null;
        abort.abort(error);
        throw error;
      }
    }
    return null;
  }

  async pauseAtBoundary(
    goal: Goal,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.executions.updateState({
      goalId: goal.goalId, executionId: execution.executionId, state: 'pausing', fence,
    });
    if (execution.providerThreadId) {
      const authority = runtimeAuthority(this.repository, goal.goalId, fence);
      await authority.assertCurrent();
      await runtime.pause(execution, authority);
      await this.settleRuntime(execution, runtime, fence);
    }
    await this.executions.updateState({
      goalId: goal.goalId, executionId: execution.executionId, state: 'paused', fence,
    });
    const current = await this.repository.requireGoal(goal.goalId);
    if (current.state === 'pausing') {
      await this.repository.transition(goal.goalId, {
        toState: 'paused', ...fence, reason: 'provider_safe_boundary_paused',
        idempotencyKey: durableGoalKey('paused', execution.executionId, fence.leaseEpoch),
      });
    }
  }

  async cancelAtBoundary(
    goal: Goal,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    const cancelling = await this.executions.updateState({
      goalId: goal.goalId, executionId: execution.executionId, state: 'cancelling', fence,
    });
    if (cancelling.providerThreadId || cancelling.providerSessionId || cancelling.runtimeId) {
      const authority = runtimeAuthority(this.repository, goal.goalId, fence);
      await authority.assertCurrent();
      await runtime.cancel(cancelling, authority);
      await this.settleRuntime(cancelling, runtime, fence);
    }
    await this.controls.finalizeCancellation({
      goalId: goal.goalId, executionId: execution.executionId, fence,
    });
  }

  async applyPendingModel(
    goal: Goal,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    const authority = runtimeAuthority(this.repository, goal.goalId, fence);
    await authority.assertCurrent();
    const changed = await runtime.changeModel(execution, goal.requestedModel, authority);
    if (changed.effectiveModel !== goal.requestedModel) {
      throw new Error('Provider did not acknowledge the requested model');
    }
    return this.executions.reconcileModelChange({
      goalId: goal.goalId,
      executionId: execution.executionId,
      effectiveModel: changed.effectiveModel,
      fence,
    });
  }

  async settleRuntime(
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    const authority = runtimeAuthority(this.repository, execution.goalId, fence);
    await this.repository.renewLease(
      execution.goalId, fence.leaseOwner, fence.leaseEpoch, this.settings.leaseTtlMs
    );
    const renew = setInterval(() => {
      void this.repository.renewLease(
        execution.goalId, fence.leaseOwner, fence.leaseEpoch, this.settings.leaseTtlMs
      ).catch(() => undefined);
    }, Math.max(100, Math.floor(this.settings.leaseTtlMs / 3)));
    renew.unref?.();
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runtime.settle(execution, authority),
        new Promise<void>(resolve => {
          timeout = setTimeout(() => { timedOut = true; resolve(); }, this.settings.settlementTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (timedOut) {
        await authority.assertCurrent();
        await runtime.terminate(execution, authority);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(renew);
    }
  }

  private async deliverMessages(
    goalId: string,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    const messages = await this.repository.getMessages(goalId);
    for (const message of messages) {
      if (message.state === 'acknowledged') continue;
      await this.deliverMessage({ goalId, execution, runtime, fence, message });
      const current = (await this.repository.getMessages(goalId))
        .find(item => item.messageId === message.messageId);
      if (current?.state !== 'acknowledged') break;
    }
  }

  private async deliverMessage(input: {
    goalId: string;
    execution: GoalRuntimeExecution;
    runtime: GoalProviderRuntime;
    fence: GoalLeaseFence;
    message: GoalMessage;
  }): Promise<void> {
    const { goalId, execution, runtime, fence, message } = input;
    const authority = runtimeAuthority(this.repository, goalId, fence);
    await authority.assertCurrent();
    const result = await runtime.steer({
      execution, providerMessageId: message.messageId, body: message.body,
      predefinedKind: message.predefinedKind, authority,
    });
    if (message.state === 'queued') {
      await this.repository.markMessageDelivered(goalId, message.messageId, fence);
    }
    if (result.acknowledged) {
      await this.repository.markMessageAcknowledged(goalId, message.messageId, fence);
    }
  }
}
