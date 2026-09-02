import { GOAL_ERROR_CODES } from '@propr/shared';
import type { CancelIntentInput } from './goalTypes.js';
import {
  GoalError,
  idempotencyKey,
  optionalReason,
} from './goalRepositorySupport.js';

export function normalizeCancellationIntent(input: CancelIntentInput) {
  const terminalReason = input.terminalReason ?? 'user_cancelled';
  if (terminalReason !== 'user_cancelled') {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      'Operator cancellation must use user_cancelled',
      400
    );
  }
  return {
    expectedVersion: validateCancellationVersion(input.expectedVersion),
    reason: optionalReason(input.reason),
    terminalReason,
    idempotencyKey: input.idempotencyKey === undefined
      ? undefined
      : idempotencyKey(input.idempotencyKey),
  } as const;
}

function validateCancellationVersion(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      'expectedVersion must be a positive safe integer',
      400
    );
  }
  return value;
}
