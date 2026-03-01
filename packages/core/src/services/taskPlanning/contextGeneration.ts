/**
 * Context generation with retry logic for plan generation.
 */

import { generateContext } from '../contextService.js';
import { buildSummaryContext } from '../relevance/contextBuilder.js';
import {
  validatePromptTokens, CLAUDE_CODE_OVERHEAD, CHARS_PER_TOKEN, PlanningFailedError, buildFullContext, getModelHardLimit
} from '../planningHelpers.js';
import { generateAdditionalContextIfNeeded } from './additionalContext.js';
import type { ContextGenerationParams, ContextGenerationResult } from './types.js';

export async function generateContextWithRetry(params: ContextGenerationParams): Promise<ContextGenerationResult> {
  const { worktreePath, config, relevantFilePaths, candidateSummaries, budgets, base64Images, draft, draftId, githubToken, correlationId, generationModel, correlatedLogger } = params;
  const modelHardLimit = getModelHardLimit(generationModel);
  let currentRepomixLimit = budgets.repomixTokenLimit;
  let contextResult: Awaited<ReturnType<typeof generateContext>> | undefined;
  let fullContext = '';
  const maxRetries = 5;

  for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
    const filesToInclude = config.compress ? undefined : (relevantFilePaths.length > 0 ? relevantFilePaths : undefined);
    const priorityFiles = config.compress ? relevantFilePaths : undefined;
    contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: currentRepomixLimit, compress: config.compress, correlationId });

    const includedFilesSet = new Set(contextResult.includedFiles);
    const filteredCandidates = candidateSummaries.filter(s => !includedFilesSet.has(s.path));
    const summaryBudgetChars = budgets.summaryTokenCost * CHARS_PER_TOKEN;
    let filteredSummaries = '';
    let summariesIncludedCount = 0;
    for (const s of filteredCandidates) {
      const entry = `FILE ${s.path}: ${s.summary}\n`;
      if (filteredSummaries.length + entry.length > summaryBudgetChars) break;
      filteredSummaries += entry;
      summariesIncludedCount++;
    }
    filteredSummaries = filteredSummaries.trim();

    correlatedLogger.info({ totalCandidates: candidateSummaries.length, includedInContext: contextResult.includedFiles.length, summariesIncluded: summariesIncludedCount, summariesTruncated: summariesIncludedCount < filteredCandidates.length, summaryBudgetChars, retryCount }, 'Filtered summaries for context enrichment');

    const smartSummaryResult = await buildSummaryContext({ tokenBudget: budgets.smartSummaryBudget, priorityPaths: relevantFilePaths, repoName: draft.repository, correlationId });
    const smartSummaries = smartSummaryResult.context || undefined;
    if (smartSummaries) {
      correlatedLogger.info({ fileSummaryCount: smartSummaryResult.fileSummaryCount, dirSummaryCount: smartSummaryResult.dirSummaryCount, estimatedTokens: smartSummaryResult.estimatedTokens, truncated: smartSummaryResult.truncated }, 'Built smart summary context');
    }

    const additionalContextResult = await generateAdditionalContextIfNeeded({ contextRepositories: config.contextRepositories, additionalContextBudget: budgets.additionalContextBudget, githubToken, draftId, correlationId, correlatedLogger });
    const additionalContext = additionalContextResult.context;

    fullContext = buildFullContext({ userRequest: draft.initial_prompt, repomixContext: contextResult.context, granularity: config.granularity, fileSummaries: filteredSummaries, smartSummaries, images: base64Images.length > 0 ? base64Images : undefined, additionalContext });

    const validation = await validatePromptTokens(fullContext, modelHardLimit, correlatedLogger);
    if (validation.valid) {
      correlatedLogger.info({ tokenCount: validation.tokenCount, modelHardLimit, retryCount, filesIncluded: contextResult.includedFiles.length }, 'Context fits within model limit');
      return { fullContext, contextResult };
    }

    const overage = validation.tokenCount - (modelHardLimit - CLAUDE_CODE_OVERHEAD);
    currentRepomixLimit = Math.floor(currentRepomixLimit * 0.7);

    correlatedLogger.warn({ tokenCount: validation.tokenCount, modelHardLimit, overage, newRepomixLimit: currentRepomixLimit, retryCount: retryCount + 1 }, 'Context exceeds model limit, reducing files and retrying');

    if (currentRepomixLimit < 5000) {
      throw new PlanningFailedError(`Cannot fit context within model limit even with minimal files. Attachments and fixed content use too many tokens. Try removing large images.`);
    }
  }

  throw new PlanningFailedError(`Failed to fit context within model limit after ${maxRetries} attempts. Try removing large images or reducing context complexity.`);
}
