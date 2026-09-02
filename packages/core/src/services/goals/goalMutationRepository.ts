import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES,
  GOAL_TERMINAL_REASONS,
  isTerminalGoalState,
  type GoalState,
  type GoalTerminalReason,
} from '@propr/shared';
import type {
  CancelIntentInput,
  Goal,
  GoalLeaseFence,
  GoalRecord,
  OperatorIntentInput,
  TransitionInput,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  goalTransaction,
  idempotencyKey,
  nowIso,
  optionalReason,
  readIdempotentReplay,
  requireGoalRecord,
  runIdempotent,
  toGoal,
  validateFence,
} from './goalRepositorySupport.js';
import {
  performGoalTransition,
  type GoalTransitionPolicy as TransitionPolicy,
} from './goalLifecycleTransition.js';

interface ModelChangeOptions {
  expectedVersion?: number;
  reason?: string;
  idempotencyKey?: string;
}

interface InternalTransitionInput {
  toState: GoalState;
  expectedVersion?: number;
  leaseOwner?: string;
  leaseEpoch?: number;
  reason?: string;
  terminalReason?: GoalTerminalReason;
  idempotencyKey?: string;
  idempotencyOperation?: string;
}

const PAUSE_SOURCE_STATES: readonly GoalState[] = [
  'queued', 'planning', 'running', 'recovering',
];
const RESUME_SOURCE_STATES: readonly GoalState[] = ['paused'];
const CANCEL_SOURCE_STATES: readonly GoalState[] = [
  'queued', 'planning', 'running', 'pausing', 'paused', 'recovering', 'completing',
];

export class GoalMutationRepository {
  constructor(private readonly db: Knex) {}

  async transition(goalId: string, input: TransitionInput): Promise<Goal> {
    return this.transitionInternal(goalId, normalizeTransition(input), {
      controllerAuthoritative: true,
    });
  }

  async requestPause(goalId: string, input: OperatorIntentInput = {}): Promise<Goal> {
    return this.transitionOperatorIntent(goalId, {
      toState: 'pausing',
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      idempotencyOperation: `pause:${goalId}`,
    }, PAUSE_SOURCE_STATES);
  }

  async requestResume(goalId: string, input: OperatorIntentInput = {}): Promise<Goal> {
    return this.transitionOperatorIntent(goalId, {
      toState: 'running',
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      idempotencyOperation: `resume:${goalId}`,
    }, RESUME_SOURCE_STATES);
  }

  async requestCancel(goalId: string, input: CancelIntentInput = {}): Promise<Goal> {
    return this.transitionOperatorIntent(goalId, {
      toState: 'cancelled',
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      terminalReason: input.terminalReason ?? 'user_cancelled',
      idempotencyKey: input.idempotencyKey,
      idempotencyOperation: `cancel:${goalId}`,
    }, CANCEL_SOURCE_STATES);
  }

  private transitionOperatorIntent(
    goalId: string,
    input: InternalTransitionInput,
    allowedSourceStates: readonly GoalState[]
  ): Promise<Goal> {
    return this.transitionInternal(
      goalId,
      normalizeTransition(input),
      { controllerAuthoritative: false, allowedSourceStates }
    );
  }

  private async transitionInternal(
    goalId: string,
    input: InternalTransitionInput,
    policy: TransitionPolicy
  ): Promise<Goal> {
    const initial = await requireGoalRecord(this.db, goalId);
    const operation = input.idempotencyOperation ?? `transition:${input.toState}:${goalId}`;
    const request = {
      toState: input.toState,
      expectedVersion: input.expectedVersion ?? null,
      reason: input.reason ?? null,
      terminalReason: input.terminalReason ?? null,
      leaseOwner: policy.controllerAuthoritative ? input.leaseOwner ?? null : null,
      leaseEpoch: policy.controllerAuthoritative ? input.leaseEpoch ?? null : null,
    };
    const effect = (trx: Knex.Transaction) => performGoalTransition(trx, goalId, input, policy);
    if (input.idempotencyKey === undefined) return goalTransaction(this.db, effect);
    return runIdempotent({
      db: this.db,
      ownerUserId: initial.owner_user_id,
      operation,
      key: input.idempotencyKey,
      request,
      goalId,
      effect,
    });
  }

