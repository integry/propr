import { pack } from 'repomix';
import logger from '../utils/logger.js';
import { TIKTOKEN_TO_CLAUDE_RATIO } from '../config/modelLimits.js';

export interface ContextGenerationOptions {
  repoPath: string;
  filesToInclude?: string[];
  priorityFiles?: string[];  // Files to prioritize (include first) when truncating
  tokenLimit?: number;
  correlationId?: string;
  includeFullDirectoryStructure?: boolean;
  compress?: boolean;
}

export interface ContextGenerationResult {
  context: string;
  totalFiles: number;
  totalCharacters: number;
  totalTokens: number;
  fileCharCounts: Record<string, number>;
  fileTokenCounts: Record<string, number>;
  includedFiles: string[];
}

export interface SuspiciousFile {
  filePath: string;
  messages: string[];
}

export class SecurityException extends Error {
  public readonly suspiciousFiles: SuspiciousFile[];

  constructor(message: string, suspiciousFiles: SuspiciousFile[]) {
    super(message);
    this.name = 'SecurityException';
    this.suspiciousFiles = suspiciousFiles;
  }
}

// Default max tokens - Claude's context is ~200K but we need room for the prompt and response
const DEFAULT_MAX_CONTEXT_TOKENS = 150000;

interface DroppedFile {
  path: string;
  tokens: number;
  reason: string;
}

interface FileSelectionResult {
  selectedFiles: string[];
  droppedFiles: DroppedFile[];
  currentTokens: number;
  strategy: 'relevance-order' | 'size-order' | 'priority-then-size';
}

