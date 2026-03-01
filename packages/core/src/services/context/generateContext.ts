/**
 * Main context generation using repomix.
 */

import { pack } from 'repomix';
import logger from '../../utils/logger.js';
import { TIKTOKEN_TO_CLAUDE_RATIO } from '../../config/modelLimits.js';
import { generateOptimizedContext } from './optimizedContext.js';
import type { ContextGenerationOptions, ContextGenerationResult, SuspiciousFile } from './types.js';
import { SecurityException } from './types.js';

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, tokenLimit, correlationId, includeFullDirectoryStructure = true, compress = false } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Convert Claude token limit to tiktoken limit (tiktoken underestimates by ~36%)
  const tiktokenLimit = Math.floor(tokenLimit / TIKTOKEN_TO_CLAUDE_RATIO);

  correlatedLogger.info({ repoPath, filesToInclude, tokenLimit, tiktokenLimit, compress }, 'Starting context generation with repomix');

  const config = {
    cwd: repoPath,
    input: {
      maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    output: {
      filePath: 'repomix-output.xml',
      style: 'xml' as const,
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
      tokenCountTree: false,
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

  let capturedOutput = '';

  const captureWriteOutput = async (output: string): Promise<undefined> => {
    capturedOutput = output;
    return undefined;
  };

  const noopCopyToClipboard = async (): Promise<void> => {
    return;
  };

  let skippedSecurityFiles: SuspiciousFile[] | undefined;

  try {
    // repomix v1.9+ expects rootDirs as first argument (array of directories)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result = await (pack as any)([repoPath], config, () => {}, {
      writeOutputToDisk: captureWriteOutput,
      copyToClipboardIfEnabled: noopCopyToClipboard,
    });

    // Check if we got a security exception and need to retry without problematic files
    if (result.suspiciousFilesResults && result.suspiciousFilesResults.length > 0) {
      const suspiciousFiles: SuspiciousFile[] = result.suspiciousFilesResults.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (file: any) => ({
          filePath: file.filePath,
          messages: file.messages || [],
        })
      );

      correlatedLogger.warn(
        { suspiciousFilesCount: suspiciousFiles.length, files: suspiciousFiles.slice(0, 5).map(f => f.filePath) },
        'Suspicious files detected during context generation - excluding them'
      );

      // Store skipped files for reporting
      skippedSecurityFiles = suspiciousFiles;

      // Create a new config that excludes the suspicious files
      const suspiciousFilePaths = suspiciousFiles.map(f => f.filePath);

      // If we have specific files to include, filter out suspicious ones
      // Otherwise, add suspicious files to the ignore list
      const updatedConfig = {
        ...config,
        include: filesToInclude
          ? filesToInclude.filter(f => !suspiciousFilePaths.includes(f))
          : [],
        ignore: {
          ...config.ignore,
          customPatterns: [
            ...config.ignore.customPatterns,
            ...suspiciousFilePaths.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          ],
        },
        security: {
          enableSecurityCheck: false,  // Disable security check on retry since we've already filtered
        },
      };

      // Retry without suspicious files
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (pack as any)([repoPath], updatedConfig, () => {}, {
        writeOutputToDisk: captureWriteOutput,
        copyToClipboardIfEnabled: noopCopyToClipboard,
      });
    }

    // Check if result exceeds token limit and needs truncation
    if (result.totalTokens > tiktokenLimit && filesToInclude && filesToInclude.length > 0) {
      correlatedLogger.info(
        { totalTokens: result.totalTokens, tiktokenLimit, fileCount: filesToInclude.length },
        'Initial context exceeds token limit, applying iterative truncation'
      );

      // Use optimized context generation with iterative truncation
      const optimizedResult = await generateOptimizedContext({
        repoPath,
        initialFiles: filesToInclude,
        baseConfig: config,
        tiktokenLimit,
        contextLogger: correlatedLogger,
        writeOutput: captureWriteOutput,
        noopClipboard: noopCopyToClipboard,
      });

      result = optimizedResult.result;

      correlatedLogger.info(
        {
          originalFiles: filesToInclude.length,
          finalFiles: optimizedResult.currentFiles.length,
          totalTokens: result.totalTokens,
          tiktokenLimit
        },
        'Context truncation completed'
      );
    }

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
      skippedSecurityFiles,
    };
  } catch (error) {
    // Check if repomix threw a security exception
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    if (err.suspiciousFilesResults && Array.isArray(err.suspiciousFilesResults) && err.suspiciousFilesResults.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suspiciousFiles: SuspiciousFile[] = err.suspiciousFilesResults.map((file: any) => ({
        filePath: file.filePath,
        messages: file.messages || [],
      }));

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
  }
}
