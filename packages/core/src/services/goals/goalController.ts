import { GOAL_ERROR_CODES } from '@propr/shared';
import type { GoalLeaseFence } from './goalTypes.js';
import { GoalError } from './goalRepositorySupport.js';
import { GoalRepository } from './goalRepository.js';
import { GoalOrchestrationRepository, parseGoalArtifactMarker } from './goalOrchestrationRepository.js';
import type {
  GoalEventPort,
  GoalGitHubPort,
  GoalPlanInput,
  GoalReadinessPolicy,
  GoalRuntimePort,
  ValidatedGoalPlanNode,
} from './goalOrchestrationTypes.js';

export interface GoalControllerOptions {
  controllerId: string;
  repositoryMaxActiveTasks?: number;
  reservationTtlMs?: number;
  outboxBatchSize?: number;
}

export interface GoalControllerTickResult {
  reconciledArtifacts: number;
  processedOperations: number;
  dispatchedAttempts: number;
  completionState: 'not_ready' | 'ready' | 'waiting_for_merge';
}

/**
 * Coordinates durable state and side-effect ports.  The class intentionally has
 * no command, checkout, worktree, git, or container handle; implementation code
 * can only be produced by the separately owned runtime port.
 */
export class GoalController {
  // The controller boundary keeps its state stores and restricted side-effect ports explicit.
  // eslint-disable-next-line max-params
  constructor(
    private readonly goals: GoalRepository,
    private readonly orchestration: GoalOrchestrationRepository,
    private readonly runtime: GoalRuntimePort,
    private readonly github: GoalGitHubPort,
    private readonly events: GoalEventPort,
    private readonly options: GoalControllerOptions
  ) {}

  async installPlan(goalId: string, planInput: GoalPlanInput, fence: GoalLeaseFence): Promise<void> {
    const installed = await this.orchestration.installPlan(goalId, planInput, fence);
    for (const node of installed.plan.nodes) await this.ensureInitialArtifacts(goalId, node, fence);
    await this.events.emit({
      goalId,
      type: installed.replayed ? 'goal.plan_reconciled' : 'goal.plan_installed',
      payload: { revision: installed.revision, planHash: installed.plan.hash, nodeCount: installed.plan.nodes.length },
      controllerFence: fence,
    });
  }

  async tick(goalId: string, fence: GoalLeaseFence, readinessPolicy?: GoalReadinessPolicy): Promise<GoalControllerTickResult> {
    await this.orchestration.assertFence(goalId, fence);
    const reconciledArtifacts = await this.reconcile(goalId, fence);
    await this.queueReadyIntegrationPullRequests(goalId, fence);
    const processedOperations = await this.drainOutbox(goalId, fence);
    const goal = await this.goals.requireGoal(goalId);
    if (goal.state === 'pausing') await this.moveAttemptsToSafeBoundaries(goalId, fence);
    if (goal.state === 'running') await this.resumeAttemptsFromSafeBoundaries(goalId, fence);
    const dispatchedAttempts = ['planning', 'running', 'recovering'].includes(goal.state)
      ? await this.dispatchReadyWork(goalId, fence)
      : 0;

    let completionState: GoalControllerTickResult['completionState'] = 'not_ready';
    let becameTerminal = false;
    if (readinessPolicy) {
      const readiness = await this.orchestration.goalCompletionReadiness(goalId, readinessPolicy);
      if (readiness.terminalAction === 'wait_for_merge') completionState = 'waiting_for_merge';
      if (readiness.ready && readiness.terminalAction === 'complete') completionState = 'ready';
      if (readiness.terminalAction === 'wait_for_merge' && goal.state !== 'completing') {
        await this.goals.transition(goalId, { toState: 'completing', reason: 'Final epic PR is ready and awaiting automatic merge', ...fence });
      }
      if (readiness.ready && readiness.terminalAction === 'complete' && goal.state !== 'completed') {
        const completing = goal.state === 'completing'
          ? goal
          : await this.goals.transition(goalId, { toState: 'completing', reason: 'Final epic PR passed completion policy', ...fence });
        if (completing.state === 'completing') {
          await this.goals.transition(goalId, { toState: 'completed', terminalReason: 'objective_met', reason: 'Goal completion gate passed', ...fence });
          becameTerminal = true;
        }
      }
    }
    if (!becameTerminal) {
      await this.orchestration.heartbeat(goalId, this.options.controllerId, {
        reconciledArtifacts, processedOperations, dispatchedAttempts, completionState,
      }, fence);
    }
    return { reconciledArtifacts, processedOperations, dispatchedAttempts, completionState };
  }