  async requestModelChange(
    goalId: string,
    requestedModel: string,
    options: ModelChangeOptions = {}
  ): Promise<Goal> {
    const { model, normalized, request } = normalizeModelChange(requestedModel, options);
    const initial = await requireGoalRecord(this.db, goalId);
    const effect = (trx: Knex.Transaction) => this.performModelRequest(trx, goalId, model, normalized);
    if (normalized.idempotencyKey === undefined) return goalTransaction(this.db, effect);
    return runIdempotent({
      db: this.db,
      ownerUserId: initial.owner_user_id,
      operation: `model-change:${goalId}`,
      key: normalized.idempotencyKey,
      request,
      goalId,
      effect,
    });
  }

  async readModelChangeReplay(
    goalId: string,
    requestedModel: string,
    options: ModelChangeOptions = {}
  ): Promise<Goal | null> {
    const { normalized, request } = normalizeModelChange(requestedModel, options);
    if (normalized.idempotencyKey === undefined) return null;
    const initial = await requireGoalRecord(this.db, goalId);
    return readIdempotentReplay<Goal>(this.db, {
      ownerUserId: initial.owner_user_id,
      operation: `model-change:${goalId}`,
      key: normalized.idempotencyKey,
      request,
    });
  }

  private async performModelRequest(
    trx: Knex.Transaction,
    goalId: string,
    requestedModel: string,
    options: ModelChangeOptions
  ): Promise<Goal> {
    const goal = await requireGoalRecord(trx, goalId);
    if (isTerminalGoalState(goal.state)) {
      throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Requested model cannot change after the goal is terminal', 409);
    }
    if (options.expectedVersion !== undefined && options.expectedVersion !== goal.version) {
      throw new GoalError(GOAL_ERROR_CODES.versionConflict, `Goal version conflict: expected ${options.expectedVersion}, found ${goal.version}`, 409);
    }
    const now = nowIso();
    const hasOutcome = await trx.schema.hasColumn('goal_model_transitions', 'outcome');
    const affected = await trx('goals').where({ goal_id: goalId, version: goal.version }).update({
      requested_model: requestedModel,
      version: goal.version + 1,
      updated_at: now,
    });
    if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Goal changed concurrently', 409);
    if (hasOutcome) {
      await trx('goal_model_transitions').where({ goal_id: goalId, applied: 0, outcome: 'pending' }).update({
        outcome: 'superseded', superseded_at: now,
      });
    }
    await trx('goal_model_transitions').insert({
      goal_id: goalId, previous_model: goal.effective_model,
      requested_model: requestedModel, effective_model: goal.effective_model,
      applied: 0, reason: options.reason ?? null, created_at: now, applied_at: null,
      ...(hasOutcome ? { outcome: 'pending', superseded_at: null } : {}),
    });
    return toGoal(await requireGoalRecord(trx, goalId));
  }

