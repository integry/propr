import { GOAL_ERROR_CODES } from '@propr/shared';
import { GoalArtifactRepository } from './goalArtifactRepository.js';
import { GoalExecutionRepository } from './goalExecutionRepository.js';
import { GoalRepository, GoalError } from './goalRepository.js';
import { GoalRuntimeControlRepository } from './goalRuntimeControlRepository.js';
import type { Goal, GoalLeaseFence } from './goalTypes.js';
import type {
  GoalReportedArtifact,
  GoalRuntimeCallbacks,
  GoalRuntimeEvent,
  GoalRuntimeExecution,
} from './goalRuntimeTypes.js';
import { durableGoalKey } from './goalSupervisorUtilities.js';

export class GoalSupervisorObservations {
  constructor(
    private readonly repository: GoalRepository,
    private readonly executions: GoalExecutionRepository,
    private readonly artifacts: GoalArtifactRepository,
    private readonly controls: GoalRuntimeControlRepository
  ) {}

  callbacks(
    goal: Goal,
    initialExecution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    setExecution: (execution: GoalRuntimeExecution) => void
  ): GoalRuntimeCallbacks {
    return {
      onSessionIdentity: async identity => {
        const updated = await this.persistIdentity(goal, initialExecution, identity, fence);
        setExecution(updated);
        const current = await this.repository.requireGoal(goal.goalId);
        if (current.state === 'planning' || current.state === 'recovering') {
          await this.repository.transition(goal.goalId, {
            toState: 'running', ...fence, reason: 'provider_session_identity_persisted',
            idempotencyKey: durableGoalKey(
              'running', initialExecution.executionId, fence.leaseEpoch
            ),
          });
        }
      },
      onEvent: async event => {
        await this.recordNativeEvent(goal.goalId, initialExecution.executionId, event, fence);
        await this.controls.projectEvent({
          goalId: goal.goalId, executionId: initialExecution.executionId, event, fence,
        });
      },
      onArtifact: artifact => this.recordArtifact(
        goal.goalId, initialExecution.executionId, artifact, fence
      ),
    };
  }

  async persistIdentity(
    goal: Goal,
    execution: GoalRuntimeExecution,
    identity: Parameters<GoalRuntimeCallbacks['onSessionIdentity']>[0],
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    const updated = await this.executions.persistSessionIdentity(
      goal.goalId, execution.executionId, identity, fence
    );
    await this.repository.upsertProviderSession(goal.goalId, goal.agent, {
      ...fence,
      providerThreadId: identity.providerThreadId,
      runtimeId: identity.runtimeId,
      worktreeId: identity.worktreeId,
      effectiveModel: updated.effectiveModel,
      recoveryMetadata: { schemaVersion: 1, providerState: 'active' },
    });
    await this.repository.appendEvent(goal.goalId, {
      ...fence,
      kind: 'lifecycle', eventType: 'provider.session.persisted',
      payload: {
        executionId: execution.executionId,
        providerSessionId: identity.providerSessionId,
        providerThreadId: identity.providerThreadId,
        worktreeId: identity.worktreeId,
      },
      idempotencyKey: durableGoalKey(
        'session', execution.executionId, identity.providerSessionId
      ),
    });
    return updated;
  }

  private async recordNativeEvent(
    goalId: string,
    executionId: string,
    event: GoalRuntimeEvent,
    fence: GoalLeaseFence
  ): Promise<void> {
    const execution = await this.requireIdentifiedExecution(goalId, 'Native events');
    await this.repository.appendEvent(goalId, {
      ...fence,
      kind: event.kind, eventType: event.eventType,
      ...(event.payload === undefined ? {} : { payload: event.payload }),
      idempotencyKey: durableGoalKey('native-event', executionId, event.eventId),
    });
    if (event.checkpoint === undefined && event.nativeSequence === undefined) return;
    await this.executions.updateState({
      goalId, executionId, state: execution.state, fence,
      fields: { checkpoint: event.checkpoint, nativeSequence: event.nativeSequence },
    });
    if (event.checkpoint !== undefined) {
      await this.repository.upsertProviderSession(goalId, execution.agent, {
        ...fence,
        lastCheckpoint: event.checkpoint,
        recoveryMetadata: {
          schemaVersion: 1, providerState: 'active', lastEventSequence: event.nativeSequence,
        },
      });
    }
  }

  private async recordArtifact(
    goalId: string,
    executionId: string,
    artifact: GoalReportedArtifact,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.requireIdentifiedExecution(goalId, 'Reported artifacts');
    await this.artifacts.record({ goalId, executionId, artifact, fence });
    await this.repository.appendEvent(goalId, {
      ...fence,
      kind: 'domain',
      eventType: artifact.finalEpicPullRequest ? 'native.final_epic_pr' : 'native.artifact',
      payload: artifact,
      idempotencyKey: durableGoalKey(
        'artifact', executionId, artifact.artifactKey,
        JSON.stringify({ state: artifact.state, draft: artifact.draft, headSha: artifact.headSha })
      ),
    });
  }

  private async requireIdentifiedExecution(
    goalId: string,
    subject: string
  ): Promise<GoalRuntimeExecution> {
    const execution = await this.executions.get(goalId);
    if (!execution?.providerThreadId) throw new GoalError(
      GOAL_ERROR_CODES.recoveryMetadataInvalid,
      `${subject} cannot precede durable provider session identity`,
      409
    );
    return execution;
  }
}