  async queueImplementationPullRequest(goalId: string, nodeId: string, hasDiff: boolean, fence: GoalLeaseFence): Promise<void> {
    const current = await this.orchestration.getCurrentPlan(goalId);
    const node = current?.plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Planned node not found', 404);
    if (!hasDiff) {
      await this.orchestration.recordNoDiffArtifact(goalId, nodeId, fence);
      await this.events.emit({
        goalId, type: 'goal.node.no_code', payload: { nodeId }, controllerFence: fence,
      });
      return;
    }
    // Base comes exclusively from the validated hierarchy.  Callers cannot
    // accidentally substitute the repository default branch for a leaf PR.
    await this.orchestration.enqueueGitHubOperation({
      goalId, nodeId, artifactKind: 'pull_request', operationKind: 'create_pull_request',
      idempotencyKey: `pr:${nodeId}`, head: node.headBranch, base: node.baseBranch,
      payload: {
        title: node.title,
        draft: node.kind === 'root_epic' || node.kind === 'sub_epic',
        head: node.headBranch,
        base: node.baseBranch,
      },
      ...fence,
    });
  }

  async completeRuntimeAttempt(
    goalId: string,
    attemptId: string,
    result: { status: 'succeeded' | 'failed' | 'cancelled'; hasDiff?: boolean },
    fence: GoalLeaseFence
  ): Promise<void> {
    const attempt = await this.orchestration.finishAttempt(goalId, attemptId, result.status, fence);
    if (result.status === 'succeeded') await this.queueImplementationPullRequest(goalId, attempt.nodeId, result.hasDiff === true, fence);
  }

  async drainOutbox(goalId: string, fence: GoalLeaseFence): Promise<number> {
    const operations = await this.orchestration.claimGitHubOperations(
      goalId, this.options.controllerId, this.options.outboxBatchSize ?? 20, fence
    );
    let completed = 0;
    for (const operation of operations) {
      const marker = parseGoalArtifactMarker(operation.marker);
      try {
        // Adoption precedes every POST. This closes the crash window where the
        // remote succeeded but the local transaction never committed.
        await this.orchestration.assertFence(goalId, fence);
        const existing = await this.github.findByMarker(marker);
        const effectAlreadyPresent = existing !== null && (
          operation.operationKind.startsWith('create_')
          || (operation.operationKind === 'merge_pull_request' && existing.state === 'merged')
        );
        if (effectAlreadyPresent) {
          await this.orchestration.assertFence(goalId, fence);
          await this.orchestration.adoptGitHubArtifact(goalId, operation.operationId, existing, fence);
          if (operation.operationKind === 'merge_pull_request' && marker.base) {
            await this.orchestration.releaseBranchLock(goalId, marker.base, this.options.controllerId, fence);
          }
          completed += 1;
          continue;
        }
        await this.orchestration.assertFence(goalId, fence);
        const result = await this.github.execute(operation, marker);
        // Recheck after the remote boundary: a replaced controller may not make
        // the result authoritative. Its successor will adopt by marker.
        await this.orchestration.assertFence(goalId, fence);
        if (result) await this.orchestration.adoptGitHubArtifact(goalId, operation.operationId, result, fence);
        else await this.orchestration.completeNoArtifactOperation(goalId, operation.operationId, fence);
        if (operation.operationKind === 'merge_pull_request' && marker.base) {
          await this.orchestration.releaseBranchLock(goalId, marker.base, this.options.controllerId, fence);
        }
        completed += 1;
      } catch (error) {
        if (error instanceof GoalError && error.code === GOAL_ERROR_CODES.staleLease) throw error;
        await this.orchestration.retryGitHubOperation(
          goalId, operation.operationId, error instanceof Error ? error.message : String(error), fence
        );
      }
    }
    return completed;
  }

