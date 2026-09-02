import logger from '../../utils/logger.js';
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

export function parseBatchResponse(response: string, expectedPaths?: string[]): SummaryResult[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in batch response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summaries: SummaryResult[] };
    if (!Array.isArray(parsed.summaries)) {
      logger.warn('Invalid summaries format in response');
      return [];
    }

    return parsed.summaries
      .filter(summary => typeof summary.path === 'string' && typeof summary.summary === 'string'
        && summary.path.trim().length > 0 && summary.summary.trim().length > 0)
      .map(summary => {
        const expectedPath = expectedPaths
          ? resolveExpectedSummaryPath(summary.path, expectedPaths)
          : summary.path.trim();
        return expectedPath ? { path: expectedPath, summary: summary.summary.trim() } : null;
      })
      .filter((summary): summary is SummaryResult => summary !== null);
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to parse batch response');
    return [];
  }
}
