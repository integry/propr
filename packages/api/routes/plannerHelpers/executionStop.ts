import type { Knex } from 'knex';

/** A draft reset fences writes, but only background exit proves execution stopped.
 * Keep this run-specific evidence across draft edits/restarts and MCP replay.
 * This record contains no prompt, credentials or generated content.
 */
export async function recordPlannerStop(db: Knex, draftId: string, runId: string): Promise<void> {
  try {
    await db('mcp_records').insert({ kind: 'planner_stop', id: runId,
      value: JSON.stringify({ draftId, runId, stoppedAt: Date.now() }) })
      .onConflict(['kind', 'id']).ignore();
  } catch (error) {
    // Missing evidence must leave cancellation unconfirmed, never imply success.
    console.error('[planner] Could not persist execution stop', { draftId, runId, error });
  }
}
