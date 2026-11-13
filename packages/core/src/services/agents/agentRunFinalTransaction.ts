import type { Knex } from 'knex';
import { isTerminalAutomationRunState, type AutomationRunState } from '@propr/shared';
import type { AgentRunTransitionPatch } from './agentRunStore.js';

/**
 * Whether a transition can make the run's productivity verdict final: it
 * ends the run (a stored report's novelty then decides, unless an acting step
 * still owes its count), or it settles an acting step's mutation count.
 */
export function finalizesProductivity(to: AutomationRunState, patch: AgentRunTransitionPatch): boolean {
  return isTerminalAutomationRunState(to) || patch.actingMutations !== undefined || patch.actingMutationsPending !== undefined;
}

/**
 * Runs `write` in its own transaction when the transition can make the run's
 * verdict final (or in a savepoint of the caller's); a transition that cannot
 * is written as it is. SQLite opens the transaction holding its write lock
 * (`BEGIN IMMEDIATE`), as it opens the streak evaluation's pause transaction
 * (`pauseScheduleForUnproductiveStreak`), so the write either commits before
 * the evaluation reads the streak, and is seen, or waits until the pause is
 * committed: the evaluation never pauses a schedule on a streak that a
 * productive run had already ended.
 */
export async function inTransactionIfFinal<T>(
  database: Knex, { to, patch }: { to: AutomationRunState; patch: AgentRunTransitionPatch }, write: (trx: Knex) => Promise<T>,
): Promise<T> {
  if (!finalizesProductivity(to, patch)) return write(database);
  return database.transaction(trx => write(trx));
}
