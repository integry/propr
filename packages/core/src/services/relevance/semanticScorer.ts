import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { loadFileSummaries, loadDirectorySummaries, FileSummaryRow, DirectorySummaryRow } from './contextBuilder.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions.js';

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
  /** Branch to filter summaries (e.g., "HEAD", "main", "dev") */
  branch?: string;
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

/** Default maximum tokens per chunk (conservative fallback) */
const DEFAULT_MAX_CHUNK_TOKENS = 30000;

/**
 * Percentage of model context window to use for chunks.
 * We use 60% to leave room for the prompt template and output.
 */
const CHUNK_CONTEXT_RATIO = 0.6;

/**
 * Gets the maximum tokens per chunk based on the model's context window.
 * For models with large context windows (e.g., Gemini 1M), this allows
 * fitting the entire codebase summary in a single chunk.
 */
function getMaxChunkTokens(modelId?: string): number {
  if (!modelId) {
    return DEFAULT_MAX_CHUNK_TOKENS;
  }

  // Handle agent:model format (e.g., 'gemini:gemini-2.5-flash')
  const effectiveModelId = modelId.includes(':') ? modelId.split(':')[1] : modelId;
  const modelInfo = MODEL_INFO_MAP[effectiveModelId];

  if (modelInfo?.maxTokens) {
    // Use 60% of the model's context window for chunks
    return Math.floor(modelInfo.maxTokens * CHUNK_CONTEXT_RATIO);
  }

  return DEFAULT_MAX_CHUNK_TOKENS;
}

// --- Main Export ---

/**
 * Uses AI-generated summaries to semantically score files based on the user's request.
 *
 * This function handles large repositories by processing summaries in chunks:
 * 1. Loads ALL file and directory summaries from the database
 * 2. Splits summaries into chunks that fit within token limits
 * 3. Queries the LLM for each chunk to identify relevant files
 * 4. Aggregates and deduplicates results across all chunks
 */
export async function scoreSemanticRelevance(
  userPrompt: string,
  options: SemanticScoringOptions
): Promise<SemanticFileScore[]> {
  const { agent, correlationId, repoName, branch, modelId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  try {
    // 1. Load ALL summaries from the database
    let fileSummaries = await loadFileSummaries();
    let dirSummaries = await loadDirectorySummaries();

    // Filter by repository and branch if specified
    if (repoName) {
      const repoPrefix = repoName + '/';
      // Try specified branch first, fall back to HEAD if no results
      const targetBranch = branch || 'HEAD';

      let filteredFiles = fileSummaries
        .filter((f: FileSummaryRow) => f.path.startsWith(repoPrefix) && f.branch === targetBranch);
      let filteredDirs = dirSummaries
        .filter((d: DirectorySummaryRow) => d.path.startsWith(repoPrefix) && d.branch === targetBranch);

      // If no results for specified branch and it's not HEAD, try HEAD as fallback
      if (filteredFiles.length === 0 && filteredDirs.length === 0 && targetBranch !== 'HEAD') {
        correlatedLogger.debug({ targetBranch }, 'No summaries for branch, falling back to HEAD');
        filteredFiles = fileSummaries
          .filter((f: FileSummaryRow) => f.path.startsWith(repoPrefix) && f.branch === 'HEAD');
        filteredDirs = dirSummaries
          .filter((d: DirectorySummaryRow) => d.path.startsWith(repoPrefix) && d.branch === 'HEAD');
      }

      fileSummaries = filteredFiles
        .map((f: FileSummaryRow) => ({ ...f, path: f.path.slice(repoPrefix.length) }));
      dirSummaries = filteredDirs
        .map((d: DirectorySummaryRow) => ({ ...d, path: d.path.slice(repoPrefix.length) }));
    }

    if (fileSummaries.length === 0 && dirSummaries.length === 0) {
      correlatedLogger.debug('No summaries found, skipping semantic scoring');
      return [];
    }

    // 2. Prepare summary items for chunking
    const allItems: string[] = [
      ...dirSummaries.map((d: DirectorySummaryRow) => `DIR ${d.path}/: ${d.summary}`),
      ...fileSummaries.map((f: FileSummaryRow) => `FILE ${f.path}: ${f.summary}`)
    ];

    // 3. Split into chunks that fit within model's token budget
    const chunks: string[] = [];
    let currentChunk = '';
    const maxChunkTokens = getMaxChunkTokens(modelId);
    const maxChunkChars = maxChunkTokens * CHARS_PER_TOKEN_ESTIMATE;

    for (const item of allItems) {
      if ((currentChunk.length + item.length + 1) > maxChunkChars && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      currentChunk += item + '\n';
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    correlatedLogger.info({
      chunkCount: chunks.length,
      totalItems: allItems.length,
      fileSummaryCount: fileSummaries.length,
      dirSummaryCount: dirSummaries.length,
      maxChunkTokens,
      modelId: modelId || 'default'
    }, 'Processing semantic scoring in chunks');

    // 4. Process each chunk in parallel
    const startTime = Date.now();
    const chunkPromises = chunks.map(async (chunkContext, index) => {
      const prompt = buildSemanticRankingPrompt(userPrompt, chunkContext);
      const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
      const estimatedOutputTokens = 500;

      try {
        // Pass modelId to use the configured context analysis model
        const response = await agent.analyze(prompt, undefined, modelId);
        const parsed = parseSemanticResponse(response);

        // Log metrics for this chunk
        await logSummarizationCall({
          timestamp: new Date().toISOString(),
          callType: 'semantic_scoring',
          model: modelId || agent.config.defaultModel || 'haiku',
          agentAlias: agent.config.alias,
          estimatedInputTokens,
          estimatedOutputTokens,
          estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
          success: true,
          durationMs: Date.now() - startTime,
          error: undefined
        }, correlatedLogger);

        return parsed.files;
      } catch (err) {
        correlatedLogger.warn({
          chunkIndex: index,
          error: (err as Error).message
        }, 'Failed to score chunk');

        await logSummarizationCall({
          timestamp: new Date().toISOString(),
          callType: 'semantic_scoring',
          model: modelId || agent.config.defaultModel || 'haiku',
          agentAlias: agent.config.alias,
          estimatedInputTokens,
          estimatedOutputTokens,
          estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
          success: false,
          durationMs: Date.now() - startTime,
          error: (err as Error).message
        }, correlatedLogger);

        return [];
      }
    });

    const results = await Promise.all(chunkPromises);

    // 5. Aggregate and deduplicate results (keep max score per file)
    const scoreMap = new Map<string, number>();
    const reasonMap = new Map<string, string>();

    // Flatten results from all chunks into a single array
    const allFiles = results.flat();

    for (const file of allFiles) {
      const existingScore = scoreMap.get(file.path) || 0;
      if (file.score > existingScore) {
        scoreMap.set(file.path, file.score);
        if (file.reason) {
          reasonMap.set(file.path, file.reason);
        }
      }
    }

    const scores: SemanticFileScore[] = Array.from(scoreMap.entries()).map(([path, score]) => ({
      path,
      score,
      reason: 'semantic' as const
    }));

    const durationMs = Date.now() - startTime;
    correlatedLogger.info({
      fileCount: scores.length,
      chunkCount: chunks.length,
      durationMs
    }, 'Chunked semantic scoring completed');

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
