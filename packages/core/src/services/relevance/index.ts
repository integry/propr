export { extractKeywords } from './keywordExtractor.js';
export { mineGitHistory } from './gitMiner.js';
export { scorePaths } from './pathScorer.js';
export type { FileScore as GitFileScore } from './gitMiner.js';
export type { FileScore as PathFileScore } from './pathScorer.js';

// Summary Miner exports
export {
  indexRepo,
  getFileSummary,
  getDirectorySummary,
  getRepositorySummaries,
  clearRepositorySummaries
} from './summaryMiner.js';
export {
  INDEXING_FAILED_JOB_RETENTION,
  INDEXING_JOB_ACCEPTANCE_DELAY_MS,
  createIndexingQueueDeduplicationId,
  createIndexingQueueJobId,
  createLegacyIndexingRunIdForJob,
  createIndexingRunIdentity
} from './indexingQueueIdentity.js';
export {
  getActiveRepositoryIndexingRuns,
  recordSkippedIndexingRun,
  updateRepositoryStatus
} from './summaryMinerQueries.js';
export { clearIndexingRuntimeStateBestEffort } from './indexingCancellation.js';
export type {
  ActiveRepositoryIndexingRun,
  IndexingRunIdentity,
  RepositoryStatusTransition,
  UpdateRepositoryStatusOptions
} from './summaryMinerQueries.js';
export {
  scanProcessableGitFiles,
  shouldProcessFilePath,
  isProcessableFile
} from './summaryFileFilter.js';
export type {
  FileSummary,
  DirectorySummary,
  IndexingOptions,
  IndexingOutcome
} from './summaryMiner.js';
export type { GitFileInfo } from './summaryFileFilter.js';
