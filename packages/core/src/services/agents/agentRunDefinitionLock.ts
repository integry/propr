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
 * Locks the run's definition row for the rest of `trx`, the lock a streak
 * evaluation holds while it reads the definition's runs and pauses its
 * schedule (`pauseScheduleForUnproductiveStreak`). A write that makes a run's
 * verdict final takes it first, so the write either commits before the
 * evaluation reads the streak, and is seen, or waits until the pause is
 * committed: the evaluation never pauses a schedule on a streak that a
 * productive run committed before it had already ended. Locking the
 * `agent_runs` row alone would not do: the evaluation reads runs without
 * locking them. Postgres locks the row; SQLite ignores FOR UPDATE and opens
 * every transaction holding its single write lock, which serializes the same way.
 */
export async function lockAgentRunDefinition(trx: Knex, runId: string): Promise<void> {
  await trx('agent_definitions').whereIn('id', trx('agent_runs').select('definition_id').where({ id: runId })).forUpdate().first('id');
}

/**
 * Runs `write` under the run's definition lock when the transition can make
 * the run's verdict final (in its own transaction, or a savepoint of the
 * caller's); a transition that cannot is written as it is.
 */
export async function underDefinitionLockIfFinal<T>(
  database: Knex, runId: string, { to, patch }: { to: AutomationRunState; patch: AgentRunTransitionPatch }, write: (trx: Knex) => Promise<T>,
): Promise<T> {
  if (!finalizesProductivity(to, patch)) return write(database);
  return database.transaction(async trx => {
    await lockAgentRunDefinition(trx, runId);
    return write(trx);
  });
}
