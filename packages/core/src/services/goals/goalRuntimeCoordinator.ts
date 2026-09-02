import { GOAL_ERROR_CODES } from '@propr/shared';
import type { GoalControllerOptions } from './goalController.js';
import { GoalOrchestrationRepository } from './goalOrchestrationRepository.js';
import { GoalError } from './goalRepositorySupport.js';
import { GoalRepository } from './goalRepository.js';
import type { GoalRuntimeExecution, GoalRuntimePort } from './goalOrchestrationTypes.js';
import type { GoalLeaseFence } from './goalTypes.js';

interface RuntimeCoordinatorDependencies {
  goals: GoalRepository;
  orchestration: GoalOrchestrationRepository;
  runtime: GoalRuntimePort;
  options: GoalControllerOptions;
  completeAttempt(input: {
    goalId: string;
    attemptId: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    hasDiff?: boolean;
    fence: GoalLeaseFence;
  }): Promise<void>;
}

/** Provider-facing recovery and operator behavior, isolated from GitHub orchestration. */
export class GoalRuntimeCoordinator {
  constructor(private readonly dependencies: RuntimeCoordinatorDependencies) {}

  async dispatchReadyWork(goalId: string, fence: GoalLeaseFence): Promise<number> {
    const { orchestration, options } = this.dependencies;
    const reservations = await orchestration.reserveRunnableNodes(goalId, fence, {
      repositoryMaxActiveTasks: options.repositoryMaxActiveTasks,
      ttlMs: options.reservationTtlMs,
    });
    let dispatched = 0;
    for (const reservation of reservations) {
      await orchestration.markAttemptDispatching(goalId, reservation.attempt.attemptId, fence);
      if (await this.reconcileDispatchingAttempt(goalId, reservation.attempt.attemptId, fence)) dispatched += 1;
    }
    return dispatched;
  }

  async reconcileAttempts(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const { orchestration, runtime } = this.dependencies;
    const attempts = (await orchestration.getAttempts(goalId))
      .filter((attempt) => ['dispatching', 'running', 'safe_boundary'].includes(attempt.status));
    for (const attempt of attempts) {
      if (attempt.status === 'dispatching') {
        await this.reconcileDispatchingAttempt(goalId, attempt.attemptId, fence);
        continue;
      }
      try {
        const observed = await runtime.lookup({ dispatchIdentity: attempt.dispatchIdentity, controllerFence: fence });
        if (isTerminalExecution(observed)) await this.applyTerminal(goalId, attempt.attemptId, observed, fence);
      } catch {
        // Transient lookup failures retain the durable provider identity for adoption.
      }
    }
  }

  async drainMessages(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const { goals, orchestration, runtime } = this.dependencies;
    const attempt = (await orchestration.getAttempts(goalId)).find((candidate) =>
      candidate.status === 'running' && candidate.sessionId
    );
    if (!attempt?.sessionId) return;
    const pending = (await goals.getMessages(goalId)).filter((message) => message.state !== 'acknowledged');
    for (const message of pending) {
      await runtime.sendFollowup({
        attemptId: attempt.attemptId, sessionId: attempt.sessionId,
        messageId: message.messageId, body: message.body, controllerFence: fence,
      });
      if (message.state === 'queued') await goals.markMessageDelivered(goalId, message.messageId, fence);
      await goals.markMessageAcknowledged(goalId, message.messageId, fence);
    }
  }

  async cancel(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const { goals, orchestration, runtime } = this.dependencies;
    await orchestration.releaseUndispatchedAttemptsForPause(goalId, fence);
    const active = (await orchestration.getAttempts(goalId)).filter((attempt) =>
      ['dispatching', 'running', 'safe_boundary'].includes(attempt.status)
    );
    for (const attempt of active) {
      let observed = await runtime.lookup({ dispatchIdentity: attempt.dispatchIdentity, controllerFence: fence });
      if (!isTerminalExecution(observed) && observed.state !== 'absent') {
        observed = await runtime.stop({
          dispatchIdentity: attempt.dispatchIdentity, attemptId: attempt.attemptId,
          sessionId: attempt.sessionId, controllerFence: fence,
        });
      }
      if (observed.state === 'absent') {
        await orchestration.finishAttempt(goalId, attempt.attemptId, 'cancelled', fence);
      } else if (isTerminalExecution(observed)) {
        await this.applyTerminal(goalId, attempt.attemptId, observed, fence);
      }
    }
    const remaining = (await orchestration.getAttempts(goalId)).some((attempt) =>
      ['reserved', 'dispatching', 'running', 'safe_boundary'].includes(attempt.status)
    );
    if (!remaining) {
      await goals.transition(goalId, {
        toState: 'cancelled', terminalReason: 'user_cancelled',
        reason: 'All runtime executions stopped or adopted terminal', ...fence,
      });
    }
  }

