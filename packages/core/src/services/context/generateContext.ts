/**
 * Main context generation using repomix.
 */

import type { Logger } from 'pino';
import type { PackResult } from 'repomix';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { TIKTOKEN_TO_CLAUDE_RATIO } from '../../config/modelLimits.js';
import {
  filterExplicitFilesByPackedPaths,
  generateOptimizedContext,
  packWithSecurityExclusions,
} from './optimizedContext.js';
import type { ContextGenerationOptions, ContextGenerationResult, RepomixPackConfig, SuspiciousFile } from './types.js';
import { ContextTokenLimitError, SecurityException } from './types.js';

const TEMP_OUTPUT_PREFIX = 'propr-repomix-';
const OWNERSHIP_MARKER_NAME = '.owner.json';

interface OutputDirectoryOwner {
  pid: number;
  requestId: string;
  createdAt: string;
  state: 'active' | 'completed';
  completedAt?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function finalizeOutputDirectory(
  outputDirectory: string,
  owner: OutputDirectoryOwner,
  contextLogger: Pick<Logger, 'error' | 'warn'>,
): Promise<void> {
  const completedAt = new Date().toISOString();
  try {
    await writeFile(path.join(outputDirectory, OWNERSHIP_MARKER_NAME), JSON.stringify({
      ...owner,
      state: 'completed',
      completedAt,
    } satisfies OutputDirectoryOwner), { mode: 0o600 });
  } catch (markerError) {
    contextLogger.warn(
      { outputDirectory, error: getErrorMessage(markerError) },
      'Failed to mark Repomix output directory as completed before cleanup',
    );
  }

  try {
    await rm(outputDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch (cleanupError) {
    contextLogger.error(
      { outputDirectory, error: getErrorMessage(cleanupError) },
      'Failed to securely clean up Repomix output directory after retries',
    );
    throw new Error(`Failed to securely clean up Repomix output directory: ${outputDirectory}`, {
      cause: cleanupError,
    });
  }
}

function requireGeneratedContext(result: ContextGenerationResult | undefined): ContextGenerationResult {
  if (!result) {
    throw new Error('Context generation completed without producing a result');
  }
  return result;
}

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
    return filterExplicitFilesByPackedPaths(filesToInclude, fileTokenCounts);
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

function normalizeTargetRelativePath(filePath: string, caseInsensitive: boolean): string {
  const normalizedPath = path.posix.normalize(filePath.replaceAll('\\', '/'));
  return caseInsensitive ? normalizedPath.toLocaleLowerCase('en-US') : normalizedPath;
}

async function isFileSystemCaseInsensitive(filePath: string): Promise<boolean> {
  const resolvedPath = await realpath(filePath);
  const fileName = path.basename(resolvedPath);
  const letterIndex = fileName.search(/[a-z]/i);
  if (letterIndex === -1) {
    return false;
  }

  const letter = fileName[letterIndex];
  const toggledLetter = letter === letter.toLocaleLowerCase('en-US')
    ? letter.toLocaleUpperCase('en-US')
    : letter.toLocaleLowerCase('en-US');
  const alternatePath = path.join(
    path.dirname(resolvedPath),
    `${fileName.slice(0, letterIndex)}${toggledLetter}${fileName.slice(letterIndex + 1)}`,
  );

  try {
    const [originalStats, alternateStats] = await Promise.all([
      lstat(resolvedPath),
      lstat(alternatePath),
    ]);
    return originalStats.dev === alternateStats.dev && originalStats.ino === alternateStats.ino;
  } catch {
    return false;
  }
}

export function filterExplicitFilesBySafePaths(
  filesToInclude: string[],
  safeFilePaths: string[],
  caseInsensitive = false,
): string[] {
  const safePathsByExactPath = new Map<string, string>();
  const safePathsByFoldedPath = new Map<string, string[]>();
  for (const safePath of safeFilePaths) {
    const exactPath = normalizeTargetRelativePath(safePath, false);
    safePathsByExactPath.set(exactPath, safePath);

    if (caseInsensitive) {
      const foldedPath = normalizeTargetRelativePath(safePath, true);
      const pathsForFoldedPath = safePathsByFoldedPath.get(foldedPath) || [];
      pathsForFoldedPath.push(safePath);
      safePathsByFoldedPath.set(foldedPath, pathsForFoldedPath);
    }
  }
  const matchedSafePaths = new Set<string>();

  return filesToInclude.flatMap(filePath => {
    const exactPath = normalizeTargetRelativePath(filePath, false);
    let safePath = safePathsByExactPath.get(exactPath);
    if (!safePath && caseInsensitive) {
      safePath = safePathsByFoldedPath
        .get(normalizeTargetRelativePath(filePath, true))
        ?.find(candidate => !matchedSafePaths.has(candidate));
    }
    if (!safePath || matchedSafePaths.has(safePath)) {
      return [];
    }
    matchedSafePaths.add(safePath);
    return [safePath];
  });
}

async function filterExplicitFilesBySafePathsOnFileSystem(
  filesToInclude: string[] | undefined,
  safeFilePaths: string[],
  repoPath: string,
): Promise<string[] | undefined> {
  if (!filesToInclude || filesToInclude.length === 0) {
    return undefined;
  }

  const caseInsensitive = await isFileSystemCaseInsensitive(repoPath);
  return filterExplicitFilesBySafePaths(filesToInclude, safeFilePaths, caseInsensitive);
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
  const {
    repoPath,
    filesToInclude,
    priorityFiles,
    tokenLimit,
    correlationId,
    includeFullDirectoryStructure = true,
    compress = false,
    modelId,
    temporaryRoot = tmpdir(),
  } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Convert model token limit to tiktoken limit based on model type
  const tokenRatio = getTokenRatio(modelId);
  const tiktokenLimit = Math.floor(tokenLimit / tokenRatio);

  correlatedLogger.info({ repoPath, filesToInclude, tokenLimit, tiktokenLimit, compress }, 'Starting context generation with repomix');

  // mkdtemp creates the request-owned directory atomically. In particular, it
  // avoids trusting or chmodding a predictable service path that another local
  // user could pre-create as a symlink.
  const outputDirectory = await mkdtemp(path.join(temporaryRoot, TEMP_OUTPUT_PREFIX));
  const outputFilePath = path.join(outputDirectory, 'repomix-output.xml');
  const owner: OutputDirectoryOwner = {
    pid: process.pid,
    requestId: correlationId || randomUUID(),
    createdAt: new Date().toISOString(),
    state: 'active',
  };

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

  let generatedContext: ContextGenerationResult | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    // Restrict repository content even on hosts with a permissive process umask.
    await chmod(outputDirectory, 0o700);
    await writeFile(path.join(outputDirectory, OWNERSHIP_MARKER_NAME), JSON.stringify(owner), { mode: 0o600 });

    const initialPack = await packWithSecurityExclusions(repoPath, config, recordSuspiciousFiles);
    let result: PackResult = initialPack.result;
    const effectiveConfig = initialPack.effectiveConfig;

    // Check if result exceeds token limit and needs truncation
    if (result.totalTokens > tiktokenLimit) {
      const explicitSafeFiles = await filterExplicitFilesBySafePathsOnFileSystem(
        filesToInclude,
        effectiveConfig.include,
        repoPath,
      );
      const filesForOptimization = getFilesForOptimization(
        explicitSafeFiles,
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
          requestedTokenLimit: tokenLimit,
          modelId,
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
      throw new ContextTokenLimitError(result.totalTokens, tokenLimit, tiktokenLimit, modelId);
    }

    // Read only the final successful pack so the returned output and metrics
    // always describe the same attempt.
    const capturedOutput = await readFile(outputFilePath, 'utf8');

    correlatedLogger.info(
      { totalFiles: result.totalFiles, totalCharacters: result.totalCharacters, totalTokens: result.totalTokens },
      'Repomix context generation completed'
    );

    generatedContext = {
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

      operationError = new SecurityException(
        `Security check failed: ${suspiciousFiles.length} file(s) contain potential secrets`,
        suspiciousFiles
      );
    } else {
      correlatedLogger.error({ error: getErrorMessage(error) }, 'Failed to generate context with repomix');
      operationError = error;
    }
    operationFailed = true;
  }

  try {
    await finalizeOutputDirectory(outputDirectory, owner, correlatedLogger);
  } catch (cleanupFailure) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupFailure],
        'Context generation failed and its Repomix output directory could not be cleaned up',
      );
    }
    throw cleanupFailure;
  }
  if (operationFailed) {
    throw operationError;
  }
  return requireGeneratedContext(generatedContext);
}
