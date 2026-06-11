/**
 * Optimized context generation with iterative truncation.
 */

import { pack } from 'repomix';
import type { GenerateOptimizedContextOptions } from './types.js';

interface FileRemovalPlan {
  filesToRemove: string[];
  tokensFreed: number;
  nonFileTokens: number;
  targetFileTokens: number;
  estimatedRemainingTokens: number;
}

const FILE_TOKEN_BUDGET_SAFETY_RATIO = 0.98;
const CONTEXT_FILL_STOP_RATIO = 0.99;
const MIN_FIXED_OVERHEAD_TOKENS = 2_000;
const FIXED_OVERHEAD_LIMIT_RATIO = 0.05;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildCompactRepomixConfig(baseConfig: any) {
  return {
    ...baseConfig,
    output: {
      ...baseConfig.output,
      fileSummary: false,
      directoryStructure: false,
      includeFullDirectoryStructure: false,
      topFilesLength: 0,
    },
  };
}

export function planFilesToRemoveForTokenLimit(
  currentFiles: string[],
  fileTokenCounts: Record<string, number>,
  totalTokens: number,
  tiktokenLimit: number,
): FileRemovalPlan {
  const filesWithTokens = currentFiles.map(path => ({
    path,
    tokens: fileTokenCounts[path] || 0,
  }));
  const rawFileTokens = filesWithTokens.reduce((sum, file) => sum + file.tokens, 0);
  const rawNonFileTokens = Math.max(0, totalTokens - rawFileTokens);
  if (rawFileTokens === 0 && totalTokens > tiktokenLimit && filesWithTokens.length > 0) {
    const leastRelevantFile = filesWithTokens[filesWithTokens.length - 1];
    return {
      filesToRemove: [leastRelevantFile.path],
      tokensFreed: 0,
      nonFileTokens: totalTokens,
      targetFileTokens: 0,
      estimatedRemainingTokens: totalTokens,
    };
  }

  const fixedOverheadLimit = Math.max(
    MIN_FIXED_OVERHEAD_TOKENS,
    Math.floor(tiktokenLimit * FIXED_OVERHEAD_LIMIT_RATIO),
  );
  const nonFileTokens = Math.min(rawNonFileTokens, fixedOverheadLimit);
  const formattedFileTokens = rawFileTokens + Math.max(0, rawNonFileTokens - nonFileTokens);
  const fileTokenScale = rawFileTokens > 0 ? formattedFileTokens / rawFileTokens : 1;
  const filesWithEffectiveTokens = filesWithTokens.map(file => ({
    ...file,
    effectiveTokens: Math.ceil(file.tokens * fileTokenScale),
  }));
  const targetFileTokens = Math.max(
    0,
    Math.floor((tiktokenLimit - nonFileTokens) * FILE_TOKEN_BUDGET_SAFETY_RATIO),
  );

  const keptFiles = new Set<string>();
  let keptTokens = 0;
  const stopAtTokens = Math.floor(targetFileTokens * CONTEXT_FILL_STOP_RATIO);
  for (const file of filesWithEffectiveTokens) {
    if (keptTokens >= stopAtTokens) {
      break;
    }
    if (keptTokens + file.effectiveTokens <= targetFileTokens) {
      keptFiles.add(file.path);
      keptTokens += file.effectiveTokens;
    }
  }

  let filesToRemove = filesWithEffectiveTokens
    .filter(file => !keptFiles.has(file.path))
    .map(file => file.path);
  let tokensFreed = filesWithEffectiveTokens
    .filter(file => !keptFiles.has(file.path))
    .reduce((sum, file) => sum + file.effectiveTokens, 0);

  if (filesToRemove.length === 0 && totalTokens > tiktokenLimit && filesWithEffectiveTokens.length > 0) {
    const leastRelevantFile = filesWithEffectiveTokens[filesWithEffectiveTokens.length - 1];
    filesToRemove = [leastRelevantFile.path];
    tokensFreed = leastRelevantFile.effectiveTokens;
    keptTokens = Math.max(0, keptTokens - leastRelevantFile.effectiveTokens);
  }

  return {
    filesToRemove,
    tokensFreed,
    nonFileTokens,
    targetFileTokens,
    estimatedRemainingTokens: nonFileTokens + keptTokens,
  };
}

export async function generateOptimizedContext(options: GenerateOptimizedContextOptions) {
  const { repoPath, initialFiles, baseConfig, tiktokenLimit, contextLogger, writeOutput, noopClipboard } = options;
  let currentFiles = [...initialFiles];
  const optimizedBaseConfig = buildCompactRepomixConfig(baseConfig);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  let iterations = 0;

  // Keep iterating until context fits or no files remain
  while (currentFiles.length > 0) {
    iterations++;
    const limitedConfig = { ...optimizedBaseConfig, include: currentFiles };
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

    const fileTokensInResult = result.fileTokenCounts as Record<string, number>;
    const removalPlan = planFilesToRemoveForTokenLimit(currentFiles, fileTokensInResult, result.totalTokens, tiktokenLimit);
    const { filesToRemove, tokensFreed } = removalPlan;

    if (filesToRemove.length === 0) {
      contextLogger.warn({ currentFiles: currentFiles.length }, 'Cannot remove any more files, accepting current result');
      break;
    }

    contextLogger.info(
      {
        removingFiles: filesToRemove.length,
        tokensFreed,
        nonFileTokens: removalPlan.nonFileTokens,
        targetFileTokens: removalPlan.targetFileTokens,
        estimatedRemainingTokens: removalPlan.estimatedRemainingTokens,
        filesToRemove: filesToRemove.slice(0, 5),
      },
      'Removing least relevant files to fit within token limit'
    );

    const removeSet = new Set(filesToRemove);
    currentFiles = currentFiles.filter(f => !removeSet.has(f));
  }

  if (currentFiles.length === 0) {
    contextLogger.warn({ initialFiles: initialFiles.length }, 'All files removed after compact context reduction');
    if (initialFiles.length > 0) {
      const fallbackFiles = [initialFiles[0]];
      contextLogger.warn({ fallbackFiles }, 'Retrying with the highest-priority file instead of returning empty context');
      const fallbackConfig = { ...optimizedBaseConfig, include: fallbackFiles };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (pack as any)([repoPath], fallbackConfig, () => {}, {
        writeOutputToDisk: writeOutput,
        copyToClipboardIfEnabled: noopClipboard,
      });
      currentFiles = fallbackFiles;
    }
  }

  return { result, currentFiles };
}
