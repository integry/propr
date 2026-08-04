import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db/connection.js';

// Inline type definitions to avoid circular dependency with summaryMiner.ts
interface FileSummaryResult {
  path: string;
  summary: string;
  commit_hash: string;
  model_used: string | null;
  last_updated_at: Date;
}

interface DirectorySummaryResult {
  path: string;
  summary: string;
  hash: string;
  last_updated_at: Date;
}

export const INDEXING_FAILED_JOB_RETENTION = { age: 7 * 24 * 60 * 60, count: 1_000 } as const;

export interface IndexingRunIdentity {
  runId: string;
  transitionAt: string;
}

export interface UpdateRepositoryStatusOptions extends Partial<IndexingRunIdentity> {
  startNewRun?: boolean;
  commitInfo?: { hash?: string; message?: string; iconPath?: string | null };
  /** Optional database boundary for atomic callers and isolated tests. */
  database?: typeof db;
}

export interface RepositoryStatusTransition extends IndexingRunIdentity {
  applied: boolean;
}

export interface ActiveRepositoryIndexingRun extends IndexingRunIdentity {
  fullName: string;
  branch: string;
}

export function createIndexingRunIdentity(now: Date = new Date()): IndexingRunIdentity {
  return { runId: randomUUID(), transitionAt: now.toISOString() };
}

/** BullMQ's atomic repository/branch deduplication key for live indexing work. */
export function createIndexingQueueDeduplicationId(fullName: string, branch: string = 'HEAD'): string {
  const digest = createHash('sha256')
    .update(`${fullName.trim().toLowerCase()}\0${branch}`)
    .digest('hex');
  return `index-repository-${digest}`;
}

/** A run-scoped job ID lets Queue.add() report whether deduplication accepted this run. */
export function createIndexingQueueJobId(
  fullName: string,
  branch: string = 'HEAD',
  runId?: string
): string {
  const deduplicationId = createIndexingQueueDeduplicationId(fullName, branch);
  return runId ? `${deduplicationId}-${runId}` : deduplicationId;
}

/**
 * Updates the repository indexing status
 */
