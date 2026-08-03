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
  createIndexingQueueDeduplicationId,
  createIndexingQueueJobId,
  createIndexingRunIdentity,
  updateRepositoryStatus
} from './summaryMinerQueries.js';
export type {
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
