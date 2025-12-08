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

interface RepomixConfig {
  cwd: string;
  output: {
    filePath: string;
    style: 'xml' | 'plain' | 'markdown';
    parsableStyle: boolean;
    fileSummary: boolean;
    directoryStructure: boolean;
    removeComments: boolean;
    removeEmptyLines: boolean;
    topFilesLength: number;
    showLineNumbers: boolean;
    copyToClipboard: boolean;
  };
  include: string[];
  ignore: {
    useGitignore: boolean;
    useDefaultPatterns: boolean;
    customPatterns: string[];
  };
  security: {
    enableSecurityCheck: boolean;
  };
  tokenCount: {
    encoding: string;
  };
}

interface PackResult {
  totalFiles: number;
  totalCharacters: number;
  totalTokens: number;
  fileCharCounts: Record<string, number>;
  fileTokenCounts: Record<string, number>;
  suspiciousFilesResults: SuspiciousFile[];
}

interface ProcessedFile {
  path: string;
  content: string;
}

interface RawFile {
  path: string;
  content: string;
}

interface FileSearchResult {
  filePaths: string[];
  emptyDirPaths: string[];
}

interface SafetyResult {
  safeRawFiles: RawFile[];
  safeFilePaths: string[];
  suspiciousFilesResults: SuspiciousFile[];
}

interface MetricsResult {
  totalFiles: number;
  totalCharacters: number;
  totalTokens: number;
  fileCharCounts: Record<string, number>;
  fileTokenCounts: Record<string, number>;
}

type ProgressCallback = (message: string) => void;

interface PackDeps {
  searchFiles: (rootDir: string, config: RepomixConfig) => Promise<FileSearchResult>;
  collectFiles: (filePaths: string[], rootDir: string) => Promise<RawFile[]>;
  processFiles: (rawFiles: RawFile[], config: RepomixConfig, progressCallback: ProgressCallback) => Promise<ProcessedFile[]>;
  generateOutput: (rootDir: string, config: RepomixConfig, processedFiles: ProcessedFile[], allFilePaths: string[]) => Promise<string>;
  validateFileSafety: (rawFiles: RawFile[], progressCallback: ProgressCallback, config: RepomixConfig) => Promise<SafetyResult>;
  writeOutputToDisk: (output: string, config: RepomixConfig) => Promise<undefined>;
  copyToClipboardIfEnabled: (output: string, progressCallback: ProgressCallback, config: RepomixConfig) => Promise<undefined>;
  calculateMetrics: (processedFiles: ProcessedFile[], output: string, progressCallback: ProgressCallback, config: RepomixConfig) => Promise<MetricsResult>;
}

type PackFunction = (
  rootDir: string,
  config: RepomixConfig,
  progressCallback?: ProgressCallback,
  deps?: Partial<PackDeps>
) => Promise<PackResult>;

const typedPack = pack as unknown as PackFunction;

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  correlatedLogger.info({ repoPath, filesToInclude }, 'Starting context generation with repomix');

  const config: RepomixConfig = {
    cwd: repoPath,
    output: {
      filePath: 'repomix-output.xml',
      style: 'xml',
      parsableStyle: true,
      fileSummary: true,
      directoryStructure: true,
      removeComments: false,
      removeEmptyLines: false,
      topFilesLength: 10,
      showLineNumbers: false,
      copyToClipboard: false,
    },
    include: filesToInclude || [],
    ignore: {
      useGitignore: true,
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

  const noopCopyToClipboard = async (): Promise<undefined> => {
    return undefined;
  };

  try {
    const result = await typedPack(repoPath, config, () => {}, {
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
    };
  } catch (error) {
    if (error instanceof SecurityException) {
      throw error;
    }
    correlatedLogger.error({ error: (error as Error).message, repoPath }, 'Failed to generate context');
    throw error;
  }
}
