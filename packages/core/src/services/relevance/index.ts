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
export type {
  FileSummary,
  DirectorySummary,
  GitFileInfo,
  IndexingOptions
} from './summaryMiner.js';