  async applyModelChange(goalId: string, fence: GoalLeaseFence): Promise<Goal> {
    validateFence(fence);
    return goalTransaction(this.db, async (trx) => {
      const goal = await requireGoalRecord(trx, goalId);
      if (isTerminalGoalState(goal.state)) {
        throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Effective model cannot change after the goal is terminal', 409);
      }
      const transition = await trx('goal_model_transitions')
        .where('goal_id', goalId)
        .orderBy('id', 'desc')
        .first('id', 'requested_model', 'applied') as {
          id: number;
          requested_model: string;
          applied: number;
        } | undefined;
      if (goal.requested_model === goal.effective_model) {
        const current = await this.assertCurrentFence(trx, goal, fence);
        if (!transition || transition.requested_model !== goal.requested_model
          || Boolean(transition.applied)) return current;
        await this.markModelTransitionApplied(
          trx,
          {
            transitionId: transition.id,
            goalId,
            effectiveModel: goal.effective_model,
          }
        );
        return current;
      }
      if (!transition || transition.requested_model !== goal.requested_model
        || Boolean(transition.applied)) {
        throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Current model transition is missing', 409);
      }
      const now = nowIso();
      const affected = await trx('goals').where({
        goal_id: goalId,
        version: goal.version,
        lease_owner: fence.leaseOwner,
        lease_epoch: fence.leaseEpoch,
      }).whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now).update({
        effective_model: goal.requested_model,
        version: goal.version + 1,
        updated_at: now,
      });
      if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease is stale or expired', 409);
      await this.markModelTransitionApplied(
        trx,
        {
          transitionId: transition.id,
          goalId,
          effectiveModel: goal.requested_model,
          appliedAt: now,
        }
      );
      return toGoal(await requireGoalRecord(trx, goalId));
    });
  }

  private async markModelTransitionApplied(
    trx: Knex.Transaction,
    options: {
      transitionId: number;
      goalId: string;
      effectiveModel: string;
      appliedAt?: string;
    }
  ): Promise<void> {
    const hasOutcome = await trx.schema.hasColumn('goal_model_transitions', 'outcome');
    const audited = await trx('goal_model_transitions').where({
      id: options.transitionId,
      goal_id: options.goalId,
      applied: 0,
    }).update({
      effective_model: options.effectiveModel,
      applied: 1,
      applied_at: options.appliedAt ?? nowIso(),
      ...(hasOutcome ? { outcome: 'applied' } : {}),
    });
    if (audited !== 1) {
      throw new GoalError(
        GOAL_ERROR_CODES.versionConflict,
        'Model transition changed concurrently',
        409
      );
    }
  }

  private async assertCurrentFence(
    trx: Knex.Transaction,
    goal: GoalRecord,
    fence: GoalLeaseFence
  ): Promise<Goal> {
    const now = nowIso();
    const affected = await trx('goals').where({
      goal_id: goal.goal_id,
      version: goal.version,
      lease_owner: fence.leaseOwner,
      lease_epoch: fence.leaseEpoch,
    }).whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now)
      .update({ updated_at: trx.ref('updated_at') });
    if (affected !== 1) {
      throw new GoalError(
        GOAL_ERROR_CODES.staleLease,
        'Controller lease is stale or expired',
        409
      );
    }
    return toGoal(await requireGoalRecord(trx, goal.goal_id));
  }
}

function normalizeModelChange(requestedModel: string, options: ModelChangeOptions) {
  const model = boundedText(requestedModel, 'requestedModel') as string;
  const normalized: ModelChangeOptions = {
    expectedVersion: validateVersion(options.expectedVersion),
    reason: optionalReason(options.reason),
    idempotencyKey: options.idempotencyKey === undefined ? undefined : idempotencyKey(options.idempotencyKey),
  };
  return {
    model,
    normalized,
    request: {
      requestedModel: model,
      expectedVersion: normalized.expectedVersion ?? null,
      reason: normalized.reason ?? null,
    },
  };
}

function normalizeTransition(input: InternalTransitionInput): InternalTransitionInput {
  if (input.terminalReason !== undefined && !GOAL_TERMINAL_REASONS.includes(input.terminalReason)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'terminalReason is invalid', 400);
  }
  return {
    ...input,
    expectedVersion: validateVersion(input.expectedVersion),
    reason: optionalReason(input.reason),
    idempotencyKey: input.idempotencyKey === undefined ? undefined : idempotencyKey(input.idempotencyKey),
    idempotencyOperation: input.idempotencyOperation === undefined
      ? undefined
      : boundedText(input.idempotencyOperation, 'idempotencyOperation') as string,
    leaseOwner: input.leaseOwner === undefined ? undefined : boundedText(input.leaseOwner, 'leaseOwner') as string,
  };
}

function validateVersion(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'expectedVersion must be a positive safe integer', 400);
  }
  return value;
}
