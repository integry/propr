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
): Promise<void> {
  const lastIndexedHash = commitInfo?.hash;
  const lastIndexedCommitMessage = commitInfo?.message;
  const iconPath = commitInfo?.iconPath;
  const updateData: Record<string, unknown> = {
    indexing_status: status,
    updated_at: db.fn.now()
  };

  if (status === 'completed') {
    updateData.last_indexed_at = db.fn.now();
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

  await db('repositories')
    .insert({
      full_name: fullName,
      branch,
      indexing_status: status,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
      last_indexed_hash: lastIndexedHash || null,
      last_indexed_commit_message: lastIndexedCommitMessage || null,
      icon_path: iconPath || null,
      ...(status === 'completed' ? { last_indexed_at: db.fn.now() } : {})
    })
    .onConflict(['full_name', 'branch'])
    .merge(updateData);
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
