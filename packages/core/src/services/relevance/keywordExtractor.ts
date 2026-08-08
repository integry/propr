import { parseLlmJson } from '../../utils/jsonUtils.js';
import { Agent } from '../../agents/types.js';
import logger from '../../utils/logger.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { loadSettings } from '../../config/configManager.js';
import { resolveContextAnalysisTimeoutMs } from './contextAnalysisConfig.js';

// --- Settings cache (avoids a DB round-trip on every LLM extraction call) ---

const SETTINGS_CACHE_TTL_MS = 30_000;
let _settingsCache: { value: Record<string, unknown>; expiresAt: number } | null = null;

async function getCachedSettings(): Promise<Record<string, unknown>> {
  if (_settingsCache && Date.now() < _settingsCache.expiresAt) {
    return _settingsCache.value;
  }
  const settings = await loadSettings().catch(() => ({} as Record<string, unknown>));
  _settingsCache = { value: settings as Record<string, unknown>, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return _settingsCache.value;
}

export function invalidateSettingsCache(): void {
  _settingsCache = null;
}

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
  'refactor', 'implement', 'bug', 'code', 'file', 'component', 'page',
  'hide', 'move', 'copy', 'paste', 'cut', 'save', 'load', 'open', 'close',
  'please', 'want', 'need', 'like', 'help', 'try', 'let', 'see', 'look'
]);

/** Minimum length for a keyword */
const MIN_KEYWORD_LENGTH = 2;
const LEADING_KEYWORD_DELIMITERS = new Set(['`', "'", '"', '(', '[', '{']);
const TRAILING_KEYWORD_DELIMITERS = new Set(['.', '`', "'", '"', ']', ')', '}', ',', ';', ':', '!', '?']);

function trimKeywordDelimiters(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && LEADING_KEYWORD_DELIMITERS.has(value[start])) start++;
  while (end > start && TRAILING_KEYWORD_DELIMITERS.has(value[end - 1])) end--;
  return value.slice(start, end);
}

function isFileTokenCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === '_' || char === '.' || char === '-' || char === '/';
}

function isFileLikeToken(token: string): boolean {
  if (!token) return false;
  if (token.includes('/')) {
    const segments = token.split('/');
    return segments.every(Boolean) && /[A-Za-z0-9_-]/.test(token[token.length - 1]);
  }
  if (!token.includes('.') || !/[A-Za-z0-9_]/.test(token[0])) return false;
  return token.split('.').every(segment => segment.length > 0 && !/[^A-Za-z0-9_-]/.test(segment));
}

function fileLikeTokens(prompt: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  for (let index = 0; index <= prompt.length; index++) {
    const isTokenCharacter = index < prompt.length && isFileTokenCharacter(prompt[index]);
    if (isTokenCharacter && start === -1) start = index;
    if (!isTokenCharacter && start !== -1) {
      const token = trimKeywordDelimiters(prompt.slice(start, index));
      if (isFileLikeToken(token)) tokens.push(token);
      start = -1;
    }
  }
  return tokens;
}

/**
 * Basic regex-based keyword extraction from a prompt.
 * Extracts meaningful words that might appear in file paths or names.
 */
export function extractKeywords(prompt: string): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  const addKeyword = (value: string, preserveCase = false): void => {
    const normalized = trimKeywordDelimiters(value);
    const comparison = normalized.toLowerCase();
    if (comparison.length < MIN_KEYWORD_LENGTH
        || STOP_WORDS.has(comparison)
        || /^\d+$/.test(comparison)
        || seen.has(comparison)) {
      return;
    }
    seen.add(comparison);
    keywords.push(preserveCase ? normalized : comparison);
  };

  // Paths and filenames carry the strongest signal. Preserve separators and
  // extensions so path scoring can perform exact and directory matches.
  for (const token of fileLikeTokens(prompt)) {
    addKeyword(token, true);
  }

  // Preserve source identifiers exactly for diagnostics and git searches,
  // while also adding their constituent words for broader path matching.
  for (const match of prompt.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/g)) {
    const token = match[0];
    const isStructuredIdentifier = token.includes('_') || /[a-z0-9][A-Z]/.test(token);
    if (!isStructuredIdentifier) continue;
    addKeyword(token, true);
    for (const part of token.replace(/_/g, ' ').split(/\s+|(?=[A-Z])/)) {
      addKeyword(part);
    }
  }

  // Finally retain ordinary technical terms and hyphenated identifiers.
  for (const match of prompt.matchAll(/\b[A-Za-z0-9][A-Za-z0-9_-]*\b/g)) {
    addKeyword(match[0]);
  }

  return keywords;
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
  const cachedSettings = await getCachedSettings();

  try {
    const llmPrompt = KEYWORD_EXTRACTION_PROMPT.replace('{USER_REQUEST}', prompt);

    const contextModel = (cachedSettings.planner_context_model as string | undefined) || undefined;

    correlatedLogger.debug({ promptLength: prompt.length, model: contextModel }, 'Extracting keywords with LLM');

    const analysisResult = await agent.analyze(llmPrompt, {
      ...(contextModel ? { model: contextModel } : {}),
      timeoutMs: resolveContextAnalysisTimeoutMs(),
      executionType: 'context-analysis',
      correlationId,
      metadata: { callType: 'keyword_extraction' },
      suppressLlmLog: true
    });
    if (!analysisResult.success) {
      throw new Error(analysisResult.error || 'Context keyword analysis failed');
    }
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
    const modelUsed = cachedSettings.planner_context_model as string || agent.config.defaultModel || 'unknown';

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
