/**
 * Optimized context generation with iterative truncation.
 */

import { pack, type PackResult } from 'repomix';
import { ContextTokenLimitError } from './types.js';
import type { GenerateOptimizedContextOptions, RepomixPackConfig, SuspiciousFile } from './types.js';

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

export function buildCompactRepomixConfig(baseConfig: RepomixPackConfig): RepomixPackConfig {
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

interface SecurityAwarePackResult {
  result: PackResult;
  effectiveConfig: RepomixPackConfig;
  suspiciousFiles: SuspiciousFile[];
}

/**
 * Pack with security checking enabled until Repomix no longer reports new
 * suspicious files. Repomix filters suspicious bodies from each result; the
 * explicit safe include list also prevents later attempts from broadening the
 * scope and reintroducing them.
 */
export async function packWithSecurityExclusions(
  repoPath: string,
  baseConfig: RepomixPackConfig,
  onSuspiciousFiles?: (files: SuspiciousFile[]) => void,
): Promise<SecurityAwarePackResult> {
  let effectiveConfig: RepomixPackConfig = {
    ...baseConfig,
    security: {
      enableSecurityCheck: true,
    },
  };
  const excludedPaths = new Set<string>();
  const allSuspiciousFiles: SuspiciousFile[] = [];

  while (true) {
    const result = await pack([repoPath], effectiveConfig);
    const newlySuspiciousFiles = result.suspiciousFilesResults
      .filter(file => !excludedPaths.has(file.filePath))
      .map(file => ({ filePath: file.filePath, messages: file.messages || [] }));

    if (newlySuspiciousFiles.length === 0) {
      return { result, effectiveConfig, suspiciousFiles: allSuspiciousFiles };
    }

    onSuspiciousFiles?.(newlySuspiciousFiles);
    for (const file of newlySuspiciousFiles) {
      excludedPaths.add(file.filePath);
      allSuspiciousFiles.push(file);
    }

    effectiveConfig = {
      ...effectiveConfig,
      include: result.safeFilePaths,
      ignore: {
        ...effectiveConfig.ignore,
        customPatterns: [
          ...new Set([
            ...effectiveConfig.ignore.customPatterns,
            ...excludedPaths,
          ]),
        ],
      },
      security: {
        enableSecurityCheck: true,
      },
    };

    // The current result is already sanitized by Repomix. Avoid interpreting
    // an empty include list as "include the whole repository" on another pass.
    if (result.safeFilePaths.length === 0) {
      return { result, effectiveConfig, suspiciousFiles: allSuspiciousFiles };
    }
  }
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
  const { repoPath, initialFiles, baseConfig, tiktokenLimit, contextLogger, onSuspiciousFiles } = options;
  let currentFiles = [...initialFiles];
  let optimizedBaseConfig = buildCompactRepomixConfig(baseConfig);
  let result: PackResult | undefined;
  let iterations = 0;

  // Keep iterating until context fits or no files remain
  while (currentFiles.length > 0) {
    iterations++;
    const limitedConfig = { ...optimizedBaseConfig, include: currentFiles };
    const packed = await packWithSecurityExclusions(repoPath, limitedConfig, onSuspiciousFiles);
    result = packed.result;

    if (packed.suspiciousFiles.length > 0) {
      const suspiciousPaths = new Set(packed.suspiciousFiles.map(file => file.filePath));
      currentFiles = currentFiles.filter(file => !suspiciousPaths.has(file));
      optimizedBaseConfig = buildCompactRepomixConfig(packed.effectiveConfig);
    }

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
      throw new ContextTokenLimitError(result.totalTokens, tiktokenLimit);
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

  if (!result) {
    throw new Error('Context optimization completed without producing a Repomix result');
  }

  if (result.totalTokens > tiktokenLimit) {
    throw new ContextTokenLimitError(result.totalTokens, tiktokenLimit);
  }

  return { result, currentFiles };
}