  async pause(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const { goals, orchestration, runtime } = this.dependencies;
    await orchestration.releaseUndispatchedAttemptsForPause(goalId, fence);
    const active = (await orchestration.getAttempts(goalId)).filter((attempt) =>
      attempt.status === 'running' && attempt.sessionId
    );
    for (const attempt of active) {
      await orchestration.assertFence(goalId, fence);
      await runtime.requestSafeBoundary({
        attemptId: attempt.attemptId, sessionId: attempt.sessionId!, controllerFence: fence,
      });
      const observed = await runtime.lookup({ dispatchIdentity: attempt.dispatchIdentity, controllerFence: fence });
      if (observed.state === 'safe_boundary') {
        await orchestration.markAttemptSafeBoundary(goalId, attempt.attemptId, fence);
      } else if (isTerminalExecution(observed)) {
        await this.applyTerminal(goalId, attempt.attemptId, observed, fence);
      }
    }
    const remaining = (await orchestration.getAttempts(goalId)).some((attempt) =>
      ['reserved', 'dispatching', 'running'].includes(attempt.status)
    );
    if (!remaining) {
      await goals.transition(goalId, { toState: 'paused', reason: 'All active attempts reached safe boundaries', ...fence });
    }
  }

  async resume(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const { orchestration, runtime } = this.dependencies;
    const paused = (await orchestration.getAttempts(goalId)).filter((attempt) =>
      attempt.status === 'safe_boundary' && attempt.sessionId
    );
    for (const attempt of paused) {
      await runtime.resume({ attemptId: attempt.attemptId, sessionId: attempt.sessionId!, controllerFence: fence });
      const observed = await runtime.lookup({ dispatchIdentity: attempt.dispatchIdentity, controllerFence: fence });
      if (observed.state === 'running') await orchestration.resumeAttempt(goalId, attempt.attemptId, fence);
    }
  }

  private async reconcileDispatchingAttempt(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<boolean> {
    const { goals, orchestration, runtime } = this.dependencies;
    const attempt = (await orchestration.getAttempts(goalId)).find((candidate) => candidate.attemptId === attemptId);
    if (!attempt || attempt.status !== 'dispatching') return false;
    try {
      let observed = await runtime.lookup({ dispatchIdentity: attempt.dispatchIdentity, controllerFence: fence });
      if (observed.state === 'absent') {
        const goal = await goals.requireGoal(goalId);
        const node = (await orchestration.getCurrentPlan(goalId))?.plan.nodes.find((candidate) => candidate.nodeId === attempt.nodeId);
        const issue = (await orchestration.getArtifacts(goalId)).find((artifact) =>
          artifact.nodeId === attempt.nodeId && artifact.kind === 'issue' && artifact.state === 'present'
        );
        if (!node || !issue?.number) throw new Error('Required exact issue/branch artifacts disappeared before dispatch');
        const result = await runtime.dispatch({
          goalId, nodeId: node.nodeId, executionId: attempt.executionId,
          attemptNumber: attempt.attemptNumber, attemptId: attempt.attemptId,
          dispatchIdentity: attempt.dispatchIdentity, repository: goal.repository,
          agent: goal.agent, issueNumber: issue.number, baseBranch: node.baseBranch,
          headBranch: node.headBranch, model: attempt.effectiveModel,
          acceptanceCriteria: node.acceptanceCriteria, controllerFence: fence,
        });
        observed = {
          dispatchIdentity: attempt.dispatchIdentity, state: 'running',
          sessionId: result.sessionId, externalRef: result.externalRef,
        };
      }
      if (isTerminalExecution(observed)) {
        await this.applyTerminal(goalId, attemptId, observed, fence);
        return true;
      }
      if (!observed.sessionId) throw new Error('Runtime lookup returned live execution without a session ID');
      await orchestration.markAttemptDispatched(goalId, attemptId, {
        sessionId: observed.sessionId, externalRef: observed.externalRef,
      }, fence);
      if (observed.state === 'safe_boundary') await orchestration.markAttemptSafeBoundary(goalId, attemptId, fence);
      return true;
    } catch (error) {
      if (error instanceof GoalError && error.code === GOAL_ERROR_CODES.staleLease) throw error;
      await orchestration.recordDispatchError(goalId, attemptId, error instanceof Error ? error.message : String(error), fence);
      return false;
    }
  }

  private applyTerminal(
    goalId: string,
    attemptId: string,
    observed: GoalRuntimeExecution,
    fence: GoalLeaseFence
  ): Promise<void> {
    const status = observed.state === 'succeeded' ? 'succeeded'
      : observed.state === 'failed' ? 'failed' : 'cancelled';
    return this.dependencies.completeAttempt({ goalId, attemptId, status, hasDiff: observed.hasDiff, fence });
  }
}

function isTerminalExecution(execution: GoalRuntimeExecution): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(execution.state);
}
