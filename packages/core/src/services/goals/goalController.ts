import { GOAL_ERROR_CODES } from '@propr/shared';
import type { Goal, GoalLeaseFence } from './goalTypes.js';
import { GoalError } from './goalRepositorySupport.js';
import { GoalRepository } from './goalRepository.js';
import { GoalRuntimeCoordinator } from './goalRuntimeCoordinator.js';
import { GoalOrchestrationRepository, parseGoalArtifactMarker } from './goalOrchestrationRepository.js';
import type {
  GoalEventPort,
  GoalAttempt,
  GoalClaimedOutboxOperation,
  GoalGitHubArtifact,
  GoalGitHubPort,
  GoalPlanInput,
  GoalReadinessPolicy,
  GoalRuntimePort,
  GoalValidationPort,
  ValidatedGoalPlanNode,
} from './goalOrchestrationTypes.js';

export interface GoalControllerOptions {
  controllerId: string;
  repositoryMaxActiveTasks?: number;
  reservationTtlMs?: number;
  outboxBatchSize?: number;
  outboxClaimTtlMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private readonly runtimeCoordinator: GoalRuntimeCoordinator;
  // The controller boundary keeps its state stores and restricted side-effect ports explicit.
  // eslint-disable-next-line max-params
  constructor(
    private readonly goals: GoalRepository,
    private readonly orchestration: GoalOrchestrationRepository,
    private readonly runtime: GoalRuntimePort,
    private readonly github: GoalGitHubPort,
    private readonly events: GoalEventPort,
    private readonly options: GoalControllerOptions,
    private readonly validation?: GoalValidationPort
  ) {
    this.runtimeCoordinator = new GoalRuntimeCoordinator({
      goals, orchestration, runtime, options,
      completeAttempt: async (input) => this.completeRuntimeAttempt(
        input.goalId, input.attemptId, { status: input.status, hasDiff: input.hasDiff }, input.fence
      ),
    });
  }

  async installPlan(goalId: string, planInput: GoalPlanInput, fence: GoalLeaseFence): Promise<void> {
    const installed = await this.orchestration.installPlan(goalId, planInput, fence);
    for (const node of installed.plan.nodes) await this.ensureInitialArtifacts(goalId, installed.revision, node, fence);
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
    await this.runtimeCoordinator.reconcileAttempts(goalId, fence);
    await this.queueReadyIntegrationPullRequests(goalId, fence);
    let processedOperations = await this.drainOutbox(goalId, fence);
    let goal = await this.goals.requireGoal(goalId);
    if (goal.state === 'cancelling') {
      await this.runtimeCoordinator.cancel(goalId, fence);
      return {
        reconciledArtifacts,
        processedOperations,
        dispatchedAttempts: 0,
        completionState: 'not_ready',
      };
    }
    if (goal.state === 'pausing') await this.runtimeCoordinator.pause(goalId, fence);
    goal = await this.goals.requireGoal(goalId);
    if (goal.requestedModel !== goal.effectiveModel && await this.orchestration.isModelChangeBoundary(goalId)) {
      await this.goals.applyModelChange(goalId, fence);
    }
    if (goal.state === 'running') await this.runtimeCoordinator.resume(goalId, fence);
    await this.runtimeCoordinator.drainMessages(goalId, fence);
    const dispatchedAttempts = ['planning', 'running', 'recovering'].includes(goal.state)
      ? await this.runtimeCoordinator.dispatchReadyWork(goalId, fence)
      : 0;

    let completionState: GoalControllerTickResult['completionState'] = 'not_ready';
    let becameTerminal = false;
    if (readinessPolicy) {
      await this.scheduleValidationAndUltrafix(goalId, readinessPolicy, fence);
      await this.orchestration.reconcileIntegrationEvidence(goalId, readinessPolicy, fence);
      await this.scheduleReadyMerges(goalId, readinessPolicy, fence);
      processedOperations += await this.drainOutbox(goalId, fence);
      await this.reconcile(goalId, fence);
      await this.orchestration.reconcileIntegrationEvidence(goalId, readinessPolicy, fence);
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
      idempotencyKey: `pr:${nodeId}:r${current!.revision}`, head: node.headBranch, base: node.baseBranch,
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
      goalId, this.options.controllerId, {
        limit: this.options.outboxBatchSize ?? 20,
        ttlMs: this.options.outboxClaimTtlMs,
      }, fence
    );
    let completed = 0;
    const stopRenewal = this.startOutboxBatchRenewal(operations, fence);
    try {
      for (const operation of operations) {
        try {
          await this.processOutboxOperation(goalId, operation, fence);
          completed += 1;
        } catch (error) {
          if (error instanceof GoalError && error.code === GOAL_ERROR_CODES.staleLease) throw error;
          if (await this.recoverOutboxFailure(operation, error, fence)) completed += 1;
        }
      }
    } finally {
      await stopRenewal();
    }
    return completed;
  }

