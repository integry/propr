import type { Logger } from 'pino';
import { db } from '../../db/connection.js';
import type { GitFileInfo } from './summaryFileFilter.js';

interface IdentifyStaleFilesOptions {
  branch: string;
  fullReindex?: boolean;
}

export async function identifyStaleFiles(
  fullName: string,
  gitFiles: GitFileInfo[],
  log: Logger,
  options: IdentifyStaleFilesOptions
): Promise<{
  filesToProcess: GitFileInfo[];
  filesToDelete: string[];
}> {
  const { branch, fullReindex } = options;
  const existingSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .select('path', 'commit_hash');

  const dbHashMap = new Map<string, string>();
  for (const summary of existingSummaries) {
    dbHashMap.set(summary.path, summary.commit_hash);
  }

  const gitFileFullPathSet = new Set(gitFiles.map(f => `${fullName}/${f.path}`));
  const filesToProcess = fullReindex
    ? [...gitFiles]
    : gitFiles.filter(file => dbHashMap.get(`${fullName}/${file.path}`) !== file.blobHash);
  const filesToDelete = Array.from(dbHashMap.keys()).filter(dbPath => !gitFileFullPathSet.has(dbPath));

  if (fullReindex) {
    log.info({ fullReindex: true, fileCount: gitFiles.length }, 'Full reindex requested - processing all files');
  }

  log.debug({
    fullReindex: !!fullReindex,
    existingInDb: dbHashMap.size,
    newFiles: filesToProcess.filter(f => !dbHashMap.has(`${fullName}/${f.path}`)).length,
    changedFiles: filesToProcess.filter(f => dbHashMap.has(`${fullName}/${f.path}`)).length,
    deletedFiles: filesToDelete.length,
    unchangedFiles: fullReindex ? 0 : (gitFiles.length - filesToProcess.length)
  }, 'Staleness check complete');

  return { filesToProcess, filesToDelete };
}

export async function deleteFileSummaries(paths: string[], branch: string): Promise<void> {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
    const chunk = paths.slice(i, i + CHUNK_SIZE);
    await db('file_summaries')
      .whereIn('path', chunk)
      .andWhere({ branch })
      .delete();
  }
}