  async reconcile(goalId: string, fence: GoalLeaseFence): Promise<number> {
    const artifacts = await this.orchestration.getArtifacts(goalId);
    if (artifacts.length === 0) return 0;
    const markers = artifacts.map((artifact) => parseGoalArtifactMarker(artifact.marker));
    const goal = await this.goals.requireGoal(goalId);
    await this.orchestration.assertFence(goalId, fence);
    const remotes = await this.github.inspectGoal(goal.repository, markers);
    await this.orchestration.assertFence(goalId, fence);
    await this.orchestration.reconcileArtifacts(goalId, remotes, fence);
    return remotes.length;
  }

  async queueIntegrationMerge(goalId: string, nodeId: string, fence: GoalLeaseFence): Promise<boolean> {
    const current = await this.orchestration.getCurrentPlan(goalId);
    const node = current?.plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Planned node not found', 404);
    const locked = await this.orchestration.acquireBranchLock(
      goalId, nodeId, node.baseBranch, this.options.controllerId, 5 * 60_000, fence
    );
    if (!locked) return false;
    try {
      await this.orchestration.enqueueGitHubOperation({
        goalId, nodeId, artifactKind: 'pull_request', operationKind: 'merge_pull_request',
        idempotencyKey: `merge:${nodeId}`, head: node.headBranch, base: node.baseBranch,
        payload: { head: node.headBranch, base: node.baseBranch }, ...fence,
      });
      return true;
    } catch (error) {
      await this.orchestration.releaseBranchLock(goalId, node.baseBranch, this.options.controllerId, fence);
      throw error;
    }
  }

  private async ensureInitialArtifacts(goalId: string, node: ValidatedGoalPlanNode, fence: GoalLeaseFence): Promise<void> {
    await this.orchestration.enqueueGitHubOperation({
      goalId, nodeId: node.nodeId, artifactKind: 'issue', operationKind: 'create_issue',
      idempotencyKey: `issue:${node.nodeId}`, payload: {
        title: node.title,
        acceptanceCriteria: node.acceptanceCriteria,
        parentNodeId: node.parentNodeId,
      },
      ...fence,
    });
    if (!node.noCode) {
      await this.orchestration.enqueueGitHubOperation({
        goalId, nodeId: node.nodeId, artifactKind: 'branch', operationKind: 'create_branch',
        idempotencyKey: `branch:${node.nodeId}`, head: node.headBranch, base: node.baseBranch,
        payload: { head: node.headBranch, base: node.baseBranch },
        ...fence,
      });
    }
  }

  private async queueReadyIntegrationPullRequests(goalId: string, fence: GoalLeaseFence): Promise<void> {
    const current = await this.orchestration.getCurrentPlan(goalId);
    if (!current) return;
    const goal = await this.goals.requireGoal(goalId);
    const artifacts = await this.orchestration.getArtifacts(goalId);
    for (const node of current.plan.nodes.filter((candidate) => candidate.kind === 'root_epic' || candidate.kind === 'sub_epic')) {
      if (artifacts.some((artifact) => artifact.nodeId === node.nodeId && artifact.kind === 'pull_request' && artifact.state !== 'deleted')) continue;
      if (!await this.orchestration.descendantsIntegrated(goalId, node.nodeId)) continue;
      await this.orchestration.assertFence(goalId, fence);
      const hasDiff = await this.github.branchHasDiff(goal.repository, node.headBranch, node.baseBranch);
      await this.orchestration.assertFence(goalId, fence);
      await this.queueImplementationPullRequest(goalId, node.nodeId, hasDiff, fence);
    }
  }

