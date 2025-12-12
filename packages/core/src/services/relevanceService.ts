import { extractKeywords } from './relevance/keywordExtractor.js';
import { mineGitHistory, mineGitHistoryWithLLM, FileScore as GitFileScore, SemanticMiningOptions } from './relevance/gitMiner.js';
import { scorePaths, FileScore as PathFileScore } from './relevance/pathScorer.js';
import logger from '../utils/logger.js';

export interface RelevantFile {
  path: string;
  reason: 'git-history' | 'path-match' | 'combined' | 'llm-semantic';
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
  useSemanticMining?: boolean;
  semanticMiningOptions?: SemanticMiningOptions;
}

// No artificial limit - let context service handle token-based truncation
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_MIN_SCORE = 30;
const TIMEOUT_MS = 2000;
const SEMANTIC_TIMEOUT_MS = 30000;

function addScoresToMap(
  scores: GitFileScore[] | PathFileScore[],
  finalScores: Record<string, { score: number; reasons: Set<string> }>,
  reason: string
): void {
  for (const item of scores) {
    if (!finalScores[item.path]) {
      finalScores[item.path] = { score: 0, reasons: new Set() };
    }
    finalScores[item.path].score += item.score;
    finalScores[item.path].reasons.add(reason);
  }
}

function buildSortedFiles(
  finalScores: Record<string, { score: number; reasons: Set<string> }>,
  minScore: number,
  maxResults: number
): RelevantFile[] {
  return Object.entries(finalScores)
    .filter(([, data]) => data.score >= minScore)
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, maxResults)
    .map(([path, data]): RelevantFile => {
      const reasons = Array.from(data.reasons);
      let reason: 'git-history' | 'path-match' | 'combined' | 'llm-semantic';
      if (reasons.length > 1) {
        reason = 'combined';
      } else {
        reason = reasons[0] as 'git-history' | 'path-match' | 'llm-semantic';
      }
      return { path, reason, score: data.score };
    });
}

export async function findRelevantFiles(
  repoPath: string,
  prompt: string,
  options: RelevanceOptions = {}
): Promise<RelevanceResult> {
  const {
    maxResults = DEFAULT_MAX_RESULTS,
    minScore = DEFAULT_MIN_SCORE,
    correlationId,
    useSemanticMining = false,
    semanticMiningOptions
  } = options;
  
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  
  correlatedLogger.info({ repoPath, promptLength: prompt.length, useSemanticMining }, 'Starting relevance analysis');
  
  const keywords = extractKeywords(prompt);
  
  correlatedLogger.debug({ keywords }, 'Extracted keywords');

  const finalScores: Record<string, { score: number; reasons: Set<string> }> = {};
  let usedSemanticMining = false;

  if (useSemanticMining && semanticMiningOptions) {
    try {
      const semanticTimeoutPromise = new Promise<GitFileScore[]>((_, reject) => {
        setTimeout(() => reject(new Error('Semantic mining timeout')), SEMANTIC_TIMEOUT_MS);
      });

      const semanticPromise = mineGitHistoryWithLLM(
        repoPath,
        prompt,
        { ...semanticMiningOptions, correlationId }
      );

      const semanticScores = await Promise.race([semanticPromise, semanticTimeoutPromise]);

      addScoresToMap(semanticScores, finalScores, 'llm-semantic');

      usedSemanticMining = semanticScores.length > 0;
      correlatedLogger.info({ semanticFileCount: semanticScores.length }, 'Semantic mining completed');
    } catch (error) {
      correlatedLogger.warn(
        { error: (error as Error).message },
        'Semantic mining failed or timed out, falling back to keyword-based mining'
      );
    }
  }

  if (keywords.length === 0 && !usedSemanticMining) {
    correlatedLogger.info('No keywords extracted and no semantic results');
    return { files: [], keywordsDetected: [] };
  }

  const timeoutPromise = new Promise<{ gitScores: GitFileScore[]; pathScores: PathFileScore[] }>((_, reject) => {
    setTimeout(() => reject(new Error('Relevance analysis timeout')), TIMEOUT_MS);
  });

  const analysisPromise = Promise.all([
    keywords.length > 0 ? mineGitHistory(repoPath, keywords) : Promise.resolve([]),
    keywords.length > 0 ? scorePaths(repoPath, keywords) : Promise.resolve([])
  ]).then(([gitScores, pathScores]) => ({ gitScores, pathScores }));

  let gitScores: GitFileScore[];
  let pathScores: PathFileScore[];
  
  try {
    const result = await Promise.race([analysisPromise, timeoutPromise]);
    gitScores = result.gitScores;
    pathScores = result.pathScores;
  } catch (error) {
    if ((error as Error).message === 'Relevance analysis timeout') {
      correlatedLogger.warn('Keyword-based relevance analysis timed out');
      gitScores = [];
      pathScores = [];
    } else {
      throw error;
    }
  }
  
  addScoresToMap(gitScores, finalScores, 'git-history');
  addScoresToMap(pathScores, finalScores, 'path-match');

  const sortedFiles = buildSortedFiles(finalScores, minScore, maxResults);

  correlatedLogger.info(
    { resultCount: sortedFiles.length, keywordCount: keywords.length, usedSemanticMining },
    'Relevance analysis completed'
  );

  return {
    files: sortedFiles,
    keywordsDetected: keywords
  };
}