export async function updateRepositoryStatus(
  fullName: string,
  status: 'idle' | 'indexing' | 'completed' | 'failed',
  branch: string = 'HEAD',
  options: UpdateRepositoryStatusOptions = {}
): Promise<RepositoryStatusTransition> {
  const database = options.database ?? db;
  return database.transaction(
    // eslint-disable-next-line complexity -- run ownership and ordering form one atomic decision
    async (transaction) => {
    const existing = await transaction('repositories')
      .select('full_name', 'indexing_status', 'indexing_transition_at', 'indexing_run_id')
      .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
      .where({ branch })
      .forUpdate()
      .first() as {
        full_name?: string;
        indexing_status?: string;
        indexing_transition_at?: string | null;
        indexing_run_id?: string | null;
      } | undefined;
    const now = new Date().toISOString();
    const requestedRunId = options.runId;
    const replacingRun = status === 'indexing' && options.startNewRun === true;
    if (requestedRunId) {
      const alreadyTerminal = await transaction('repository_indexing_transitions')
        .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
        .where({ branch, run_id: requestedRunId })
        .whereIn('status', ['idle', 'completed', 'failed'])
        .first('status', 'transition_at') as {
          status?: 'idle' | 'completed' | 'failed';
          transition_at?: string;
      } | undefined;
      if (alreadyTerminal) {
        const sameTerminal = status !== 'indexing' && alreadyTerminal.status === status;
        if (existing && alreadyTerminal.status && existing.indexing_status !== alreadyTerminal.status
            && existing.indexing_run_id === requestedRunId) {
          await transaction('repositories')
            .where({
              full_name: existing.full_name,
              branch,
              indexing_status: existing.indexing_status,
              indexing_run_id: requestedRunId
            })
            .update({
              indexing_status: alreadyTerminal.status,
              indexing_transition_at: alreadyTerminal.transition_at,
              updated_at: now
            });
        }
        return {
          runId: requestedRunId,
          transitionAt: alreadyTerminal.transition_at ?? options.transitionAt ?? now,
          applied: sameTerminal
        };
      }
    }
    if (status !== 'indexing' && existing?.indexing_status
      && existing.indexing_status !== 'indexing'
      && existing.indexing_status !== status) {
      return {
        runId: requestedRunId ?? existing.indexing_run_id ?? randomUUID(),
        transitionAt: options.transitionAt ?? existing.indexing_transition_at ?? now,
        applied: false
      };
    }
    if (requestedRunId && status !== 'indexing'
      && existing?.indexing_status === 'indexing'
      && !existing.indexing_run_id) {
      // A run-scoped queued cancellation cannot claim an active legacy row
      // whose owner is unknown. Record that queued run in history instead.
      return {
        runId: requestedRunId,
        transitionAt: options.transitionAt ?? now,
        applied: false
      };
    }
    if (
      existing?.indexing_run_id
      && requestedRunId
      && existing.indexing_run_id !== requestedRunId
      && !replacingRun
    ) {
      return {
        runId: requestedRunId,
        transitionAt: options.transitionAt ?? now,
        applied: false
      };
    }

    if (requestedRunId && existing?.indexing_run_id === requestedRunId) {
      if (existing.indexing_status === status) {
        return {
          runId: requestedRunId,
          transitionAt: existing.indexing_transition_at ?? options.transitionAt ?? now,
          applied: true
        };
      }
      // Every run has one terminal result. In particular, an idle cancellation
      // must not be overwritten by late completion or failure callbacks.
      if (existing.indexing_status !== 'indexing') {
        return {
          runId: requestedRunId,
          transitionAt: options.transitionAt ?? now,
          applied: false
        };
      }
    }

    if (requestedRunId && status !== 'indexing' && !existing) {
      return {
        runId: requestedRunId,
        transitionAt: options.transitionAt ?? now,
        applied: false
      };
    }

    const statusChanged = existing?.indexing_status !== status;
    const storedFullName = existing?.full_name ?? fullName;
    const runId = requestedRunId ?? (
      status === 'indexing' && (replacingRun || statusChanged) || !existing?.indexing_run_id
        ? randomUUID()
        : existing.indexing_run_id
    );
    const runChanged = existing?.indexing_run_id !== runId;
    let transitionAt = runChanged
      // Cross-run ownership follows serialized database acceptance, never a
      // producer host's wall clock. The request timestamp remains queue data
      // until the database returns this authoritative transition identity.
      ? now
      : statusChanged
        ? now
        : existing?.indexing_transition_at ?? options.transitionAt ?? now;
    if (runChanged && existing?.indexing_transition_at && transitionAt <= existing.indexing_transition_at) {
      transitionAt = new Date(Date.parse(existing.indexing_transition_at) + 1).toISOString();
    }
    const lastIndexedHash = options.commitInfo?.hash;
    const lastIndexedCommitMessage = options.commitInfo?.message;
    const iconPath = options.commitInfo?.iconPath;
    const updateData: Record<string, unknown> = {
      indexing_status: status,
      indexing_transition_at: transitionAt,
      indexing_run_id: runId,
      updated_at: now
    };

    if (status === 'completed') {
      updateData.last_indexed_at = now;
      if (lastIndexedHash) {
        updateData.last_indexed_hash = lastIndexedHash;
      }
      if (lastIndexedCommitMessage) {
        updateData.last_indexed_commit_message = lastIndexedCommitMessage;
      }
      if (iconPath !== undefined) {
        updateData.icon_path = iconPath;
      }
    }

    await transaction('repositories')
      .insert({
        full_name: storedFullName,
        branch,
        indexing_status: status,
        indexing_transition_at: transitionAt,
        indexing_run_id: runId,
        created_at: now,
        updated_at: now,
        last_indexed_hash: lastIndexedHash || null,
        last_indexed_commit_message: lastIndexedCommitMessage || null,
        icon_path: iconPath || null,
        ...(status === 'completed' ? { last_indexed_at: now } : {})
      })
      .onConflict(['full_name', 'branch'])
      .merge(updateData);
    await transaction('repository_indexing_transitions')
      .insert({
        full_name: storedFullName,
        branch,
        run_id: runId,
        status,
        transition_at: transitionAt,
        observed_at: now
      })
      .onConflict(['full_name', 'branch', 'run_id', 'status', 'transition_at'])
      .ignore();
    return { transitionAt, runId, applied: true };
    }
  );
}

/**
 * Records a queued run's cancellation without replacing another run's current
 * repository status. Reconciliation can therefore recover the run-scoped
 * terminal projection without treating a rejected ownership transition as
 * authoritative.
 */
