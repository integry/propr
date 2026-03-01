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
  const maxIterations = 10;

  while (iterations < maxIterations) {
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
      'Context still exceeds token limit, removing largest files'
    );

    // Remove the largest files (by token count) until we have enough headroom
    const fileTokensInResult = result.fileTokenCounts as Record<string, number>;
    const sortedBySize = currentFiles
      .map(f => ({ path: f, tokens: fileTokensInResult[f] || 0 }))
      .sort((a, b) => b.tokens - a.tokens); // Largest first

    // Remove files until we've freed enough tokens (with 10% buffer for overhead)
    const tokensToFree = overage * 1.1;
    let tokensFreed = 0;
    const filesToRemove: string[] = [];

    for (const file of sortedBySize) {
      if (tokensFreed >= tokensToFree) break;
      filesToRemove.push(file.path);
      tokensFreed += file.tokens;
    }

    if (filesToRemove.length === 0) {
      contextLogger.warn({ currentFiles: currentFiles.length }, 'Cannot remove any more files, accepting current result');
      break;
    }

    contextLogger.info(
      { removingFiles: filesToRemove.length, tokensFreed, filesToRemove: filesToRemove.slice(0, 5) },
      'Removing files to fit within token limit'
    );

    const removeSet = new Set(filesToRemove);
    currentFiles = currentFiles.filter(f => !removeSet.has(f));

    if (currentFiles.length === 0) {
      contextLogger.warn('All files removed, cannot generate context within limit');
      break;
    }
  }

  if (iterations >= maxIterations) {
    contextLogger.warn({ maxIterations }, 'Max iterations reached while trying to fit within token limit');
  }

  return { result, currentFiles };
}