function selectFilesWithinLimit(
  fileTokenCounts: Record<string, number>,
  effectiveLimit: number,
  filesToInclude?: string[],
  priorityFiles?: string[]
): FileSelectionResult {
  const selectedFiles: string[] = [];
  const droppedFiles: DroppedFile[] = [];
  let currentTokens = 0;

  if (filesToInclude && filesToInclude.length > 0) {
    for (const filePath of filesToInclude) {
      const tokens = fileTokenCounts[filePath];
      if (tokens === undefined) {
        droppedFiles.push({ path: filePath, tokens: 0, reason: 'not found in token counts' });
        continue;
      }
      if (currentTokens + tokens > effectiveLimit) {
        droppedFiles.push({ path: filePath, tokens, reason: `exceeds limit (would be ${currentTokens + tokens} > ${effectiveLimit})` });
        continue;
      }
      selectedFiles.push(filePath);
      currentTokens += tokens;
    }
    return { selectedFiles, droppedFiles, currentTokens, strategy: 'relevance-order' };
  }

  // When no specific files requested, include all files but prioritize certain ones
  const prioritySet = new Set(priorityFiles || []);
  const allFiles = Object.entries(fileTokenCounts);

  // Sort: priority files first (by their original order), then remaining files by size
  const priorityFilesWithTokens = (priorityFiles || [])
    .filter(p => fileTokenCounts[p] !== undefined)
    .map(p => [p, fileTokenCounts[p]] as [string, number]);

  const nonPriorityFiles = allFiles
    .filter(([path]) => !prioritySet.has(path))
    .sort((a, b) => a[1] - b[1]); // Sort by size (smallest first)

  const sortedFiles = [...priorityFilesWithTokens, ...nonPriorityFiles];

  for (const [filePath, tokens] of sortedFiles) {
    if (currentTokens + tokens > effectiveLimit) {
      droppedFiles.push({ path: filePath, tokens, reason: `exceeds limit (would be ${currentTokens + tokens} > ${effectiveLimit})` });
      continue;
    }
    selectedFiles.push(filePath);
    currentTokens += tokens;
  }
  return { selectedFiles, droppedFiles, currentTokens, strategy: priorityFiles?.length ? 'priority-then-size' : 'size-order' };
}

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, priorityFiles, tokenLimit = DEFAULT_MAX_CONTEXT_TOKENS, correlationId, includeFullDirectoryStructure = true, compress = false } = options;
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

  try {
    // repomix v1.9+ expects rootDirs as first argument (array of directories)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (pack as any)([repoPath], config, () => {}, {
      writeOutputToDisk: captureWriteOutput,
      copyToClipboardIfEnabled: noopCopyToClipboard,
    });

    if (result.suspiciousFilesResults && result.suspiciousFilesResults.length > 0) {
      correlatedLogger.warn(
        { suspiciousFiles: result.suspiciousFilesResults },
        'Security check detected suspicious files containing potential secrets'
      );
      throw new SecurityException(
        `Security check failed: ${result.suspiciousFilesResults.length} file(s) contain potential secrets`,
        result.suspiciousFilesResults
      );
    }

    // Check if we need to truncate due to token limit (using tiktoken limit for comparison)
    if (result.totalTokens > tiktokenLimit) {
      correlatedLogger.warn(
        {
          totalTokens: result.totalTokens,
          tiktokenLimit,
          tokenLimit,
          totalFiles: result.totalFiles,
        },
        'Context exceeds token limit, truncating by selecting files up to limit'
      );

      const fileTokenCounts = result.fileTokenCounts as Record<string, number>;
      const effectiveLimit = Math.floor(tiktokenLimit * 0.8);
      const selection = selectFilesWithinLimit(fileTokenCounts, effectiveLimit, filesToInclude, priorityFiles);

      const strategyMessages: Record<string, string> = {
        'relevance-order': 'Truncating by relevance order (most relevant files first)',
        'size-order': 'Truncating by file size (smallest files first)',
        'priority-then-size': 'Truncating with priority files first, then by size'
      };
      correlatedLogger.info(
        { strategy: selection.strategy, selectedCount: selection.selectedFiles.length },
        strategyMessages[selection.strategy]
      );

      // Detailed debug logging for file selection decisions
      correlatedLogger.info({
        selectionStrategy: selection.strategy,
        effectiveLimit,
        currentTokens: selection.currentTokens,
        keptCount: selection.selectedFiles.length,
        droppedCount: selection.droppedFiles.length,
        keptFilesSample: selection.selectedFiles.slice(0, 5).map(path => ({
          path,
          tokens: fileTokenCounts[path]
        })),
        droppedFilesSample: selection.droppedFiles.slice(0, 5),
        largestKept: selection.selectedFiles.length > 0 ? {
          path: selection.selectedFiles[selection.selectedFiles.length - 1],
          tokens: fileTokenCounts[selection.selectedFiles[selection.selectedFiles.length - 1]]
        } : null,
        largestDropped: selection.droppedFiles.length > 0 ? selection.droppedFiles[selection.droppedFiles.length - 1] : null
      }, 'File selection details after truncation');

      correlatedLogger.info(
        {
          originalFiles: result.totalFiles,
          selectedFiles: selection.selectedFiles.length,
          estimatedTokens: selection.currentTokens,
        },
        'Re-generating context with limited file set'
      );

      // Re-generate with selected files only
      const limitedConfig = { ...config, include: selection.selectedFiles };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const limitedResult = await (pack as any)([repoPath], limitedConfig, () => {}, {
        writeOutputToDisk: captureWriteOutput,
        copyToClipboardIfEnabled: noopCopyToClipboard,
      });

      // Final safety check - warn if we still exceed the limit
      if (limitedResult.totalTokens > tiktokenLimit) {
        correlatedLogger.warn(
          {
            totalTokens: limitedResult.totalTokens,
            tiktokenLimit,
            tokenLimit,
            overage: limitedResult.totalTokens - tiktokenLimit,
          },
          'Context still exceeds token limit after truncation - repomix overhead larger than expected'
        );
      }

      correlatedLogger.info(
        {
          totalFiles: limitedResult.totalFiles,
          totalCharacters: limitedResult.totalCharacters,
          totalTokens: limitedResult.totalTokens,
          truncated: true,
        },
        'Context generation completed with truncation'
      );

      return {
        context: capturedOutput,
        totalFiles: limitedResult.totalFiles,
        totalCharacters: limitedResult.totalCharacters,
        totalTokens: limitedResult.totalTokens,
        fileCharCounts: limitedResult.fileCharCounts,
        fileTokenCounts: limitedResult.fileTokenCounts,
        includedFiles: selection.selectedFiles,
      };
    }

    correlatedLogger.info(
      {
        totalFiles: result.totalFiles,
        totalCharacters: result.totalCharacters,
        totalTokens: result.totalTokens,
      },
      'Context generation completed successfully'
    );

    return {
      context: capturedOutput,
      totalFiles: result.totalFiles,
      totalCharacters: result.totalCharacters,
      totalTokens: result.totalTokens,
      fileCharCounts: result.fileCharCounts,
      fileTokenCounts: result.fileTokenCounts,
      includedFiles: Object.keys(result.fileTokenCounts),
    };
  } catch (error) {
    if (error instanceof SecurityException) {
      throw error;
    }
    correlatedLogger.error({ error: (error as Error).message, repoPath }, 'Failed to generate context');
    throw error;
  }
}
