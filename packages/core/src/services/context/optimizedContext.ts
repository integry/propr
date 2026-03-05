/**
 * Optimized context generation with iterative truncation.
 */

import { pack } from 'repomix';
import type { GenerateOptimizedContextOptions } from './types.js';

export async function generateOptimizedContext(options: GenerateOptimizedContextOptions) {
  const { repoPath, initialFiles, baseConfig, tiktokenLimit, contextLogger, writeOutput, noopClipboard } = options;
  let currentFiles = [...initialFiles];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  let iterations = 0;

  // Keep iterating until context fits or no files remain
  while (currentFiles.length > 0) {
    iterations++;
    const limitedConfig = { ...baseConfig, include: currentFiles };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = await (pack as any)([repoPath], limitedConfig, () => {}, {
      writeOutputToDisk: writeOutput,
      copyToClipboardIfEnabled: noopClipboard,
    });

    if (result.totalTokens <= tiktokenLimit) {
      contextLogger.info(
        { iterations, totalTokens: result.totalTokens, tiktokenLimit, fileCount: currentFiles.length },
        'Context within token limit after truncation'
      );
      break;
    }

    // Still over limit - need to remove more files
    const overage = result.totalTokens - tiktokenLimit;
    contextLogger.warn(
      { iteration: iterations, totalTokens: result.totalTokens, tiktokenLimit, overage, fileCount: currentFiles.length },
      'Context still exceeds token limit, removing least relevant files'
    );

    // Files are ordered by relevance (most relevant first), so remove from the end
    // Remove a portion of files each iteration to progressively reduce context
    const fileTokensInResult = result.fileTokenCounts as Record<string, number>;

    // Calculate total tokens in files
    const totalFileTokens = currentFiles.reduce((sum, f) => sum + (fileTokensInResult[f] || 0), 0);

    // If overage is larger than total file tokens, we can't fix it by removing files alone
    // In that case, remove ~30% of files per iteration to make progress
    const tokensToFree = Math.min(overage * 1.1, totalFileTokens * 0.3);

    // Sort all files by a combined score of relevance (position) and size
    // Files at the end of the list are least relevant
    const filesWithScore = currentFiles.map((f, index) => ({
      path: f,
      tokens: fileTokensInResult[f] || 0,
      relevanceScore: currentFiles.length - index, // Higher = more relevant
    }));

    // Sort by: least relevant first, then by largest first within similar relevance
    filesWithScore.sort((a, b) => {
      // Primary: relevance (lower = remove first)
      const relevanceDiff = a.relevanceScore - b.relevanceScore;
      if (Math.abs(relevanceDiff) > currentFiles.length * 0.2) return relevanceDiff;
      // Secondary: size (larger = remove first to free more tokens)
      return b.tokens - a.tokens;
    });

    let tokensFreed = 0;
    const filesToRemove: string[] = [];

    for (const file of filesWithScore) {
      if (tokensFreed >= tokensToFree) break;
      filesToRemove.push(file.path);
      tokensFreed += file.tokens;
    }

    // Ensure we remove at least some files to make progress
    if (filesToRemove.length === 0 && currentFiles.length > 0) {
      // Remove at least the least relevant file
      filesToRemove.push(filesWithScore[0].path);
      tokensFreed = filesWithScore[0].tokens;
    }

    if (filesToRemove.length === 0) {
      contextLogger.warn({ currentFiles: currentFiles.length }, 'Cannot remove any more files, accepting current result');
      break;
    }

    contextLogger.info(
      { removingFiles: filesToRemove.length, tokensFreed, filesToRemove: filesToRemove.slice(0, 5) },
      'Removing least relevant files to fit within token limit'
    );

    const removeSet = new Set(filesToRemove);
    currentFiles = currentFiles.filter(f => !removeSet.has(f));
  }

  if (currentFiles.length === 0) {
    contextLogger.warn('All files removed, running final pack with empty file list');
    // Run one final pack with no files to get minimal context (just XML structure)
    const emptyConfig = { ...baseConfig, include: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = await (pack as any)([repoPath], emptyConfig, () => {}, {
      writeOutputToDisk: writeOutput,
      copyToClipboardIfEnabled: noopClipboard,
    });
    contextLogger.info(
      { totalTokens: result.totalTokens, tiktokenLimit },
      'Generated minimal context with no files'
    );
  }

  return { result, currentFiles };
}