  private async processOutboxOperation(
    goalId: string,
    operation: GoalClaimedOutboxOperation,
    fence: GoalLeaseFence
  ): Promise<void> {
    const marker = parseGoalArtifactMarker(operation.marker);
    await this.orchestration.assertFence(goalId, fence);
    const existing = await this.github.findByMarker(marker);
    const alreadyApplied = existing !== null && (
      operation.operationKind.startsWith('create_')
      || (operation.operationKind === 'merge_pull_request' && existing.state === 'merged')
    );
    if (alreadyApplied) {
      await this.orchestration.adoptGitHubArtifact(operation, existing, fence);
    } else {
      const result = await this.github.execute(operation, marker);
      await this.orchestration.assertFence(goalId, fence);
      if (!result && operation.operationKind.startsWith('create_')) throw new Error('GitHub create operation returned no artifact');
      if (result) await this.orchestration.adoptGitHubArtifact(operation, result, fence);
      else await this.orchestration.completeNoArtifactOperation(operation, fence);
    }
    if (operation.operationKind === 'merge_pull_request' && marker.base) {
      await this.orchestration.releaseBranchLock(goalId, marker.base, this.options.controllerId, fence);
    }
  }

  private async recoverOutboxFailure(
    operation: GoalClaimedOutboxOperation,
    failure: unknown,
    fence: GoalLeaseFence
  ): Promise<boolean> {
    try {
      const adopted = await this.github.findByMarker(parseGoalArtifactMarker(operation.marker));
      if (adopted) {
        await this.orchestration.adoptGitHubArtifact(operation, adopted, fence);
        return true;
      }
      await this.orchestration.retryGitHubOperation(operation, errorMessage(failure), fence);
      return false;
    } catch (error) {
      if (error instanceof GoalError && error.code === GOAL_ERROR_CODES.staleLease) throw error;
      await this.orchestration.retryGitHubOperation(operation, errorMessage(error), fence);
      return false;
    }
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

  private async queueIntegrationMerge(
    goalId: string,
    nodeId: string,
    policy: GoalReadinessPolicy,
    fence: GoalLeaseFence
  ): Promise<boolean> {
    const goal = await this.goals.requireGoal(goalId);
    if (goal.mergePolicy === 'manual' || policy.mergePolicy !== goal.mergePolicy) return false;
    const current = await this.orchestration.getCurrentPlan(goalId);
    const node = current?.plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Planned node not found', 404);
    const readiness = await this.orchestration.nodeReadiness(goalId, nodeId, policy);
    if (!readiness.ready) return false;
    const artifact = (await this.orchestration.getArtifacts(goalId)).find((candidate) =>
      candidate.nodeId === nodeId && candidate.kind === 'pull_request'
    );
    if (!artifact?.headSha || !artifact.baseSha || artifact.state !== 'present') return false;
    const locked = await this.orchestration.acquireBranchLock({
      goalId, nodeId, targetBranch: node.baseBranch,
      owner: this.options.controllerId, ttlMs: 5 * 60_000, fence,
    });
    if (!locked) return false;
    try {
      await this.orchestration.enqueueGitHubOperation({
        goalId, nodeId, artifactKind: 'pull_request', operationKind: 'merge_pull_request',
        idempotencyKey: `merge:${nodeId}:${artifact.headSha}:${policy.policyHash}`,
        head: node.headBranch, base: node.baseBranch,
        payload: {
          head: node.headBranch, base: node.baseBranch,
          expectedHeadSha: artifact.headSha, expectedBaseSha: artifact.baseSha,
          policyHash: policy.policyHash, method: goal.mergePolicy === 'auto_squash' ? 'squash' : 'merge',
        }, ...fence,
      });
      return true;
    } catch (error) {
      await this.orchestration.releaseBranchLock(goalId, node.baseBranch, this.options.controllerId, fence);
      throw error;
    }
  }

  private async ensureInitialArtifacts(
    goalId: string,
    revision: number,
    node: ValidatedGoalPlanNode,
    fence: GoalLeaseFence
  ): Promise<void> {
    const existingIssue = (await this.orchestration.getArtifacts(goalId)).find((artifact) =>
      artifact.nodeId === node.nodeId && artifact.kind === 'issue' && artifact.remoteId !== null
    );
    await this.orchestration.enqueueGitHubOperation({
      goalId, nodeId: node.nodeId, artifactKind: 'issue',
      operationKind: existingIssue ? 'update_issue' : 'create_issue',
      idempotencyKey: `issue:${node.nodeId}:r${revision}`, payload: {
        title: node.title,
        acceptanceCriteria: node.acceptanceCriteria,
        parentNodeId: node.parentNodeId,
        labels: ['propr-goal'],
        ...(existingIssue ? { number: existingIssue.number } : {}),
      },
      ...fence,
    });
    if (!node.noCode) {
      await this.orchestration.enqueueGitHubOperation({
        goalId, nodeId: node.nodeId, artifactKind: 'branch', operationKind: 'create_branch',
        idempotencyKey: `branch:${node.nodeId}:r${revision}`, head: node.headBranch, base: node.baseBranch,
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
      await this.orchestration.markAggregateRuntimeComplete(goalId, node.nodeId, fence);
      await this.orchestration.assertFence(goalId, fence);
      const hasDiff = await this.github.branchHasDiff(goal.repository, node.headBranch, node.baseBranch);
      await this.orchestration.assertFence(goalId, fence);
      await this.queueImplementationPullRequest(goalId, node.nodeId, hasDiff, fence);
    }
  }

  private async scheduleValidationAndUltrafix(
    goalId: string,
    policy: GoalReadinessPolicy,
    fence: GoalLeaseFence
  ): Promise<void> {
    if (!this.validation) return;
    const goal = await this.goals.requireGoal(goalId);
    const attempts = await this.orchestration.getAttempts(goalId);
    for (const artifact of (await this.orchestration.getArtifacts(goalId)).filter((candidate) =>
      candidate.kind === 'pull_request' && candidate.number && candidate.headSha && candidate.baseSha
      && ['present', 'merged'].includes(candidate.state)
    )) {
      const attempt = [...attempts].reverse().find((candidate) =>
        candidate.nodeId === artifact.nodeId && candidate.status === 'succeeded'
      );
      await this.validateArtifact({ goal, artifact, attempt, policy, fence });
    }
  }

  private async validateArtifact(input: {
    goal: Goal; artifact: GoalGitHubArtifact; attempt?: GoalAttempt;
    policy: GoalReadinessPolicy; fence: GoalLeaseFence;
  }): Promise<void> {
    const { goal, artifact, attempt, policy, fence } = input;
    const request = {
      goalId: goal.goalId, nodeId: artifact.nodeId, repository: goal.repository,
      pullRequestNumber: artifact.number!, headSha: artifact.headSha!, baseSha: artifact.baseSha!,
      policy, controllerFence: fence,
    };
    for (const evidence of await this.validation!.validate(request)) {
      await this.orchestration.recordEvidence(goal.goalId, artifact.nodeId, { ...evidence, ...fence });
    }
    if (!goal.ultrafixEnabled || !goal.ultrafixGoal || !goal.ultrafixMaxCycles || !this.validation!.runUltrafix) return;
    if (await this.orchestration.hasPassingUltrafix(goal.goalId, artifact.nodeId, {
      headSha: artifact.headSha!, baseSha: artifact.baseSha!, policy,
    })) return;
    const attemptId = attempt?.attemptId ?? null;
    if (!await this.orchestration.canStartUltrafix(goal.goalId, artifact.nodeId, attemptId)) return;
    const cycle = await this.orchestration.startUltrafixCycle({
      goalId: goal.goalId, nodeId: artifact.nodeId, attemptId, headSha: artifact.headSha!, fence,
    });
    const result = await this.validation!.runUltrafix({
      ...request, attemptId, cycle, threshold: goal.ultrafixGoal,
      maxCycles: goal.ultrafixMaxCycles, agent: goal.agent, model: attempt?.effectiveModel ?? goal.effectiveModel,
    });
    const passed = result.score >= goal.ultrafixGoal;
    await this.orchestration.finishUltrafixCycle({
      goalId: goal.goalId, nodeId: artifact.nodeId, cycle,
      result: { status: passed ? 'passed' : cycle >= goal.ultrafixMaxCycles ? 'exhausted' : 'failed', score: result.score },
      fence,
    });
    await this.orchestration.recordEvidence(goal.goalId, artifact.nodeId, {
      kind: 'ultrafix', headSha: result.headSha, baseSha: result.baseSha,
      policyHash: policy.policyHash, cycle, result: { ...(result.result ?? {}), score: result.score },
      status: passed ? 'passed' : 'failed', ...fence,
    });
  }

  private async scheduleReadyMerges(goalId: string, policy: GoalReadinessPolicy, fence: GoalLeaseFence): Promise<void> {
    const current = await this.orchestration.getCurrentPlan(goalId);
    if (!current) return;
    for (const node of [...current.plan.nodes].sort((left, right) => right.depth - left.depth)) {
      await this.queueIntegrationMerge(goalId, node.nodeId, policy, fence);
    }
  }

  private startOutboxBatchRenewal(
    operations: GoalClaimedOutboxOperation[],
    fence: GoalLeaseFence
  ): () => Promise<void> {
    const ttlMs = this.options.outboxClaimTtlMs ?? 60_000;
    let renewals = Promise.resolve();
    const timer = setInterval(() => {
      renewals = renewals.then(async () => {
        await this.orchestration.renewGitHubOperationClaims(operations, ttlMs, fence);
      }).catch(() => undefined);
    }, Math.max(5, Math.floor(ttlMs / 3)));
    return async () => {
      clearInterval(timer);
      await renewals;
    };
  }

}
