import { parseLlmJson } from '../../utils/jsonUtils.js';
import { Agent } from '../../agents/types.js';
import logger from '../../utils/logger.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { loadSettings } from '../../config/configManager.js';

// --- Basic Keyword Extraction (regex-based) ---

/** Words to filter out during keyword extraction */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'also', 'now', 'here', 'there', 'then', 'once', 'always', 'never',
  // Common action words that don't help file matching
  'add', 'remove', 'change', 'update', 'fix', 'modify', 'edit', 'create',
  'delete', 'replace', 'make', 'set', 'get', 'put', 'use', 'find', 'show',
  'hide', 'move', 'copy', 'paste', 'cut', 'save', 'load', 'open', 'close',
  'please', 'want', 'need', 'like', 'help', 'try', 'let', 'see', 'look'
]);

/** Minimum length for a keyword */
const MIN_KEYWORD_LENGTH = 2;

/**
 * Basic regex-based keyword extraction from a prompt.
 * Extracts meaningful words that might appear in file paths or names.
 */
export function extractKeywords(prompt: string): string[] {
  // Extract words, including hyphenated and underscored terms
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(word =>
      word.length >= MIN_KEYWORD_LENGTH &&
      !STOP_WORDS.has(word) &&
      !/^\d+$/.test(word) // Exclude pure numbers
    );

  // Also extract camelCase and PascalCase parts
  const camelCaseWords: string[] = [];
  for (const word of prompt.match(/[a-zA-Z][a-z]+/g) || []) {
    const lower = word.toLowerCase();
    if (lower.length >= MIN_KEYWORD_LENGTH && !STOP_WORDS.has(lower)) {
      camelCaseWords.push(lower);
    }
  }

  // Deduplicate and return
  return [...new Set([...words, ...camelCaseWords])];
}

// --- LLM-based Keyword Extraction ---

export interface ExtractedKeywords {
  /** Primary keywords extracted from the prompt */
  primary: string[];
  /** Alternative spellings and related terms */
  alternatives: string[];
  /** All keywords combined (primary + alternatives) */
  all: string[];
}

export interface KeywordExtractionOptions {
  /** Agent to use for LLM calls */
  agent: Agent;
  correlationId?: string;
}

const KEYWORD_EXTRACTION_PROMPT = `Extract the most relevant keywords from the user's request for finding files in a codebase.

Rules:
1. Focus on technical terms, file names, component names, feature names
2. Include spelling alternatives (singular/plural, different cases, abbreviations)
3. Include related technical terms that might appear in filenames
4. Ignore common words like "the", "and", "replace", "change", "update"
5. Return 3-8 primary keywords and 5-15 alternatives

User request:
{USER_REQUEST}

Return ONLY a JSON object in this exact format:
{
  "primary": ["keyword1", "keyword2"],
  "alternatives": ["alt1", "alt2", "related1"]
}`;

/**
 * Extracts relevant keywords and alternatives from a user prompt using an LLM.
 * This helps improve file matching by understanding the user's intent.
 */
export async function extractKeywordsWithLLM(
  prompt: string,
  options: KeywordExtractionOptions
): Promise<ExtractedKeywords> {
  const { agent, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const startTime = Date.now();
  let success = false;
  let errorMessage: string | undefined;

  try {
    const llmPrompt = KEYWORD_EXTRACTION_PROMPT.replace('{USER_REQUEST}', prompt);

    // Load configured context analysis model
    const settings = await loadSettings();
    const contextModel = settings.planner_context_model as string | undefined;

    correlatedLogger.debug({ promptLength: prompt.length, model: contextModel }, 'Extracting keywords with LLM');

    const analysisResult = await agent.analyze(llmPrompt, { model: contextModel });
    const response = analysisResult.response;

    const parsed = parseLlmJson<{ primary: string[]; alternatives: string[] }>(response);

    if (!parsed || !Array.isArray(parsed.primary)) {
      correlatedLogger.warn({ response }, 'Invalid LLM response for keyword extraction');
      return { primary: [], alternatives: [], all: [] };
    }

    const primary = parsed.primary
      .filter((k): k is string => typeof k === 'string')
      .map(k => k.toLowerCase().trim())
      .filter(k => k.length > 0);

    const alternatives = (parsed.alternatives || [])
      .filter((k): k is string => typeof k === 'string')
      .map(k => k.toLowerCase().trim())
      .filter(k => k.length > 0);

    const all = [...new Set([...primary, ...alternatives])];

    success = true;
    correlatedLogger.info({
      primaryCount: primary.length,
      alternativesCount: alternatives.length,
      primary: primary.slice(0, 5),
      alternatives: alternatives.slice(0, 5)
    }, 'LLM keyword extraction completed');

    return { primary, alternatives, all };
  } catch (error) {
    errorMessage = (error as Error).message;
    correlatedLogger.warn(
      { error: errorMessage },
      'LLM keyword extraction failed, falling back to basic extraction'
    );
    return { primary: [], alternatives: [], all: [] };
  } finally {
    const durationMs = Date.now() - startTime;
    // Use the configured context model or fall back to agent default
    const settings = await loadSettings().catch(() => ({}));
    const modelUsed = (settings as Record<string, unknown>).planner_context_model as string || agent.config.defaultModel || 'unknown';

    // Persist to llm_logs table
    const logEntry = createLlmLogFromAnalysis({
      executionType: 'context-analysis',
      modelUsed,
      executionTimeMs: durationMs,
      success,
      error: errorMessage,
      correlationId,
      agentAlias: agent.config.alias,
      metadata: { callType: 'keyword_extraction' },
      workRef: {
        workType: 'repository',
      },
    });
    await persistLlmLog(logEntry);
  }
}

/**
 * Merges LLM-extracted keywords with basic regex-extracted keywords.
 */
export function mergeKeywords(
  basicKeywords: string[],
  llmKeywords: ExtractedKeywords
): string[] {
  const merged = new Set<string>();

  // Add basic keywords
  for (const k of basicKeywords) {
    merged.add(k.toLowerCase());
  }

  // Add LLM keywords (prioritize primary)
  for (const k of llmKeywords.primary) {
    merged.add(k);
  }

  // Add alternatives
  for (const k of llmKeywords.alternatives) {
    merged.add(k);
  }

  return Array.from(merged);
}
