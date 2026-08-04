/**
 * Additional context generation from context repositories.
 */

import { generateAdditionalContext } from '../context/index.js';
import { updateTraceForRun } from '../planning/index.js';
import type { AdditionalContextOptions, AdditionalContextResult } from './types.js';

/**
 * Generate additional context from context repositories if configured
 */
export async function generateAdditionalContextIfNeeded(options: AdditionalContextOptions): Promise<AdditionalContextResult> {
  const { contextRepositories, prompt, contextModel, additionalContextBudget, useFullBudget = false, githubToken, draftId, runId, correlationId, correlatedLogger } = options;
  if (!contextRepositories || contextRepositories.length === 0) {
    return {};
  }

  correlatedLogger.info({
    repositoryCount: contextRepositories.length,
    repositories: contextRepositories.map(r => r.repository),
    budgetTokens: additionalContextBudget
  }, 'Generating additional context from context repositories');

  try {
    const additionalContextResult = await generateAdditionalContext({
      repositories: contextRepositories,
      prompt,
      contextModel,
      tokenBudget: additionalContextBudget,
      authToken: githubToken,
      correlationId,
      useFullBudget
    });

    if (additionalContextResult.repositoriesIncluded.length > 0) {
      correlatedLogger.info({
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errorCount: additionalContextResult.errors.length
      }, 'Additional context generated successfully');

      const traceData = {
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errors: additionalContextResult.errors
      };
      await updateTraceForRun(draftId, 'additional_context', 'completed', { expectedRunId: runId, data: traceData });
    }

    if (additionalContextResult.errors.length > 0) {
      correlatedLogger.warn({ errors: additionalContextResult.errors }, 'Some context repositories could not be processed');
    }

    return { context: additionalContextResult.context };
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to generate additional context, continuing without it');
    return {};
  }
}
