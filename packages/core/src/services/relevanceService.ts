import { extractKeywords } from './relevance/keywordExtractor.js';
import { mineGitHistory, mineGitHistoryWithLLM, FileScore as GitFileScore, SemanticMiningOptions } from './relevance/gitMiner.js';
import { scorePaths, FileScore as PathFileScore } from './relevance/pathScorer.js';
import { scoreSemanticRelevance, SemanticFileScore, SemanticScoringOptions } from './relevance/semanticScorer.js';
import { Agent } from '../agents/types.js';
import logger from '../utils/logger.js';

export interface RelevantFile {
  path: string;
  reason: 'git-history' | 'path-match' | 'combined' | 'llm-semantic' | 'semantic';
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
  /** Enable semantic scoring based on AI-generated file summaries */
  useSummaryScoring?: boolean;
  /** Agent to use for summary-based semantic scoring */
  agent?: Agent;
  /** Model ID for token budget calculation in summary scoring */
  modelId?: string;
  /** Repository full name (e.g., "owner/repo") for filtering summaries */
  repoName?: string;
}

// --- Score Aggregation Weights ---
// These weights determine how different scoring signals are combined.
// Tunable based on testing results.

/** Weight for git history-based scores (temporal relevance) */
const GIT_SCORE_WEIGHT = 0.35;

/** Weight for path/naming convention-based scores */
const PATH_SCORE_WEIGHT = 0.15;

/** Weight for semantic/summary-based scores (content understanding) */
const SEMANTIC_SCORE_WEIGHT = 0.50;

// No artificial limit - let context service handle token-based truncation
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_MIN_SCORE = 30;
const TIMEOUT_MS = 2000;
const SEMANTIC_TIMEOUT_MS = 30000;
const SUMMARY_SCORING_TIMEOUT_MS = 60000;

// --- Score Types for Weighted Aggregation ---

interface RawScores {
  git: number;
  path: number;
  semantic: number;
}

interface AggregatedFileScore {
  rawScores: RawScores;
  normalizedScore: number;
  reasons: Set<string>;
}

/**
 * Normalizes a score to 0-100 range.
 * Git scores can exceed 100 due to cumulative counting.
 */
function normalizeScore(score: number, maxExpected: number = 100): number {
  return Math.min(100, Math.max(0, (score / maxExpected) * 100));
}

/**
 * Adds raw scores to the aggregation map (without weighting).
 * Weighting is applied at the end for proper normalization.
 */
function addRawScoresToMap(
  scores: Array<{ path: string; score: number }>,
  finalScores: Record<string, AggregatedFileScore>,
  scoreType: 'git' | 'path' | 'semantic',
  reason: string
): void {
  for (const item of scores) {
    if (!finalScores[item.path]) {
      finalScores[item.path] = {
        rawScores: { git: 0, path: 0, semantic: 0 },
        normalizedScore: 0,
        reasons: new Set()
      };
    }
    finalScores[item.path].rawScores[scoreType] = Math.max(
      finalScores[item.path].rawScores[scoreType],
      item.score
    );
    finalScores[item.path].reasons.add(reason);
  }
}

/**
 * Applies weighted aggregation to compute final normalized scores.
 * Formula: Final = (Git * 0.35) + (Path * 0.15) + (Semantic * 0.50)
 * All individual scores are normalized to 0-100 before weighting.
 */
function computeWeightedScores(
  finalScores: Record<string, AggregatedFileScore>,
  hasSemanticScores: boolean
): void {
  // Find max git score for normalization (can exceed 100)
  let maxGitScore = 100;
  for (const data of Object.values(finalScores)) {
    if (data.rawScores.git > maxGitScore) {
      maxGitScore = data.rawScores.git;
    }
  }

  // Adjust weights if semantic scoring wasn't available
  const effectiveGitWeight = hasSemanticScores ? GIT_SCORE_WEIGHT : 0.6;
  const effectivePathWeight = hasSemanticScores ? PATH_SCORE_WEIGHT : 0.4;
  const effectiveSemanticWeight = hasSemanticScores ? SEMANTIC_SCORE_WEIGHT : 0;

  for (const data of Object.values(finalScores)) {
    const normalizedGit = normalizeScore(data.rawScores.git, maxGitScore);
    const normalizedPath = normalizeScore(data.rawScores.path, 100);
    const normalizedSemantic = normalizeScore(data.rawScores.semantic, 100);

    data.normalizedScore = Math.round(
      (normalizedGit * effectiveGitWeight) +
      (normalizedPath * effectivePathWeight) +
      (normalizedSemantic * effectiveSemanticWeight)
    );
  }
}

