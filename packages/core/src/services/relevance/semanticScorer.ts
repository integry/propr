import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { buildSummaryContext, ContextBuildOptions } from './contextBuilder.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';

// --- Types ---

export interface SemanticFileScore {
  path: string;
  score: number;
  reason: 'semantic';
}

export interface SemanticScoringOptions {
  /** Agent to use for the semantic analysis */
  agent: Agent;
  /** Paths already flagged by git/path scoring (helps build context) */
  priorityPaths?: string[];
  /** Custom correlation ID for logging */
  correlationId?: string;
  /** Model ID for token budget calculation */
  modelId?: string;
  /** Repository full name (e.g., "owner/repo") to filter summaries */
  repoName?: string;
}

export interface SemanticLLMFile {
  path: string;
  score: number;
  reason?: string;
}

export interface SemanticLLMResponse {
  files: SemanticLLMFile[];
}

// --- Constants ---

const CHARS_PER_TOKEN_ESTIMATE = 3;

// --- Main Export ---

/**
 * Uses AI-generated summaries to semantically score files based on the user's request.
 *
 * This function:
 * 1. Builds a "smart context" from stored file/directory summaries
 * 2. Sends the context to an LLM with the user's prompt
 * 3. Returns confidence scores for files that need modification
 */
export async function scoreSemanticRelevance(
  userPrompt: string,
  options: SemanticScoringOptions
): Promise<SemanticFileScore[]> {
  const { agent, priorityPaths = [], correlationId, modelId, repoName } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  try {
    // Build smart context from summaries
    const contextOptions: ContextBuildOptions = {
      modelId,
      priorityPaths,
      correlationId,
      repoName
    };

    const contextResult = await buildSummaryContext(contextOptions);

    if (!contextResult.context || contextResult.context.trim().length === 0) {
      correlatedLogger.debug('No summary context available, skipping semantic scoring');
      return [];
    }

    correlatedLogger.info({
      fileSummaries: contextResult.fileSummaryCount,
      dirSummaries: contextResult.dirSummaryCount,
      estimatedTokens: contextResult.estimatedTokens,
      truncated: contextResult.truncated
    }, 'Built context for semantic scoring');

    // Build the ranking prompt
    const prompt = buildSemanticRankingPrompt(userPrompt, contextResult.context);
    const startTime = Date.now();

    // Estimate tokens for metrics
    const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
    const estimatedOutputTokens = 500; // Expect ~500 tokens for the file list response

    let success = false;
    let errorMessage: string | undefined;
    let scores: SemanticFileScore[] = [];

    try {
      // Use the agent's analyze method for lightweight analysis
      const response = await agent.analyze(prompt);
      const parsed = parseSemanticResponse(response);

      scores = parsed.files.map(f => ({
        path: f.path,
        score: f.score,
        reason: 'semantic' as const
      }));

      success = true;
      correlatedLogger.info({ fileCount: scores.length }, 'Semantic scoring completed');
    } catch (error) {
      errorMessage = (error as Error).message;
      correlatedLogger.warn({ error: errorMessage }, 'Semantic scoring LLM call failed');
    }

    const durationMs = Date.now() - startTime;

    // Log metrics
    await logSummarizationCall({
      timestamp: new Date().toISOString(),
      callType: 'semantic_scoring',
      model: agent.config.defaultModel || 'haiku',
      agentAlias: agent.config.alias,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
      success,
      durationMs,
      error: errorMessage
    }, correlatedLogger);

    return scores;
  } catch (error) {
    correlatedLogger.error(
      { error: (error as Error).message },
      'Semantic scoring failed'
    );
    return [];
  }
}

// --- Prompt Builder ---

/**
 * Builds the prompt for semantic file ranking.
 */
function buildSemanticRankingPrompt(userRequest: string, summaryContext: string): string {
  return `You are a senior engineer planning a task.

User Request: ${userRequest}

Below is a summary of the codebase structure and file purposes.
Based ONLY on these summaries, identify which files need to be modified or read to complete the user's request.

CODEBASE SUMMARY:
${summaryContext}

TASK:
1. Analyze the user request and identify relevant files from the summaries above.
2. Assign a confidence score (0-100) to each file based on how likely it needs modification.
3. Include files that need to be read for context, but give them lower scores.

OUTPUT FORMAT:
Return ONLY a valid JSON object in this exact format:
{
  "files": [
    { "path": "relative/path/to/file", "score": 90, "reason": "Why this file is relevant" }
  ]
}

Guidelines:
- Score 80-100: Files that definitely need modification
- Score 50-79: Files that likely need modification or must be read
- Score 20-49: Files that might be relevant for context
- Only include files explicitly mentioned in the summaries
- Maximum 50 files in your response
- Respond ONLY with valid JSON, no markdown or explanations`;
}

// --- Response Parser ---

/**
 * Parses the LLM response for semantic scoring.
 */
function parseSemanticResponse(response: string): SemanticLLMResponse {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (!jsonMatch) {
      logger.debug('No JSON found in semantic scoring response');
      return { files: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as SemanticLLMResponse;

    if (!parsed.files || !Array.isArray(parsed.files)) {
      logger.debug('Invalid files format in semantic scoring response');
      return { files: [] };
    }

    // Validate and normalize the file entries
    return {
      files: parsed.files
        .filter(f =>
          typeof f.path === 'string' &&
          typeof f.score === 'number' &&
          f.path.trim().length > 0
        )
        .map(f => ({
          path: f.path.trim(),
          score: Math.min(100, Math.max(0, f.score)),
          reason: typeof f.reason === 'string' ? f.reason : 'semantic match'
        }))
        .slice(0, 50) // Enforce max 50 files
    };
  } catch (error) {
    logger.debug({ error: (error as Error).message }, 'Failed to parse semantic scoring response');
    return { files: [] };
  }
}
