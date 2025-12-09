import { pack } from 'repomix';
import logger from '../utils/logger.js';

export interface ContextGenerationOptions {
  repoPath: string;
  filesToInclude?: string[];
  tokenLimit?: number;
  correlationId?: string;
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

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, tokenLimit = DEFAULT_MAX_CONTEXT_TOKENS, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  correlatedLogger.info({ repoPath, filesToInclude, tokenLimit }, 'Starting context generation with repomix');

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
      compress: false,
      topFilesLength: 10,
      showLineNumbers: false,
      truncateBase64: true,
      copyToClipboard: false,
      includeFullDirectoryStructure: false,
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

    // Check if we need to truncate due to token limit
    if (result.totalTokens > tokenLimit) {
      correlatedLogger.warn(
        {
          totalTokens: result.totalTokens,
          tokenLimit,
          totalFiles: result.totalFiles,
        },
        'Context exceeds token limit, truncating by selecting files up to limit'
      );

      // Sort files by token count and select until we hit the limit
      const fileTokenEntries = Object.entries(result.fileTokenCounts as Record<string, number>);
      fileTokenEntries.sort((a, b) => a[1] - b[1]); // Sort by token count ascending (smaller files first)

      const selectedFiles: string[] = [];
      let currentTokens = 0;
      // Reserve 20% of token limit for repomix overhead (directory structure, file headers, XML tags, etc.)
      // Previous value of 5000 was insufficient - observed overhead can be 15-20% of total
      const effectiveLimit = Math.floor(tokenLimit * 0.8);

      for (const [filePath, tokens] of fileTokenEntries) {
        if (currentTokens + tokens <= effectiveLimit) {
          selectedFiles.push(filePath);
          currentTokens += tokens;
        }
      }

      correlatedLogger.info(
        {
          originalFiles: result.totalFiles,
          selectedFiles: selectedFiles.length,
          estimatedTokens: currentTokens,
        },
        'Re-generating context with limited file set'
      );

      // Re-generate with selected files only
      const limitedConfig = { ...config, include: selectedFiles };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const limitedResult = await (pack as any)([repoPath], limitedConfig, () => {}, {
        writeOutputToDisk: captureWriteOutput,
        copyToClipboardIfEnabled: noopCopyToClipboard,
      });

      // Final safety check - warn if we still exceed the limit
      if (limitedResult.totalTokens > tokenLimit) {
        correlatedLogger.warn(
          {
            totalTokens: limitedResult.totalTokens,
            tokenLimit,
            overage: limitedResult.totalTokens - tokenLimit,
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
        includedFiles: selectedFiles,
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