export async function recordSkippedIndexingRun(
  fullName: string,
  branch: string,
  indexingRun: IndexingRunIdentity,
  database: typeof db = db
): Promise<RepositoryStatusTransition> {
  return database.transaction(async (transaction) => {
    const repository = await transaction('repositories')
      .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
      .where({ branch })
      .forUpdate()
      .first(
        'full_name', 'indexing_status', 'indexing_transition_at', 'indexing_run_id'
      ) as {
        full_name?: string;
        indexing_status?: string;
        indexing_transition_at?: string | null;
        indexing_run_id?: string | null;
      } | undefined;
    const existingTerminal = await transaction('repository_indexing_transitions')
      .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
      .where({ branch, run_id: indexingRun.runId })
      .whereIn('status', ['idle', 'completed', 'failed'])
      .orderBy('transition_id', 'asc')
      .first('status', 'transition_at') as {
        status?: 'idle' | 'completed' | 'failed';
        transition_at?: string;
      } | undefined;
    if (existingTerminal?.transition_at) {
      return {
        runId: indexingRun.runId,
        transitionAt: existingTerminal.transition_at,
        applied: existingTerminal.status === 'idle'
      };
    }
    let transitionAt = new Date().toISOString();
    if (repository?.indexing_run_id === indexingRun.runId
        && repository.indexing_transition_at
        && transitionAt <= repository.indexing_transition_at) {
      transitionAt = new Date(Date.parse(repository.indexing_transition_at) + 1).toISOString();
    }
    const storedFullName = repository?.full_name ?? fullName;
    if (!repository) {
      await transaction('repositories').insert({
        full_name: storedFullName,
        branch,
        indexing_status: 'idle',
        indexing_transition_at: transitionAt,
        indexing_run_id: indexingRun.runId,
        created_at: transitionAt,
        updated_at: transitionAt,
        last_indexed_hash: null,
        last_indexed_commit_message: null,
        icon_path: null
      });
    } else if (repository.indexing_status === 'indexing'
        && repository.indexing_run_id === indexingRun.runId) {
      await transaction('repositories')
        .where({ full_name: storedFullName, branch, indexing_run_id: indexingRun.runId })
        .where({ indexing_status: 'indexing' })
        .update({
          indexing_status: 'idle',
          indexing_transition_at: transitionAt,
          updated_at: transitionAt
        });
    }
    await transaction('repository_indexing_transitions')
      .insert({
        full_name: storedFullName,
        branch,
        run_id: indexingRun.runId,
        status: 'idle',
        transition_at: transitionAt,
        observed_at: transitionAt
      })
      .onConflict(['full_name', 'branch', 'run_id', 'status', 'transition_at'])
      .ignore();
    return { runId: indexingRun.runId, transitionAt, applied: true };
  });
}

/** Finds durable indexing owners after the queue snapshot has no matching job. */
export async function getActiveRepositoryIndexingRuns(
  fullName: string,
  branch?: string,
  database: typeof db = db
): Promise<ActiveRepositoryIndexingRun[]> {
  const query = database('repositories')
    .select('full_name', 'branch', 'indexing_run_id', 'indexing_transition_at')
    .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
    .where({ indexing_status: 'indexing' })
    .whereNotNull('indexing_run_id')
    .whereNotNull('indexing_transition_at');
  if (branch !== undefined) query.where({ branch });
  const rows = await query as Array<{
    full_name: string;
    branch: string;
    indexing_run_id: string;
    indexing_transition_at: string;
  }>;
  return rows.map((row) => ({
    fullName: row.full_name,
    branch: row.branch,
    runId: row.indexing_run_id,
    transitionAt: row.indexing_transition_at
  }));
}

/**
 * Reads the current indexing status for a repository branch, or null when no row exists yet.
 */
export async function getRepositoryIndexingStatus(
  fullName: string,
  branch: string = 'HEAD'
): Promise<'idle' | 'indexing' | 'completed' | 'failed' | null> {
  const row = await db('repositories')
    .whereRaw('lower(full_name) = ?', [fullName.trim().toLowerCase()])
    .where({ branch })
    .select('indexing_status')
    .first();
  return (row?.indexing_status as 'idle' | 'indexing' | 'completed' | 'failed' | undefined) ?? null;
}

/**
 * Gets the summary for a specific file
 */
export async function getFileSummary(filePath: string, branch: string = 'HEAD'): Promise<FileSummaryResult | null> {
  const result = await db('file_summaries').where({ path: filePath, branch }).first();
  return result || null;
}

/**
 * Gets the summary for a specific directory
 */
export async function getDirectorySummary(dirPath: string, branch: string = 'HEAD'): Promise<DirectorySummaryResult | null> {
  const result = await db('directory_summaries').where({ path: dirPath, branch }).first();
  return result || null;
}

/**
 * Gets all file summaries for a repository
 */
export async function getRepositorySummaries(fullName: string, branch: string = 'HEAD'): Promise<FileSummaryResult[]> {
  return db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .orderBy('path');
}

/**
 * Clears all summaries for a repository (for re-indexing)
 */
export async function clearRepositorySummaries(fullName: string, branch: string = 'HEAD'): Promise<void> {
  await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .delete();

  await db('directory_summaries')
    .where(function() {
      this.where('path', 'like', `${fullName}/%`).orWhere('path', fullName);
    })
    .andWhere({ branch })
    .delete();

  await updateRepositoryStatus(fullName, 'idle', branch);
}
