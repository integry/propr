import { extractKeywords } from './relevance/keywordExtractor.js';
import { mineGitHistory, FileScore as GitFileScore } from './relevance/gitMiner.js';
import { scorePaths, FileScore as PathFileScore } from './relevance/pathScorer.js';
import logger from '../utils/logger.js';

export interface RelevantFile {
  path: string;
  reason: 'git-history' | 'path-match' | 'combined';
  score: number;
}

export interface RelevanceResult {
  files: RelevantFile[];
  keywordsDetected: string[];
}

export interface RelevanceOptions {
  maxResults?: number;
  minScore?: number;
  correlationId?: string;
}

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MIN_SCORE = 30;
const TIMEOUT_MS = 2000;

export async function findRelevantFiles(
  repoPath: string,
  prompt: string,
  options: RelevanceOptions = {}
): Promise<RelevanceResult> {
  const {
    maxResults = DEFAULT_MAX_RESULTS,
    minScore = DEFAULT_MIN_SCORE,
    correlationId
  } = options;
  
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  
  correlatedLogger.info({ repoPath, promptLength: prompt.length }, 'Starting relevance analysis');
  
  const keywords = extractKeywords(prompt);
  
  if (keywords.length === 0) {
    correlatedLogger.info('No keywords extracted from prompt');
    return { files: [], keywordsDetected: [] };
  }
  
  correlatedLogger.debug({ keywords }, 'Extracted keywords');

  const timeoutPromise = new Promise<{ gitScores: GitFileScore[]; pathScores: PathFileScore[] }>((_, reject) => {
    setTimeout(() => reject(new Error('Relevance analysis timeout')), TIMEOUT_MS);
  });

  const analysisPromise = Promise.all([
    mineGitHistory(repoPath, keywords),
    scorePaths(repoPath, keywords)
  ]).then(([gitScores, pathScores]) => ({ gitScores, pathScores }));

  let gitScores: GitFileScore[];
  let pathScores: PathFileScore[];
  
  try {
    const result = await Promise.race([analysisPromise, timeoutPromise]);
    gitScores = result.gitScores;
    pathScores = result.pathScores;
  } catch (error) {
    if ((error as Error).message === 'Relevance analysis timeout') {
      correlatedLogger.warn('Relevance analysis timed out, returning partial results');
      gitScores = [];
      pathScores = [];
    } else {
      throw error;
    }
  }

  const finalScores: Record<string, { score: number; reasons: Set<string> }> = {};
  
  for (const item of gitScores) {
    if (!finalScores[item.path]) {
      finalScores[item.path] = { score: 0, reasons: new Set() };
    }
    finalScores[item.path].score += item.score;
    finalScores[item.path].reasons.add('git-history');
  }
  
  for (const item of pathScores) {
    if (!finalScores[item.path]) {
      finalScores[item.path] = { score: 0, reasons: new Set() };
    }
    finalScores[item.path].score += item.score;
    finalScores[item.path].reasons.add('path-match');
  }

  const sortedFiles = Object.entries(finalScores)
    .filter(([, data]) => data.score >= minScore)
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, maxResults)
    .map(([path, data]): RelevantFile => {
      const reasons = Array.from(data.reasons);
      let reason: 'git-history' | 'path-match' | 'combined';
      if (reasons.length > 1) {
        reason = 'combined';
      } else {
        reason = reasons[0] as 'git-history' | 'path-match';
      }
      return { path, reason, score: data.score };
    });

  correlatedLogger.info(
    { resultCount: sortedFiles.length, keywordCount: keywords.length },
    'Relevance analysis completed'
  );

  return {
    files: sortedFiles,
    keywordsDetected: keywords
  };
}
