/**
 * Additional context generation from external repositories.
 */

import logger from '../../utils/logger.js';
import type { ContextRepository } from '../planning/planningTypes.js';
import { ensureRepoCloned } from '../../git/repoManager.js';
import { getGitHubInstallationToken } from '../../auth/githubAuth.js';
import { generateContext } from './generateContext.js';
import { findRelevantFiles, type RelevantFile } from '../relevanceService.js';
import { getAgentRegistry } from '../../agents/AgentRegistry.js';
import type { Agent } from '../../agents/types.js';

/**
 * Options for generating additional context from external repositories
 */
export interface AdditionalContextOptions {
  /** List of repositories to include as context */
  repositories: ContextRepository[];
  /** User prompt used to rank files in the additional repositories */
  prompt?: string;
  /** Model/agent used for relevance ranking */
  contextModel?: string;
  /** Token budget for all additional context (shared across all repos) */
  tokenBudget: number;
  /** Use the full provided budget instead of reserving a buffer */
  useFullBudget?: boolean;
  /** Prefer bounded local ranking for latency-sensitive preview requests. */
  fastRelevance?: boolean;
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
  filesIncluded: Array<{ repository: string; path: string; score?: number; reason?: string }>;
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

interface RepoContextResult {
  repository: string;
  context: string;
  tokens: number;
  files: number;
  filePaths: string[];
  fileScores: Record<string, { score: number; reason: string }>;
}

async function resolveAuthToken(authToken: string): Promise<string> {
  try {
    return await getGitHubInstallationToken();
  } catch {
    return authToken;
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
  const { repositories, prompt, contextModel, tokenBudget, useFullBudget = false, fastRelevance = false, authToken, correlationId } = options;
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

  const results: RepoContextResult[] = [];
  const errors: Array<{ repository: string; error: string }> = [];

  // Divide token budget evenly among repositories. Full scan intentionally uses
  // the entire remaining budget so small target repos can lean on references.
  const budgetRatio = useFullBudget ? 1 : 0.9;
  const tokenBudgetPerRepo = Math.floor((tokenBudget * budgetRatio) / repositories.length);

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

      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      const effectiveAuthToken = await resolveAuthToken(authToken);

      const repoPath = await ensureRepoCloned({
        repoUrl,
        owner,
        repoName,
        authToken: effectiveAuthToken,
        baseBranch: repo.branch
      });

      const { priorityFiles, fileScores } = await rankRepoFiles({
        repoPath, repo, prompt, contextModel, fastRelevance, correlationId
      });

      const contextResult = await generateContext({
        repoPath,
        priorityFiles,
        tokenLimit: tokenBudgetPerRepo,
        correlationId,
        includeFullDirectoryStructure: false,
        compress: true
      });

      const strippedContext = stripFilePathsFromContext(contextResult.context, repo.repository);
      const finalContext = repo.description
        ? `[${repo.description}]\n${strippedContext}`
        : strippedContext;

      results.push({
        repository: repo.repository,
        context: finalContext,
        tokens: contextResult.totalTokens,
        files: contextResult.totalFiles,
        filePaths: contextResult.includedFiles,
        fileScores
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

  const combinedContext = results.map(r => r.context).join('\n\n---\n\n');
  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const totalFiles = results.reduce((sum, r) => sum + r.files, 0);
  const filesIncluded = results
    .flatMap(r => r.filePaths.map(path => ({
      repository: r.repository,
      path,
      score: r.fileScores[path]?.score,
      reason: r.fileScores[path]?.reason
    })))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  correlatedLogger.info(
    { repositoriesIncluded: results.length, errorCount: errors.length, totalTokens, totalFiles },
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

async function rankRepoFiles(params: {
  repoPath: string;
  repo: ContextRepository;
  prompt?: string;
  contextModel?: string;
  fastRelevance: boolean;
  correlationId?: string;
}): Promise<{ priorityFiles?: string[]; fileScores: Record<string, { score: number; reason: string }> }> {
  const { repoPath, repo, prompt, contextModel, fastRelevance, correlationId } = params;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const fileScores: Record<string, { score: number; reason: string }> = {};

  if (!prompt?.trim()) {
    return { priorityFiles: undefined, fileScores };
  }

  try {
    const agent = fastRelevance ? undefined : await resolveRelevanceAgent(contextModel, correlationId);
    const relevanceResult = await findRelevantFiles(repoPath, prompt, {
      correlationId,
      repoName: repo.repository,
      branch: repo.branch,
      agent,
      modelId: contextModel,
      useLLMKeywords: !fastRelevance,
      useSummaryScoring: !fastRelevance,
      keywordTimeoutMs: fastRelevance ? 3000 : undefined,
      maxResults: 1000,
      minScore: 1
    });
    const priorityFiles = relevanceResult.files.map(file => file.path);
    for (const file of relevanceResult.files) {
      fileScores[file.path] = { score: file.score, reason: formatRelevanceReason(file) };
    }
    correlatedLogger.info(
      {
        repository: repo.repository,
        relevantFileCount: relevanceResult.files.length,
        topFiles: relevanceResult.files.slice(0, 5).map(file => ({ path: file.path, score: file.score, reason: file.reason }))
      },
      'Ranked additional context repository files by relevance'
    );
    return { priorityFiles, fileScores };
  } catch (error) {
    correlatedLogger.warn(
      { repository: repo.repository, error: (error as Error).message },
      'Failed to rank additional context repository files; falling back to repository order'
    );
    return { priorityFiles: undefined, fileScores };
  }
}

async function resolveRelevanceAgent(contextModel: string | undefined, correlationId: string | undefined): Promise<Agent | undefined> {
  try {
    const registry = getAgentRegistry();
    await registry.ensureInitialized();
    if (contextModel?.includes(':')) {
      const agentAlias = contextModel.split(':')[0];
      return registry.getAgentByAlias(agentAlias) ?? registry.getDefaultAgent();
    }
    return registry.getDefaultAgent();
  } catch (error) {
    const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to resolve relevance agent for additional context repository');
    return undefined;
  }
}

function formatRelevanceReason(file: RelevantFile): string {
  switch (file.reason) {
    case 'git-history':
      return 'Relevant by git history';
    case 'path-match':
      return 'Relevant by path match';
    case 'llm-semantic':
    case 'semantic':
      return 'Semantically relevant';
    case 'combined':
      return 'Relevant by combined signals';
    default:
      return 'Reference context';
  }
}
