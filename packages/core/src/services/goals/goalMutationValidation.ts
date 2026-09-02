import {
  GOAL_ERROR_CODES,
  GOAL_TERMINAL_REASONS,
  type GoalState,
  type GoalTerminalReason,
} from '@propr/shared';
import {
  GoalError,
  boundedText,
  idempotencyKey,
  optionalReason,
} from './goalRepositorySupport.js';

export interface ModelChangeOptions {
  expectedVersion?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface InternalTransitionInput {
  toState: GoalState;
  expectedVersion?: number;
  leaseOwner?: string;
  leaseEpoch?: number;
  reason?: string;
  terminalReason?: GoalTerminalReason;
  idempotencyKey?: string;
  idempotencyOperation?: string;
}

export function normalizeModelChange(
  requestedModel: string,
  options: ModelChangeOptions
) {
  const model = boundedText(requestedModel, 'requestedModel') as string;
  const normalized: ModelChangeOptions = {
    expectedVersion: validateVersion(options.expectedVersion),
    reason: optionalReason(options.reason),
    idempotencyKey: options.idempotencyKey === undefined
      ? undefined
      : idempotencyKey(options.idempotencyKey),
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

export function normalizeTransition(
  input: InternalTransitionInput
): InternalTransitionInput {
  if (input.terminalReason !== undefined
      && !GOAL_TERMINAL_REASONS.includes(input.terminalReason)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'terminalReason is invalid', 400);
  }
  return {
    ...input,
    expectedVersion: validateVersion(input.expectedVersion),
    reason: optionalReason(input.reason),
    idempotencyKey: input.idempotencyKey === undefined
      ? undefined
      : idempotencyKey(input.idempotencyKey),
    idempotencyOperation: input.idempotencyOperation === undefined
      ? undefined
      : boundedText(input.idempotencyOperation, 'idempotencyOperation') as string,
    leaseOwner: input.leaseOwner === undefined
      ? undefined
      : boundedText(input.leaseOwner, 'leaseOwner') as string,
  };
}

function validateVersion(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      'expectedVersion must be a positive safe integer',
      400
    );
  }
  return value;
}
