import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES, isTerminalGoalState, isValidGoalTransition,
  type GoalState, type GoalTerminalReason,
} from '@propr/shared';
import type { Goal, GoalRecord } from './goalTypes.js';
import {
  GoalError, nowIso, requireGoalRecord, toGoal, validateFence,
} from './goalRepositorySupport.js';
import { appendControlEvent, lifecycleControlIdentity } from './goalEventWriter.js';

export interface GoalTransitionSpec {
  toState: GoalState;
  expectedVersion?: number;
  leaseOwner?: string;
  leaseEpoch?: number;
  reason?: string;
  terminalReason?: GoalTerminalReason;
}

export interface GoalTransitionPolicy {
  controllerAuthoritative: boolean;
  allowedSourceStates?: readonly GoalState[];
}

export async function performGoalTransition(
  trx: Knex.Transaction,
  goalId: string,
  input: GoalTransitionSpec,
  policy: GoalTransitionPolicy
): Promise<Goal> {
  const goal = await requireGoalRecord(trx, goalId);
  validateTransition(goal, input, policy);
  const now = nowIso();
  const context = { goal, input, policy, now };
  const affected = await transitionUpdate(trx, context);
  if (affected !== 1) {
    throw new GoalError(
      policy.controllerAuthoritative ? GOAL_ERROR_CODES.staleLease : GOAL_ERROR_CODES.versionConflict,
      policy.controllerAuthoritative ? 'Controller lease is stale or expired' : 'Goal changed concurrently',
      409
    );
  }
  await trx('goal_state_transitions').insert({
    goal_id: goalId, from_state: goal.state, to_state: input.toState,
    reason: input.reason ?? null, lease_epoch: input.leaseEpoch ?? goal.lease_epoch,
    created_at: now,
  });
  await appendLifecycleEvent(trx, context);
  await updatePauseIntervals(trx, goal, input, now);
  return toGoal(await requireGoalRecord(trx, goalId));
}

function validateTransition(
  goal: GoalRecord,
  input: GoalTransitionSpec,
  policy: GoalTransitionPolicy
): void {
  if (input.expectedVersion !== undefined && input.expectedVersion !== goal.version) {
    throw new GoalError(GOAL_ERROR_CODES.versionConflict, `Goal version conflict: expected ${input.expectedVersion}, found ${goal.version}`, 409);
  }
  if (policy.allowedSourceStates && !policy.allowedSourceStates.includes(goal.state)
    || !isValidGoalTransition(goal.state, input.toState)) {
    throw new GoalError(GOAL_ERROR_CODES.invalidTransition, `Invalid transition from ${goal.state} to ${input.toState}`, 409);
  }
  if (isTerminalGoalState(input.toState) && input.terminalReason == null) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `A terminal reason is required to enter ${input.toState}`, 400);
  }
}

function transitionUpdate(
  trx: Knex.Transaction,
  context: {
    goal: GoalRecord; input: GoalTransitionSpec; policy: GoalTransitionPolicy; now: string;
  }
) {
  const { goal, input, policy, now } = context;
  let update = trx('goals').where({ goal_id: goal.goal_id, version: goal.version });
  if (policy.controllerAuthoritative) {
    const fence = { leaseOwner: input.leaseOwner!, leaseEpoch: input.leaseEpoch! };
    validateFence(fence);
    update = update.where({ lease_owner: fence.leaseOwner, lease_epoch: fence.leaseEpoch })
      .whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now);
  }
  return update.update({
    state: input.toState, version: goal.version + 1,
    terminal_reason: isTerminalGoalState(input.toState) ? input.terminalReason ?? null : goal.terminal_reason,
    updated_at: now,
  });
}

async function appendLifecycleEvent(
  trx: Knex.Transaction,
  context: {
    goal: GoalRecord; input: GoalTransitionSpec; policy: GoalTransitionPolicy; now: string;
  }
): Promise<void> {
  const { goal, input, policy, now } = context;
  if (!await trx.schema.hasTable('goal_event_state')) return;
  const version = goal.version + 1;
  const actor = policy.controllerAuthoritative ? input.leaseOwner! : 'operator';
  await appendControlEvent(trx, goal, {
    type: 'lifecycle.state_changed',
    namespace: 'lifecycle',
    payload: {
      from: goal.state, to: input.toState,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
    },
    idempotencyKey: `lifecycle:${goal.goal_id}:${version}`,
    identity: lifecycleControlIdentity(
      goal.goal_id, version, input.leaseEpoch ?? goal.lease_epoch, actor
    ),
    createdAt: now,
  });
}

async function updatePauseIntervals(
  trx: Knex.Transaction,
  goal: GoalRecord,
  input: GoalTransitionSpec,
  now: string
): Promise<void> {
  if (input.toState === 'paused') {
    await trx('goal_pause_intervals').insert({
      goal_id: goal.goal_id, paused_at: now, reason: input.reason ?? null,
    });
  } else if (goal.state === 'paused') {
    await trx('goal_pause_intervals').where({ goal_id: goal.goal_id })
      .whereNull('resumed_at').update({ resumed_at: now });
  }
}
