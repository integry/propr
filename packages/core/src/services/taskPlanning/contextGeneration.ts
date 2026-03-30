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
  let currentSmartSummaryBudget = budgets.smartSummaryBudget;
  let contextResult: Awaited<ReturnType<typeof generateContext>> | undefined;
  let fullContext = '';
  let retryCount = 0;
  // Track current files - use reduced set from previous iteration
  let currentFilePaths = relevantFilePaths.length > 0 ? [...relevantFilePaths] : [];

  // Keep reducing context until it fits or we hit the minimum limit
  while (currentRepomixLimit >= 5000) {
    // Include all repo files, using relevance-detected files as priority.
    // Token budget constraints dictate how many files fit into the prompt.
    const priorityFiles = currentFilePaths.length > 0 ? currentFilePaths : undefined;
    contextResult = await generateContext({ repoPath: worktreePath, filesToInclude: undefined, priorityFiles, tokenLimit: currentRepomixLimit, compress: config.compress, correlationId });

    // Update currentFilePaths with whatever files were actually included after optimization
    if (contextResult.includedFiles.length < currentFilePaths.length) {
      currentFilePaths = contextResult.includedFiles;
      correlatedLogger.info({ originalFiles: relevantFilePaths.length, currentFiles: currentFilePaths.length }, 'Updated file list from optimization');
    }

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

    const smartSummaryResult = await buildSummaryContext({ tokenBudget: currentSmartSummaryBudget, priorityPaths: currentFilePaths.length > 0 ? currentFilePaths : relevantFilePaths, repoName: draft.repository, correlationId });
    const smartSummaries = smartSummaryResult.context || undefined;
    if (smartSummaries) {
      correlatedLogger.info({ fileSummaryCount: smartSummaryResult.fileSummaryCount, dirSummaryCount: smartSummaryResult.dirSummaryCount, estimatedTokens: smartSummaryResult.estimatedTokens, truncated: smartSummaryResult.truncated }, 'Built smart summary context');
    }

    const additionalContextResult = await generateAdditionalContextIfNeeded({ contextRepositories: config.contextRepositories, additionalContextBudget: budgets.additionalContextBudget, githubToken, draftId, correlationId, correlatedLogger });
    const additionalContext = additionalContextResult.context;

    fullContext = buildFullContext({ userRequest: draft.initial_prompt, repomixContext: contextResult.context, granularity: config.granularity, fileSummaries: filteredSummaries, smartSummaries, images: base64Images.length > 0 ? base64Images : undefined, additionalContext });

    const validation = await validatePromptTokens(fullContext, modelHardLimit, correlatedLogger, generationModel);
    if (validation.valid) {
      correlatedLogger.info({ tokenCount: validation.tokenCount, modelHardLimit, retryCount, filesIncluded: contextResult.includedFiles.length }, 'Context fits within model limit');
      return { fullContext, contextResult };
    }

    const overage = validation.tokenCount - (modelHardLimit - CLAUDE_CODE_OVERHEAD);
    // Calculate reduction ratio based on actual overage, with 10% extra buffer
    const targetTokens = modelHardLimit - CLAUDE_CODE_OVERHEAD;
    const reductionRatio = Math.max(0.5, (targetTokens / validation.tokenCount) * 0.9);
    currentRepomixLimit = Math.floor(currentRepomixLimit * reductionRatio);
    currentSmartSummaryBudget = Math.floor(currentSmartSummaryBudget * reductionRatio);

    retryCount++;
    correlatedLogger.warn({ tokenCount: validation.tokenCount, modelHardLimit, overage, newRepomixLimit: currentRepomixLimit, newSmartSummaryBudget: currentSmartSummaryBudget, retryCount }, 'Context exceeds model limit, reducing files and retrying');
  }

  // If we exit the loop, it means currentRepomixLimit dropped below 5000
  throw new PlanningFailedError(`Cannot fit context within model limit even with minimal files. Attachments and fixed content use too many tokens. Try removing large images.`);
}
