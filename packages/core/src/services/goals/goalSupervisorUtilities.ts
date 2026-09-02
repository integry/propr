import crypto from 'node:crypto';
import { GOAL_ERROR_CODES } from '@propr/shared';
import { GoalError, GoalRepository } from './goalRepository.js';
import type { GoalLeaseFence } from './goalTypes.js';
import type { GoalRuntimeAuthority } from './goalRuntimeTypes.js';

export function runtimeAuthority(
  repository: GoalRepository,
  goalId: string,
  fence: GoalLeaseFence,
  allowTerminal = false
): GoalRuntimeAuthority {
  return {
    controllerId: fence.leaseOwner,
    leaseGeneration: fence.leaseEpoch,
    assertCurrent: () => repository.assertLease(
      goalId, fence.leaseOwner, fence.leaseEpoch, { allowTerminal }
    ),
  };
}

export function isExpectedOwnershipEnd(error: unknown): boolean {
  const codes: readonly string[] = [
    GOAL_ERROR_CODES.leaseConflict,
    GOAL_ERROR_CODES.staleLease,
    GOAL_ERROR_CODES.terminalState,
  ];
  return error instanceof GoalError && codes.includes(error.code);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function durableGoalKey(scope: string, ...values: Array<string | number | undefined>): string {
  const hash = crypto.createHash('sha256');
  for (const value of values) hash.update(String(value)).update('\0');
  return `${scope}:${hash.digest('hex')}`;
}
