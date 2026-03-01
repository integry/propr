/**
 * Additional context generation from context repositories.
 */

import { generateAdditionalContext } from '../contextService.js';
import { updateTrace } from '../planningHelpers.js';
import type { AdditionalContextOptions, AdditionalContextResult } from './types.js';

/**
 * Generate additional context from context repositories if configured
 */
export async function generateAdditionalContextIfNeeded(options: AdditionalContextOptions): Promise<AdditionalContextResult> {
  const { contextRepositories, additionalContextBudget, githubToken, draftId, correlationId, correlatedLogger } = options;
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
      tokenBudget: additionalContextBudget,
      authToken: githubToken,
      correlationId
    });

    if (additionalContextResult.repositoriesIncluded.length > 0) {
      correlatedLogger.info({
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errorCount: additionalContextResult.errors.length
      }, 'Additional context generated successfully');

      await updateTrace(draftId, 'additional_context', 'completed', {
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errors: additionalContextResult.errors
      });
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
