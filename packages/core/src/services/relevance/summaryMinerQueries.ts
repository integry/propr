import { randomUUID } from 'node:crypto';
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

/**
 * Updates the repository indexing status
 */
export async function updateRepositoryStatus(
  fullName: string,
  status: 'idle' | 'indexing' | 'completed' | 'failed',
  branch: string = 'HEAD',
  commitInfo?: { hash?: string; message?: string; iconPath?: string | null }
): Promise<{ transitionAt: string; runId: string }> {
  return db.transaction(async (transaction) => {
    const existing = await transaction('repositories')
      .select('indexing_status', 'indexing_transition_at', 'indexing_run_id')
      .where({ full_name: fullName, branch })
      .first() as {
        indexing_status?: string;
        indexing_transition_at?: string | null;
        indexing_run_id?: string | null;
      } | undefined;
    const now = new Date().toISOString();
    const statusChanged = existing?.indexing_status !== status;
    const transitionAt = statusChanged || !existing?.indexing_transition_at
      ? now
      : existing.indexing_transition_at;
    const runId = (status === 'indexing' && statusChanged) || !existing?.indexing_run_id
      ? randomUUID()
      : existing.indexing_run_id;
    const lastIndexedHash = commitInfo?.hash;
    const lastIndexedCommitMessage = commitInfo?.message;
    const iconPath = commitInfo?.iconPath;
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
    return { transitionAt, runId };
  });
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
