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

export interface IndexingRunIdentity {
  runId: string;
  transitionAt: string;
}

export interface UpdateRepositoryStatusOptions extends Partial<IndexingRunIdentity> {
  startNewRun?: boolean;
  commitInfo?: { hash?: string; message?: string; iconPath?: string | null };
}

export interface RepositoryStatusTransition extends IndexingRunIdentity {
  applied: boolean;
}

export function createIndexingRunIdentity(now: Date = new Date()): IndexingRunIdentity {
  return { runId: randomUUID(), transitionAt: now.toISOString() };
}

/** BullMQ's atomic repository/branch ownership key for live indexing work. */
export function createIndexingQueueJobId(fullName: string, branch: string = 'HEAD'): string {
  const digest = createHash('sha256').update(`${fullName}\0${branch}`).digest('hex');
  return `index-repository-${digest}`;
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
  return db.transaction(
    // eslint-disable-next-line complexity -- run ownership and ordering form one atomic decision
    async (transaction) => {
    const existing = await transaction('repositories')
      .select('indexing_status', 'indexing_transition_at', 'indexing_run_id')
      .where({ full_name: fullName, branch })
      .first() as {
        indexing_status?: string;
        indexing_transition_at?: string | null;
        indexing_run_id?: string | null;
      } | undefined;
    const now = new Date().toISOString();
    const requestedRunId = options.runId;
    const replacingRun = status === 'indexing' && options.startNewRun === true;
    if (
      replacingRun
      && existing?.indexing_run_id
      && requestedRunId
      && existing.indexing_run_id !== requestedRunId
      && existing.indexing_transition_at
      && options.transitionAt
      && options.transitionAt <= existing.indexing_transition_at
    ) {
      return {
        runId: requestedRunId,
        transitionAt: options.transitionAt,
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

    const statusChanged = existing?.indexing_status !== status;
    const runId = requestedRunId ?? (
      status === 'indexing' && (replacingRun || statusChanged) || !existing?.indexing_run_id
        ? randomUUID()
        : existing.indexing_run_id
    );
    const runChanged = existing?.indexing_run_id !== runId;
    let transitionAt = runChanged
      ? options.transitionAt ?? now
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
        full_name: fullName,
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
        full_name: fullName,
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
 * Reads the current indexing status for a repository branch, or null when no row exists yet.
 */
export async function getRepositoryIndexingStatus(
  fullName: string,
  branch: string = 'HEAD'
): Promise<'idle' | 'indexing' | 'completed' | 'failed' | null> {
  const row = await db('repositories')
    .where({ full_name: fullName, branch })
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
