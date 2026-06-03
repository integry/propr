import { extractKeywords, extractKeywordsWithLLM, mergeKeywords } from './relevance/keywordExtractor.js';
import { mineGitHistory, mineGitHistoryWithLLM, type FileScore as GitFileScore, type SemanticMiningOptions } from './relevance/gitMiner.js';
import { scorePaths, FileScore as PathFileScore } from './relevance/pathScorer.js';
import { scoreSemanticRelevance, type SemanticScoringOptions } from './relevance/semanticScorer.js';
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
  /** Branch to filter summaries (e.g., "HEAD", "main", "dev") */
  branch?: string;
  /** Enable LLM-based keyword extraction for better alternatives and spelling variants */
  useLLMKeywords?: boolean;
  /** Timeout for git/path keyword scoring. */
  keywordTimeoutMs?: number;
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
// Low threshold - include files with any relevance signal; context service handles token limits
const DEFAULT_MIN_SCORE = 10;
const TIMEOUT_MS = 2000;
const SEMANTIC_TIMEOUT_MS = 30000;

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

/**
 * Extract keywords with optional LLM enhancement
 */
async function extractKeywordsForRelevance(
  prompt: string,
  agent: Agent | undefined,
  useLLMKeywords: boolean,
  correlationId?: string
): Promise<string[]> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  let keywords = extractKeywords(prompt);

  if (useLLMKeywords && agent) {
    try {
      const llmKeywords = await extractKeywordsWithLLM(prompt, { agent, correlationId });
      keywords = mergeKeywords(keywords, llmKeywords);
      correlatedLogger.info({
        basicCount: extractKeywords(prompt).length,
        llmPrimary: llmKeywords.primary,
        llmAlternatives: llmKeywords.alternatives.slice(0, 10),
        mergedCount: keywords.length
      }, 'LLM keyword extraction merged');
    } catch (error) {
      correlatedLogger.warn({ error: (error as Error).message }, 'LLM keyword extraction failed, using basic keywords');
    }
  }

  return keywords;
}

interface GitSemanticMiningParams {
  repoPath: string;
  prompt: string;
  semanticMiningOptions: SemanticMiningOptions;
  finalScores: Record<string, AggregatedFileScore>;
  correlationId?: string;
}

/**
 * Phase 1: Git History Semantic Mining (via commit analysis)
 */
async function performGitSemanticMining(params: GitSemanticMiningParams): Promise<boolean> {
  const { repoPath, prompt, semanticMiningOptions, finalScores, correlationId } = params;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

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

    correlatedLogger.info({ semanticFileCount: semanticScores.length }, 'Git semantic mining completed');
    return semanticScores.length > 0;
  } catch (error) {
    correlatedLogger.warn(
      { error: (error as Error).message },
      'Git semantic mining failed or timed out'
    );
    return false;
  }
}

/**
 * Phase 2: Keyword-based scoring (Git history + Path matching)
 */
async function performKeywordScoring(params: {
  repoPath: string;
  keywords: string[];
  finalScores: Record<string, AggregatedFileScore>;
  correlationId?: string;
  timeoutMs?: number;
}): Promise<void> {
  const { repoPath, keywords, finalScores, correlationId, timeoutMs = TIMEOUT_MS } = params;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  async function withTimeout<T>(name: string, promise: Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            correlatedLogger.warn({ source: name, timeoutMs }, 'Keyword relevance source timed out');
            resolve(fallback);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  const [gitScores, pathScores] = await Promise.all([
    withTimeout('git-history', mineGitHistory(repoPath, keywords), [] as GitFileScore[]),
    withTimeout('path-match', scorePaths(repoPath, keywords), [] as PathFileScore[])
  ]);

  addRawScoresToMap(gitScores, finalScores, 'git', 'git-history');
  addRawScoresToMap(pathScores, finalScores, 'path', 'path-match');
}

/**
 * Phase 3: Summary-based Semantic Scoring
 */
async function performSummaryScoring(
  prompt: string,
  agent: Agent,
  finalScores: Record<string, AggregatedFileScore>,
  options: { correlationId?: string; modelId?: string; repoName?: string; branch?: string }
): Promise<boolean> {
  const { correlationId, modelId, repoName, branch } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  try {
    // Extract priority paths from current git/path scores for Tier 2 context building
    const priorityPaths = Object.entries(finalScores)
      .filter(([, data]) => data.rawScores.git > 0 || data.rawScores.path > 0)
      .sort(([, a], [, b]) =>
        (b.rawScores.git + b.rawScores.path) - (a.rawScores.git + a.rawScores.path)
      )
      .map(([path]) => path);

    const summaryOptions: SemanticScoringOptions = {
      agent,
      priorityPaths,
      correlationId,
      modelId,
      repoName,
      branch
    };

    const summaryScores = await scoreSemanticRelevance(prompt, summaryOptions);

    addRawScoresToMap(summaryScores, finalScores, 'semantic', 'semantic');

    correlatedLogger.info({ summaryFileCount: summaryScores.length }, 'Summary-based semantic scoring completed');
    return summaryScores.length > 0;
  } catch (error) {
    correlatedLogger.warn(
      { error: (error as Error).message },
      'Summary-based semantic scoring failed or timed out'
    );
    return false;
  }
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
    repoName,
    branch,
    useLLMKeywords = false,
    keywordTimeoutMs = TIMEOUT_MS
  } = options;

  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  correlatedLogger.info({
    repoPath,
    promptLength: prompt.length,
    useSemanticMining,
    useSummaryScoring,
    useLLMKeywords
  }, 'Starting relevance analysis');

  // Extract keywords - optionally enhanced with LLM
  const keywords = await extractKeywordsForRelevance(prompt, agent, useLLMKeywords, correlationId);

  correlatedLogger.debug({ keywords }, 'Extracted keywords');

  const finalScores: Record<string, AggregatedFileScore> = {};
  let usedSemanticMining = false;
  let usedSummaryScoring = false;

  // --- Phase 1: Git History Semantic Mining (via commit analysis) ---
  if (useSemanticMining && semanticMiningOptions) {
    usedSemanticMining = await performGitSemanticMining({
      repoPath, prompt, semanticMiningOptions, finalScores, correlationId
    });
  }

  // --- Phase 2: Keyword-based scoring (Git history + Path matching) ---
  if (keywords.length === 0 && !usedSemanticMining && !useSummaryScoring) {
    correlatedLogger.info('No keywords extracted and no semantic options enabled');
    return { files: [], keywordsDetected: [] };
  }

  if (keywords.length > 0) {
    await performKeywordScoring({ repoPath, keywords, finalScores, correlationId, timeoutMs: keywordTimeoutMs });
  }

  // --- Phase 3: Summary-based Semantic Scoring ---
  if (useSummaryScoring && agent) {
    usedSummaryScoring = await performSummaryScoring(prompt, agent, finalScores, {
      correlationId, modelId, repoName, branch
    });
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
