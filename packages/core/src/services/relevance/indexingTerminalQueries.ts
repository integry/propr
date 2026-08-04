import { db } from '../../db/connection.js';

export interface RepositoryIndexingTerminalTransition {
  runId: string;
  transitionAt: string;
  status: 'idle' | 'completed' | 'failed';
}

/** Reads a run's accepted terminal result independently of current branch ownership. */
export async function getRepositoryIndexingTerminalTransition(
  fullName: string,
  branch: string,
  runId: string,
  database: typeof db = db
): Promise<RepositoryIndexingTerminalTransition | undefined> {
  if (!await database.schema.hasTable('repository_indexing_transitions')) return undefined;
  const row = await database('repository_indexing_transitions')
    .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
    .where({ branch, run_id: runId })
    .whereIn('status', ['idle', 'completed', 'failed'])
    .orderBy('transition_id', 'asc')
    .first('status', 'transition_at') as {
      status?: 'idle' | 'completed' | 'failed';
      transition_at?: string;
    } | undefined;
  return row?.status && row.transition_at
    ? { runId, status: row.status, transitionAt: row.transition_at }
    : undefined;
}
