import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES,
  GOAL_TERMINAL_REASONS,
  isTerminalGoalState,
  isValidGoalTransition,
} from '@propr/shared';
import type {
  Goal,
  GoalLeaseFence,
  GoalRecord,
  TransitionInput,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  goalTransaction,
  idempotencyKey,
  nowIso,
  optionalReason,
  requireGoalRecord,
  runIdempotent,
  toGoal,
  validateFence,
} from './goalRepositorySupport.js';

interface ModelChangeOptions {
  expectedVersion?: number;
  reason?: string;
  idempotencyKey?: string;
}

export class GoalMutationRepository {
  constructor(private readonly db: Knex) {}

  async transition(goalId: string, input: TransitionInput): Promise<Goal> {
    return this.transitionInternal(goalId, normalizeTransition(input), true);
  }

  async transitionOperatorIntent(goalId: string, input: TransitionInput): Promise<Goal> {
    if (input.leaseOwner !== undefined || input.leaseEpoch !== undefined) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Operator intents must not include a lease fence', 400);
    }
    return this.transitionInternal(goalId, normalizeTransition(input), false);
  }

  private async transitionInternal(
    goalId: string,
    input: TransitionInput,
    controllerAuthoritative: boolean
  ): Promise<Goal> {
    const initial = await requireGoalRecord(this.db, goalId);
    const operation = input.idempotencyOperation ?? `transition:${input.toState}:${goalId}`;
    const request = {
      toState: input.toState,
      expectedVersion: input.expectedVersion ?? null,
      reason: input.reason ?? null,
      terminalReason: input.terminalReason ?? null,
      leaseOwner: controllerAuthoritative ? input.leaseOwner ?? null : null,
      leaseEpoch: controllerAuthoritative ? input.leaseEpoch ?? null : null,
    };
    const effect = (trx: Knex.Transaction) => this.performTransition(trx, goalId, input, controllerAuthoritative);
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

  private async performTransition(
    trx: Knex.Transaction,
    goalId: string,
    input: TransitionInput,
    controllerAuthoritative: boolean
  ): Promise<Goal> {
    const goal = await requireGoalRecord(trx, goalId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== goal.version) {
      throw new GoalError(GOAL_ERROR_CODES.versionConflict, `Goal version conflict: expected ${input.expectedVersion}, found ${goal.version}`, 409);
    }
    if (!isValidGoalTransition(goal.state, input.toState)) {
      throw new GoalError(GOAL_ERROR_CODES.invalidTransition, `Invalid transition from ${goal.state} to ${input.toState}`, 409);
    }
    if (isTerminalGoalState(input.toState) && input.terminalReason == null) {
      throw new GoalError(GOAL_ERROR_CODES.validation, `A terminal reason is required to enter ${input.toState}`, 400);
    }
    const now = nowIso();
    let update = trx('goals').where({ goal_id: goalId, version: goal.version });
    if (controllerAuthoritative) {
      const fence = { leaseOwner: input.leaseOwner!, leaseEpoch: input.leaseEpoch! };
      validateFence(fence);
      update = update.where({ lease_owner: fence.leaseOwner, lease_epoch: fence.leaseEpoch })
        .whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now);
    }
    const affected = await update.update({
      state: input.toState,
      version: goal.version + 1,
      terminal_reason: isTerminalGoalState(input.toState) ? input.terminalReason ?? null : goal.terminal_reason,
      updated_at: now,
    });
    if (affected !== 1) {
      throw new GoalError(
        controllerAuthoritative ? GOAL_ERROR_CODES.staleLease : GOAL_ERROR_CODES.versionConflict,
        controllerAuthoritative ? 'Controller lease is stale or expired' : 'Goal changed concurrently',
        409
      );
    }
    await trx('goal_state_transitions').insert({
      goal_id: goalId, from_state: goal.state, to_state: input.toState,
      reason: input.reason ?? null, lease_epoch: input.leaseEpoch ?? goal.lease_epoch,
      created_at: now,
    });
    if (input.toState === 'paused') {
      await trx('goal_pause_intervals').insert({ goal_id: goalId, paused_at: now, reason: input.reason ?? null });
    } else if (goal.state === 'paused') {
      await trx('goal_pause_intervals').where({ goal_id: goalId }).whereNull('resumed_at').update({ resumed_at: now });
    }
    return toGoal(await requireGoalRecord(trx, goalId));
  }

  async requestModelChange(
    goalId: string,
    requestedModel: string,
    options: ModelChangeOptions = {}
  ): Promise<Goal> {
    const model = boundedText(requestedModel, 'requestedModel') as string;
    const normalized = {
      expectedVersion: validateVersion(options.expectedVersion),
      reason: optionalReason(options.reason),
      idempotencyKey: options.idempotencyKey === undefined ? undefined : idempotencyKey(options.idempotencyKey),
    };
    const initial = await requireGoalRecord(this.db, goalId);
    const request = { requestedModel: model, expectedVersion: normalized.expectedVersion ?? null, reason: normalized.reason ?? null };
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
    const affected = await trx('goals').where({ goal_id: goalId, version: goal.version }).update({
      requested_model: requestedModel,
      version: goal.version + 1,
      updated_at: now,
    });
    if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Goal changed concurrently', 409);
    await trx('goal_model_transitions').insert({
      goal_id: goalId, previous_model: goal.effective_model,
      requested_model: requestedModel, effective_model: goal.effective_model,
      applied: 0, reason: options.reason ?? null, created_at: now, applied_at: null,
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
    const audited = await trx('goal_model_transitions').where({
      id: options.transitionId,
      goal_id: options.goalId,
      applied: 0,
    }).update({
      effective_model: options.effectiveModel,
      applied: 1,
      applied_at: options.appliedAt ?? nowIso(),
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

function normalizeTransition(input: TransitionInput): TransitionInput {
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
