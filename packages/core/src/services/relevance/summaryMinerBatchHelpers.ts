import logger from '../../utils/logger.js';
import { extractJsonCandidates } from '../../utils/jsonUtils.js';
import { resolveExpectedSummaryPath } from './summaryMinerDirectoryHelpers.js';
import type { SummaryResult } from './summaryMinerBatchPersistence.js';

export interface BatchFile {
  path: string;
  content: string;
  blobHash: string;
}

export const DEFAULT_INSTRUCTIONS = `You are a code expert. Analyze the following source code files.
For each file, provide a summary (3-4 sentences) covering:
1. Primary purpose of the file
2. Key functions, classes, or exports it provides
3. What other parts of the system it interacts with or depends on`;

const JSON_FORMAT_RULES = `Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "relative/path/to/file", "summary": "This file handles... It provides... It interacts with..." }
  ]
}

Important:
- Include ALL files listed below in your response
- Each summary should be 3-4 sentences with specific details
- Mention key function/class names when relevant
- Focus on what the file does and how it connects to the system
- Return valid JSON only, no markdown or other formatting`;

export function buildBatchPrompt(batch: BatchFile[], customPrompt?: string): string {
  const filesContent = batch.map(file =>
    `--- START ${file.path} ---\n${file.content}\n--- END ${file.path} ---`
  ).join('\n\n');
  const instructions = customPrompt && customPrompt.trim().length > 0
    ? customPrompt
    : DEFAULT_INSTRUCTIONS;

  return `${instructions}

${JSON_FORMAT_RULES}

FILES:
${filesContent}`;
}

/**
 * Collects the summary entries of a parsed candidate, unwrapping the array
 * wrappers (`[{ "summaries": [...] }]`) some agents emit around the envelope.
 */
function collectSummaryEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed.flatMap(entry => collectSummaryEntries(entry));
  const summaries = (parsed as { summaries?: unknown } | null)?.summaries;
  return Array.isArray(summaries) ? summaries : [];
}

export function parseBatchResponse(response: string, expectedPaths?: string[]): SummaryResult[] {
  // Some agents (seen with Antigravity/Gemini) emit the whole JSON document
  // twice back to back, so parse each balanced JSON value instead of matching
  // greedily from the first `{` to the last `}`.
  const candidates = extractJsonCandidates(response).filter(candidate => candidate.includes('"summaries"'));
  if (candidates.length === 0) {
    logger.warn('No JSON found in batch response');
    return [];
  }

  const results = new Map<string, SummaryResult>();
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastError = error as Error;
      continue;
    }
    const entries = collectSummaryEntries(parsed);
    if (entries.length === 0) continue;

    for (const summary of entries as SummaryResult[]) {
      if (typeof summary?.path !== 'string' || typeof summary.summary !== 'string'
        || summary.path.trim().length === 0 || summary.summary.trim().length === 0) continue;
      const expectedPath = expectedPaths
        ? resolveExpectedSummaryPath(summary.path, expectedPaths)
        : summary.path.trim();
      if (expectedPath && !results.has(expectedPath)) {
        results.set(expectedPath, { path: expectedPath, summary: summary.summary.trim() });
      }
    }
  }

  if (results.size === 0) {
    if (lastError) logger.warn({ error: lastError.message }, 'Failed to parse batch response');
    else logger.warn('Invalid summaries format in response');
  }
  return [...results.values()];
}
