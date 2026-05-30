/**
 * Additional context generation from external repositories.
 */

import logger from '../../utils/logger.js';
import type { ContextRepository } from '../planningHelpers.js';
import { ensureRepoCloned } from '../../git/repoManager.js';
import { getGitHubInstallationToken } from '../../auth/githubAuth.js';
import { generateContext } from './generateContext.js';

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
  /** Total file count across all context repositories */
  totalFiles: number;
  /** Files included from each repository (for UI display) */
  filesIncluded: Array<{ repository: string; path: string }>;
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

type RepoResult = { repository: string; context: string; tokens: number; files: number; filePaths: string[] };

async function processContextRepository(
  repo: ContextRepository,
  opts: { authToken: string; tokenBudgetPerRepo: number; correlationId?: string; correlatedLogger: Pick<typeof logger, 'info' | 'warn'> }
): Promise<{ data?: RepoResult; error?: { repository: string; error: string } }> {
  const { authToken, tokenBudgetPerRepo, correlationId, correlatedLogger } = opts;
  const [owner, repoName] = repo.repository.split('/');
  if (!owner || !repoName) {
    return { error: { repository: repo.repository, error: 'Invalid repository format. Expected "owner/repo"' } };
  }

  try {
    correlatedLogger.info(
      { repository: repo.repository, branch: repo.branch || 'default', tokenBudget: tokenBudgetPerRepo },
      'Processing additional context repository'
    );

    const repoUrl = `https://github.com/${owner}/${repoName}.git`;
    let effectiveAuthToken = authToken;
    try {
      effectiveAuthToken = await getGitHubInstallationToken();
    } catch {
      // Fall back to provided auth token
    }

    const repoPath = await ensureRepoCloned({
      repoUrl, owner, repoName,
      authToken: effectiveAuthToken,
      baseBranch: repo.branch
    });

    const contextResult = await generateContext({
      repoPath,
      tokenLimit: tokenBudgetPerRepo,
      correlationId,
      includeFullDirectoryStructure: false,
      compress: true
    });

    const strippedContext = stripFilePathsFromContext(contextResult.context, repo.repository);
    const finalContext = repo.description ? `[${repo.description}]\n${strippedContext}` : strippedContext;

    correlatedLogger.info(
      { repository: repo.repository, totalTokens: contextResult.totalTokens, totalFiles: contextResult.totalFiles },
      'Successfully generated context for additional repository'
    );

    return {
      data: {
        repository: repo.repository,
        context: finalContext,
        tokens: contextResult.totalTokens,
        files: contextResult.totalFiles,
        filePaths: contextResult.includedFiles
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    correlatedLogger.warn(
      { repository: repo.repository, error: errorMessage },
      'Failed to generate context for additional repository'
    );
    return { error: { repository: repo.repository, error: errorMessage } };
  }
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
      totalFiles: 0,
      filesIncluded: [],
      repositoriesIncluded: [],
      errors: []
    };
  }

  correlatedLogger.info(
    { repositoryCount: repositories.length, tokenBudget },
    'Starting additional context generation'
  );

  const results: Array<{ repository: string; context: string; tokens: number; files: number; filePaths: string[] }> = [];
  const errors: Array<{ repository: string; error: string }> = [];

  // Divide token budget evenly among repositories (with some buffer for overhead)
  const tokenBudgetPerRepo = Math.floor((tokenBudget * 0.9) / repositories.length);

  for (const repo of repositories) {
    const result = await processContextRepository(repo, { authToken, tokenBudgetPerRepo, correlationId, correlatedLogger });
    if (result.error) {
      errors.push(result.error);
    } else if (result.data) {
      results.push(result.data);
    }
  }

  // Combine all context
  const combinedContext = results.map(r => r.context).join('\n\n---\n\n');
  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const totalFiles = results.reduce((sum, r) => sum + r.files, 0);
  const filesIncluded = results.flatMap(r => r.filePaths.map(path => ({ repository: r.repository, path })));

  correlatedLogger.info(
    {
      repositoriesIncluded: results.length,
      errorCount: errors.length,
      totalTokens,
      totalFiles
    },
    'Additional context generation completed'
  );

  return {
    context: combinedContext,
    totalTokens,
    totalFiles,
    filesIncluded,
    repositoriesIncluded: results.map(r => r.repository),
    errors
  };
}
