/**
 * Main context generation using repomix.
 */

import type { Logger } from 'pino';
import type { PackResult } from 'repomix';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { TIKTOKEN_TO_CLAUDE_RATIO } from '../../config/modelLimits.js';
import { generateOptimizedContext, packWithSecurityExclusions } from './optimizedContext.js';
import type { ContextGenerationOptions, ContextGenerationResult, RepomixPackConfig, SuspiciousFile } from './types.js';
import { ContextTokenLimitError, SecurityException } from './types.js';

const TEMP_OUTPUT_PREFIX = 'propr-repomix-';
const STALE_TEMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Get the token ratio for converting between tiktoken and actual model tokens.
 * - OpenAI/Codex: 1.0 (tiktoken is their tokenizer, so it's accurate)
 * - Gemini: 1.1 (close to tiktoken but slightly higher)
 * - Claude: 1.36 (tiktoken significantly underestimates)
 */
function getTokenRatio(modelId?: string): number {
  const modelLower = modelId?.toLowerCase() || '';
  if (modelLower.includes('gpt-') || modelLower.includes('codex') || modelLower.includes('openai')) {
    return 1.0;
  }
  if (modelLower.includes('gemini')) {
    return 1.1;
  }
  return TIKTOKEN_TO_CLAUDE_RATIO; // Default to Claude ratio
}

/**
 * Determine which files to use for optimization, ordered by priority.
 */
function getFilesForOptimization(
  filesToInclude: string[] | undefined,
  priorityFiles: string[] | undefined,
  fileTokenCounts: Record<string, number> | undefined,
): string[] {
  if (filesToInclude && filesToInclude.length > 0) {
    return filesToInclude;
  }
  const allPackedFiles = Object.keys(fileTokenCounts || {});
  if (priorityFiles && priorityFiles.length > 0) {
    const prioritySet = new Set(priorityFiles);
    const priorityOrdered = priorityFiles.filter(f => allPackedFiles.includes(f));
    const nonPriority = allPackedFiles.filter(f => !prioritySet.has(f));
    return [...priorityOrdered, ...nonPriority];
  }
  return allPackedFiles;
}

async function cleanupStaleOutputDirectories(contextLogger: Pick<Logger, 'debug' | 'warn'>): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch (error) {
    contextLogger.warn({ error: (error as Error).message }, 'Unable to inspect stale Repomix output directories');
    return;
  }

  const staleBefore = Date.now() - STALE_TEMP_OUTPUT_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_OUTPUT_PREFIX)) {
      continue;
    }

    const directoryPath = path.join(tmpdir(), entry.name);
    try {
      const stats = await lstat(directoryPath);
      if (stats.mtimeMs < staleBefore) {
        await rm(directoryPath, { recursive: true, force: true });
        contextLogger.debug({ directoryPath }, 'Removed stale Repomix output directory');
      }
    } catch (error) {
      contextLogger.warn(
        { directoryPath, error: (error as Error).message },
        'Unable to remove stale Repomix output directory',
      );
    }
  }
}