  private async dispatchReadyWork(goalId: string, fence: GoalLeaseFence): Promise<number> {
    const reservations = await this.orchestration.reserveRunnableNodes(goalId, fence, {
      repositoryMaxActiveTasks: this.options.repositoryMaxActiveTasks,
      ttlMs: this.options.reservationTtlMs,
    });
    if (reservations.length === 0) return 0;
    const goal = await this.goals.requireGoal(goalId);
    const artifacts = await this.orchestration.getArtifacts(goalId);
    let dispatched = 0;
    for (const reservation of reservations) {
      const issue = artifacts.find((artifact) => artifact.nodeId === reservation.node.nodeId && artifact.kind === 'issue');
      try {
        await this.orchestration.markAttemptDispatching(goalId, reservation.attempt.attemptId, fence);
        await this.orchestration.assertFence(goalId, fence);
        const result = await this.runtime.dispatch({
          goalId,
          nodeId: reservation.node.nodeId,
          executionId: reservation.attempt.executionId,
          attemptNumber: reservation.attempt.attemptNumber,
          attemptId: reservation.attempt.attemptId,
          repository: goal.repository,
          issueNumber: issue?.number ?? null,
          baseBranch: reservation.node.baseBranch,
          headBranch: reservation.node.headBranch,
          model: reservation.attempt.effectiveModel,
          acceptanceCriteria: reservation.node.acceptanceCriteria,
          controllerFence: fence,
        });
        await this.orchestration.assertFence(goalId, fence);
        await this.orchestration.markAttemptDispatched(goalId, reservation.attempt.attemptId, result, fence);
        dispatched += 1;
      } catch (error) {
        if (error instanceof GoalError && error.code === GOAL_ERROR_CODES.staleLease) throw error;
        await this.orchestration.finishAttempt(goalId, reservation.attempt.attemptId, 'failed', fence);
      }
    }
    return dispatched;
  }

  private async moveAttemptsToSafeBoundaries(goalId: string, fence: GoalLeaseFence): Promise<void> {
    await this.orchestration.releaseUndispatchedAttemptsForPause(goalId, fence);
    if (!this.runtime.requestSafeBoundary) return;
    const active = (await this.orchestration.getAttempts(goalId)).filter((attempt) => attempt.status === 'running' && attempt.sessionId);
    for (const attempt of active) {
      await this.orchestration.assertFence(goalId, fence);
      await this.runtime.requestSafeBoundary({
        attemptId: attempt.attemptId, sessionId: attempt.sessionId!, controllerFence: fence,
      });
      await this.orchestration.assertFence(goalId, fence);
      await this.orchestration.markAttemptSafeBoundary(goalId, attempt.attemptId, fence);
    }
    const remaining = (await this.orchestration.getAttempts(goalId)).filter((attempt) =>
      ['reserved', 'dispatching', 'running'].includes(attempt.status)
    );
    if (remaining.length === 0) {
      await this.goals.transition(goalId, {
        toState: 'paused', reason: 'All active attempts reached safe boundaries', ...fence,
      });
    }
  }

  private async resumeAttemptsFromSafeBoundaries(goalId: string, fence: GoalLeaseFence): Promise<void> {
    if (!this.runtime.resume) return;
    const paused = (await this.orchestration.getAttempts(goalId)).filter((attempt) => attempt.status === 'safe_boundary' && attempt.sessionId);
    for (const attempt of paused) {
      await this.orchestration.assertFence(goalId, fence);
      await this.runtime.resume({ attemptId: attempt.attemptId, sessionId: attempt.sessionId!, controllerFence: fence });
      await this.orchestration.assertFence(goalId, fence);
      await this.orchestration.resumeAttempt(goalId, attempt.attemptId, fence);
    }
  }
}