function buildSortedFiles(
  finalScores: Record<string, AggregatedFileScore>,
  minScore: number,
  maxResults: number
): RelevantFile[] {
  return Object.entries(finalScores)
    .filter(([, data]) => data.normalizedScore >= minScore)
    .sort(([, a], [, b]) => b.normalizedScore - a.normalizedScore)
    .slice(0, maxResults)
    .map(([path, data]): RelevantFile => {
      const reasons = Array.from(data.reasons);
      let reason: RelevantFile['reason'];
      if (reasons.length > 1) {
        reason = 'combined';
      } else {
        reason = reasons[0] as RelevantFile['reason'];
      }
      return { path, reason, score: data.normalizedScore };
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
    semanticMiningOptions,
    useSummaryScoring = false,
    agent,
    modelId,
    repoName
  } = options;

  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  correlatedLogger.info({
    repoPath,
    promptLength: prompt.length,
    useSemanticMining,
    useSummaryScoring
  }, 'Starting relevance analysis');

  const keywords = extractKeywords(prompt);

  correlatedLogger.debug({ keywords }, 'Extracted keywords');

  const finalScores: Record<string, AggregatedFileScore> = {};
  let usedSemanticMining = false;
  let usedSummaryScoring = false;

  // --- Phase 1: Git History Semantic Mining (via commit analysis) ---
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

      addRawScoresToMap(semanticScores, finalScores, 'semantic', 'llm-semantic');

      usedSemanticMining = semanticScores.length > 0;
      correlatedLogger.info({ semanticFileCount: semanticScores.length }, 'Git semantic mining completed');
    } catch (error) {
      correlatedLogger.warn(
        { error: (error as Error).message },
        'Git semantic mining failed or timed out'
      );
    }
  }

  // --- Phase 2: Keyword-based scoring (Git history + Path matching) ---
  if (keywords.length === 0 && !usedSemanticMining && !useSummaryScoring) {
    correlatedLogger.info('No keywords extracted and no semantic options enabled');
    return { files: [], keywordsDetected: [] };
  }

  let gitScores: GitFileScore[] = [];
  let pathScores: PathFileScore[] = [];

  if (keywords.length > 0) {
    const timeoutPromise = new Promise<{ gitScores: GitFileScore[]; pathScores: PathFileScore[] }>((_, reject) => {
      setTimeout(() => reject(new Error('Relevance analysis timeout')), TIMEOUT_MS);
    });

    const analysisPromise = Promise.all([
      mineGitHistory(repoPath, keywords),
      scorePaths(repoPath, keywords)
    ]).then(([git, path]) => ({ gitScores: git, pathScores: path }));

    try {
      const result = await Promise.race([analysisPromise, timeoutPromise]);
      gitScores = result.gitScores;
      pathScores = result.pathScores;
    } catch (error) {
      if ((error as Error).message === 'Relevance analysis timeout') {
        correlatedLogger.warn('Keyword-based relevance analysis timed out');
      } else {
        throw error;
      }
    }
  }

  addRawScoresToMap(gitScores, finalScores, 'git', 'git-history');
  addRawScoresToMap(pathScores, finalScores, 'path', 'path-match');

  // --- Phase 3: Summary-based Semantic Scoring ---
  if (useSummaryScoring && agent) {
    try {
      // Extract priority paths from current git/path scores for Tier 2 context building
      const priorityPaths = Object.entries(finalScores)
        .filter(([, data]) => data.rawScores.git > 0 || data.rawScores.path > 0)
        .sort(([, a], [, b]) =>
          (b.rawScores.git + b.rawScores.path) - (a.rawScores.git + a.rawScores.path)
        )
        .slice(0, 50)
        .map(([path]) => path);

      const summaryTimeoutPromise = new Promise<SemanticFileScore[]>((_, reject) => {
        setTimeout(() => reject(new Error('Summary scoring timeout')), SUMMARY_SCORING_TIMEOUT_MS);
      });

      const summaryOptions: SemanticScoringOptions = {
        agent,
        priorityPaths,
        correlationId,
        modelId,
        repoName
      };

      const summaryPromise = scoreSemanticRelevance(prompt, summaryOptions);
      const summaryScores = await Promise.race([summaryPromise, summaryTimeoutPromise]);

      addRawScoresToMap(summaryScores, finalScores, 'semantic', 'semantic');

      usedSummaryScoring = summaryScores.length > 0;
      correlatedLogger.info({ summaryFileCount: summaryScores.length }, 'Summary-based semantic scoring completed');
    } catch (error) {
      correlatedLogger.warn(
        { error: (error as Error).message },
        'Summary-based semantic scoring failed or timed out'
      );
    }
  }

  // --- Phase 4: Weighted Score Aggregation ---
  const hasSemanticScores = usedSemanticMining || usedSummaryScoring;
  computeWeightedScores(finalScores, hasSemanticScores);

  const sortedFiles = buildSortedFiles(finalScores, minScore, maxResults);

  correlatedLogger.info(
    {
      resultCount: sortedFiles.length,
      keywordCount: keywords.length,
      usedSemanticMining,
      usedSummaryScoring,
      hasSemanticScores
    },
    'Relevance analysis completed'
  );

  return {
    files: sortedFiles,
    keywordsDetected: keywords
  };
}

// --- Re-exports for external use ---
export { GIT_SCORE_WEIGHT, PATH_SCORE_WEIGHT, SEMANTIC_SCORE_WEIGHT };
