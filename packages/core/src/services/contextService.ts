/* eslint-disable max-lines */
import { pack } from 'repomix';
import logger from '../utils/logger.js';
import { TIKTOKEN_TO_CLAUDE_RATIO } from '../config/modelLimits.js';
import type { ContextRepository } from './planningHelpers.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';

export interface ContextGenerationOptions {
  repoPath: string;
  filesToInclude?: string[];
  priorityFiles?: string[];  // Files to prioritize (include first) when truncating
  /** Token limit from model configuration - required, no default fallback */
  tokenLimit: number;
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
  /** Files skipped due to security concerns (potential secrets) */
  skippedSecurityFiles?: SuspiciousFile[];
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

export interface DroppedFile {
  path: string;
  tokens: number;
  reason: string;
}

export interface FileSelectionResult {
  selectedFiles: string[];
  droppedFiles: DroppedFile[];
  currentTokens: number;
  strategy: 'relevance-order' | 'size-order' | 'priority-then-size';
}

export function selectFilesWithinLimit(
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

interface GenerateOptimizedContextOptions {
  repoPath: string;
  initialFiles: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseConfig: any;
  tiktokenLimit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contextLogger: any;
  writeOutput: (output: string) => Promise<undefined>;
  noopClipboard: () => Promise<void>;
}

async function generateOptimizedContext(options: GenerateOptimizedContextOptions) {
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

export async function generateContext(options: ContextGenerationOptions): Promise<ContextGenerationResult> {
  const { repoPath, filesToInclude, priorityFiles, tokenLimit, correlationId, includeFullDirectoryStructure = true, compress = false } = options;
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

    // If suspicious files are detected, filter them out and retry
    if (result.suspiciousFilesResults && result.suspiciousFilesResults.length > 0) {
      skippedSecurityFiles = result.suspiciousFilesResults;
      const suspiciousPaths = new Set(result.suspiciousFilesResults.map((f: SuspiciousFile) => f.filePath));

      correlatedLogger.warn(
        { suspiciousFiles: result.suspiciousFilesResults, count: suspiciousPaths.size },
        'Security check detected suspicious files - skipping them and retrying'
      );

      // Add suspicious files to ignore patterns and retry
      const retryConfig = {
        ...config,
        ignore: {
          ...config.ignore,
          customPatterns: [
            ...(config.ignore?.customPatterns || []),
            ...Array.from(suspiciousPaths)
          ],
        },
      };

      // Also filter from filesToInclude if specified
      if (retryConfig.include && retryConfig.include.length > 0) {
        retryConfig.include = retryConfig.include.filter((f: string) => !suspiciousPaths.has(f));
      }

      capturedOutput = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (pack as any)([repoPath], retryConfig, () => {}, {
        writeOutputToDisk: captureWriteOutput,
        copyToClipboardIfEnabled: noopCopyToClipboard,
      });

      correlatedLogger.info(
        { skippedCount: suspiciousPaths.size, newTotalFiles: result.totalFiles },
        'Retried context generation without suspicious files'
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
      // Use 70% of limit to leave room for repomix overhead (XML structure, directory listing, etc.)
      // The iterative truncation loop will adjust further if needed
      const effectiveLimit = Math.floor(tiktokenLimit * 0.7);
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

      // Re-generate with selected files only, iteratively removing files if still over limit
      const optimizationResult = await generateOptimizedContext({
        repoPath,
        initialFiles: selection.selectedFiles,
        baseConfig: config,
        tiktokenLimit,
        contextLogger: correlatedLogger,
        writeOutput: captureWriteOutput,
        noopClipboard: noopCopyToClipboard
      });

      const limitedResult = optimizationResult.result;
      const currentFiles = optimizationResult.currentFiles;

      correlatedLogger.info(
        {
          totalFiles: limitedResult.totalFiles,
          totalCharacters: limitedResult.totalCharacters,
          totalTokens: limitedResult.totalTokens,
          truncated: true,
          finalFileCount: currentFiles.length,
          originalFileCount: selection.selectedFiles.length,
          filesRemoved: selection.selectedFiles.length - currentFiles.length,
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
        includedFiles: currentFiles,
        skippedSecurityFiles,
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
      skippedSecurityFiles,
    };
  } catch (error) {
    correlatedLogger.error({ error: (error as Error).message, repoPath }, 'Failed to generate context');
    throw error;
  }
}

/**
 * Options for generating additional context from external repositories
 */
export interface AdditionalContextOptions {
  /** List of repositories to include as context */
  repositories: ContextRepository[];
  /** Token budget for all additional context (shared across all repos) */
  tokenBudget: number;
  /** GitHub auth token for cloning private repos */
  authToken: string;
  /** Optional correlation ID for logging */
  correlationId?: string;
}

/**
 * Result of generating additional context
 */
export interface AdditionalContextResult {
  /** Combined context from all repositories (file content only, paths stripped) */
  context: string;
  /** Total tokens used for additional context */
  totalTokens: number;
  /** List of repositories that were successfully included */
  repositoriesIncluded: string[];
  /** Errors encountered when processing repositories */
  errors: Array<{ repository: string; error: string }>;
}

/**
 * Strip file paths from repomix context output while preserving code content.
 * Removes file path references to prevent LLM from referencing them as implementation targets.
 */
function stripFilePathsFromContext(context: string, repoName: string): string {
  // Remove file path headers like "File: path/to/file.ts" or similar XML tags
  // But preserve the actual code content
  let strippedContext = context;

  // Replace file path in XML format: <file path="..."> with <file>
  strippedContext = strippedContext.replace(/<file\s+path="[^"]*">/g, '<file>');

  // Remove <path>...</path> tags entirely
  strippedContext = strippedContext.replace(/<path>[^<]*<\/path>\s*/g, '');

  // Remove directory structure section (not useful for example context)
  strippedContext = strippedContext.replace(/<directory-structure>[\s\S]*?<\/directory-structure>\s*/g, '');

  // Remove file summary section headers that include paths
  strippedContext = strippedContext.replace(/<file-summary>[\s\S]*?<\/file-summary>\s*/g, '');

  // Add a header indicating this is example content from a specific repo
  const header = `--- Example code from ${repoName} (REFERENCE ONLY) ---\n`;

  return header + strippedContext;
}

/**
 * Generate context from additional repositories.
 * This content is marked as "example/reference only" and file paths are stripped
 * to prevent the LLM from treating them as implementation targets.
 */
export async function generateAdditionalContext(
  options: AdditionalContextOptions
): Promise<AdditionalContextResult> {
  const { repositories, tokenBudget, authToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!repositories || repositories.length === 0) {
    return {
      context: '',
      totalTokens: 0,
      repositoriesIncluded: [],
      errors: []
    };
  }

  correlatedLogger.info(
    { repositoryCount: repositories.length, tokenBudget },
    'Starting additional context generation'
  );

  const results: Array<{ repository: string; context: string; tokens: number }> = [];
  const errors: Array<{ repository: string; error: string }> = [];

  // Divide token budget evenly among repositories (with some buffer for overhead)
  const tokenBudgetPerRepo = Math.floor((tokenBudget * 0.9) / repositories.length);

  for (const repo of repositories) {
    const [owner, repoName] = repo.repository.split('/');
    if (!owner || !repoName) {
      errors.push({ repository: repo.repository, error: 'Invalid repository format. Expected "owner/repo"' });
      continue;
    }

    try {
      correlatedLogger.info(
        { repository: repo.repository, branch: repo.branch || 'default', tokenBudget: tokenBudgetPerRepo },
        'Processing additional context repository'
      );

      // Ensure the repository is cloned
      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      let effectiveAuthToken = authToken;
      try {
        // Try to use installation token for private repo access
        effectiveAuthToken = await getGitHubInstallationToken();
      } catch {
        // Fall back to provided auth token
      }

      const repoPath = await ensureRepoCloned({
        repoUrl,
        owner,
        repoName,
        authToken: effectiveAuthToken,
        baseBranch: repo.branch
      });

      // Generate context for this repository
      const contextResult = await generateContext({
        repoPath,
        tokenLimit: tokenBudgetPerRepo,
        correlationId,
        includeFullDirectoryStructure: false, // Skip directory structure for context repos
        compress: true // Use compression to maximize content
      });

      // Strip file paths from the context
      const strippedContext = stripFilePathsFromContext(contextResult.context, repo.repository);

      // Add description if provided
      let finalContext = strippedContext;
      if (repo.description) {
        finalContext = `[${repo.description}]\n${strippedContext}`;
      }

      results.push({
        repository: repo.repository,
        context: finalContext,
        tokens: contextResult.totalTokens
      });

      correlatedLogger.info(
        {
          repository: repo.repository,
          totalTokens: contextResult.totalTokens,
          totalFiles: contextResult.totalFiles
        },
        'Successfully generated context for additional repository'
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      correlatedLogger.warn(
        { repository: repo.repository, error: errorMessage },
        'Failed to generate context for additional repository'
      );
      errors.push({ repository: repo.repository, error: errorMessage });
    }
  }

  // Combine all context
  const combinedContext = results.map(r => r.context).join('\n\n---\n\n');
  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);

  correlatedLogger.info(
    {
      repositoriesIncluded: results.length,
      errorCount: errors.length,
      totalTokens
    },
    'Additional context generation completed'
  );

  return {
    context: combinedContext,
    totalTokens,
    repositoriesIncluded: results.map(r => r.repository),
    errors
  };
}