function getSuspiciousFilesFromError(error: unknown): SuspiciousFile[] {
  if (typeof error !== 'object' || error === null || !('suspiciousFilesResults' in error)) {
    return [];
  }

  const results = (error as { suspiciousFilesResults?: unknown }).suspiciousFilesResults;
  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((file): SuspiciousFile[] => {
    if (typeof file !== 'object' || file === null || !('filePath' in file) || typeof file.filePath !== 'string') {
      return [];
    }
    const messages = 'messages' in file && Array.isArray(file.messages)
      ? file.messages.filter((message: unknown): message is string => typeof message === 'string')
      : [];
    return [{ filePath: file.filePath, messages }];
  });
}

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, priorityFiles, tokenLimit, correlationId, includeFullDirectoryStructure = true, compress = false, modelId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Convert model token limit to tiktoken limit based on model type
  const tokenRatio = getTokenRatio(modelId);
  const tiktokenLimit = Math.floor(tokenLimit / tokenRatio);

  correlatedLogger.info({ repoPath, filesToInclude, tokenLimit, tiktokenLimit, compress }, 'Starting context generation with repomix');

  await cleanupStaleOutputDirectories(correlatedLogger);
  const outputDirectory = await mkdtemp(path.join(tmpdir(), TEMP_OUTPUT_PREFIX));
  const outputFilePath = path.join(outputDirectory, 'repomix-output.xml');

  const config: RepomixPackConfig = {
    cwd: repoPath,
    input: {
      maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    output: {
      filePath: outputFilePath,
      style: 'xml' as const,
      filePathStyle: 'target-relative' as const,
      parsableStyle: true,
      fileSummary: true,
      directoryStructure: true,
      files: true,
      removeComments: false,
      removeEmptyLines: false,
      compress: compress,
      topFilesLength: 10,
      showLineNumbers: false,
      truncateBase64: true,
      copyToClipboard: false,
      includeFullDirectoryStructure: includeFullDirectoryStructure,
      // Must be true to get fileTokenCounts for ALL files, not just top 100
      tokenCountTree: true,
      git: {
        sortByChanges: false,
        sortByChangesMaxCommits: 100,
        includeDiffs: false,
        includeLogs: false,
        includeLogsCount: 10,
      },
    },
    include: filesToInclude || [],
    ignore: {
      useGitignore: true,
      useDotIgnore: true,
      useDefaultPatterns: true,
      customPatterns: ['.git', 'node_modules'],
    },
    security: {
      enableSecurityCheck: true,
    },
    tokenCount: {
      encoding: 'cl100k_base',
    },
  };

  const skippedSecurityFiles = new Map<string, SuspiciousFile>();
  const recordSuspiciousFiles = (files: SuspiciousFile[]): void => {
    const newlySkippedFiles = files.filter(file => !skippedSecurityFiles.has(file.filePath));
    for (const file of files) {
      skippedSecurityFiles.set(file.filePath, file);
    }
    if (newlySkippedFiles.length === 0) {
      return;
    }

    correlatedLogger.warn(
      {
        suspiciousFilesCount: newlySkippedFiles.length,
        files: newlySkippedFiles.slice(0, 5).map(file => file.filePath),
      },
      'Suspicious files detected during context generation - excluding them',
    );
  };

  try {
    // Restrict repository content even on hosts with a permissive process umask.
    await chmod(outputDirectory, 0o700);

    const initialPack = await packWithSecurityExclusions(repoPath, config, recordSuspiciousFiles);
    let result: PackResult = initialPack.result;
    const effectiveConfig = initialPack.effectiveConfig;

    // Check if result exceeds token limit and needs truncation
    if (result.totalTokens > tiktokenLimit) {
      const filesForOptimization = getFilesForOptimization(
        filesToInclude && filesToInclude.length > 0 ? effectiveConfig.include : undefined,
        priorityFiles,
        result.fileTokenCounts,
      );

      if (filesForOptimization.length > 0) {
        correlatedLogger.info(
          { totalTokens: result.totalTokens, tiktokenLimit, fileCount: filesForOptimization.length, hadExplicitFiles: !!(filesToInclude && filesToInclude.length > 0) },
          'Initial context exceeds token limit, applying iterative truncation'
        );

        // Use optimized context generation with iterative truncation
        const optimizedResult = await generateOptimizedContext({
          repoPath,
          initialFiles: filesForOptimization,
          baseConfig: effectiveConfig,
          tiktokenLimit,
          contextLogger: correlatedLogger,
          onSuspiciousFiles: recordSuspiciousFiles,
        });

        result = optimizedResult.result;

        correlatedLogger.info(
          {
            originalFiles: filesForOptimization.length,
            finalFiles: optimizedResult.currentFiles.length,
            totalTokens: result.totalTokens,
            tiktokenLimit
          },
          'Context truncation completed'
        );
      }
    }

    if (result.totalTokens > tiktokenLimit) {
      throw new ContextTokenLimitError(result.totalTokens, tiktokenLimit);
    }

    // Read only the final successful pack so the returned output and metrics
    // always describe the same attempt.
    const capturedOutput = await readFile(outputFilePath, 'utf8');

    correlatedLogger.info(
      { totalFiles: result.totalFiles, totalCharacters: result.totalCharacters, totalTokens: result.totalTokens },
      'Repomix context generation completed'
    );

    return {
      context: capturedOutput,
      totalFiles: result.totalFiles,
      totalCharacters: result.totalCharacters,
      totalTokens: result.totalTokens,
      fileCharCounts: result.fileCharCounts,
      fileTokenCounts: result.fileTokenCounts,
      includedFiles: Object.keys(result.fileTokenCounts || {}),
      skippedSecurityFiles: skippedSecurityFiles.size > 0
        ? [...skippedSecurityFiles.values()]
        : undefined,
    };
  } catch (error) {
    // Check if repomix threw a security exception
    const suspiciousFiles = getSuspiciousFilesFromError(error);
    if (suspiciousFiles.length > 0) {
      correlatedLogger.error(
        { suspiciousFilesCount: suspiciousFiles.length, files: suspiciousFiles.map(f => f.filePath) },
        'Security check failed: suspicious files detected'
      );

      throw new SecurityException(
        `Security check failed: ${suspiciousFiles.length} file(s) contain potential secrets`,
        suspiciousFiles
      );
    }

    correlatedLogger.error({ error: (error as Error).message }, 'Failed to generate context with repomix');
    throw error;
  } finally {
    try {
      await rm(outputDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      correlatedLogger.warn(
        { outputDirectory, error: (cleanupError as Error).message },
        'Failed to clean up Repomix output directory',
      );
    }
  }
}
