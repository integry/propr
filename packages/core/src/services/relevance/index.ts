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
  scanProcessableGitFiles,
  shouldProcessFilePath,
  isProcessableFile
} from './summaryFileFilter.js';
export type {
  FileSummary,
  DirectorySummary,
  IndexingOptions
} from './summaryMiner.js';
export type { GitFileInfo } from './summaryFileFilter.js';
