/**
 * Context regeneration logic for the preview service.
 */

import { estimateTokens } from '../../utils/tokenCalculation.js';
import { estimateLlmDuration } from '../../utils/llmEstimation.js';
import { findRelevantFiles } from '../relevanceService.js';
import { getAgentRegistry } from '../../agents/AgentRegistry.js';
import { generateContext } from '../contextService.js';
import { parseFileReferences, getResolvedPaths } from '../relevance/fileReferenceParser.js';
import { buildSummaryContext } from '../relevance/contextBuilder.js';

import { BranchNotFoundError, PlanningFailedError } from './planningErrors.js';
import { checkoutBranch } from './branchOperations.js';
import { updateTrace } from './traceService.js';
import { estimateContextGatheringDuration } from './previewUtils.js';
import type { RegenerateContextParams, RegenerateContextResult } from './planningTypes.js';

/**
 * Regenerate context when content has changed.
 * Performs relevance analysis, file selection, and context generation.
 */
export async function regenerateContext(params: RegenerateContextParams): Promise<RegenerateContextResult> {
  const { draftId, baseBranch, worktreePath, prompt, manualFiles, draft, contextModel, compress, previewTokenLimit, correlationId, correlatedLogger } = params;
  const securityWarnings: string[] = [];

  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out branch for preview');
  } catch (error) {
    if (error instanceof BranchNotFoundError) {
      correlatedLogger.warn({ baseBranch, worktreePath }, 'Branch not found (repo may be empty), continuing with current state');
    } else {
      throw new PlanningFailedError(`Failed to checkout branch '${baseBranch}': ${(error as Error).message}`);
    }
  }

  // Parse @file references from the prompt
  const fileRefResult = await parseFileReferences(prompt, worktreePath, { correlationId });
  const referencedFiles = getResolvedPaths(fileRefResult);
  const allManualFiles = [...manualFiles];
  if (referencedFiles.length > 0) {
    allManualFiles.push(...referencedFiles);
  }

  // Get agent for semantic scoring
  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  let agent = registry.getDefaultAgent();
  if (contextModel && contextModel.includes(':')) {
    const agentAlias = contextModel.split(':')[0];
    const selectedAgent = registry.getAgentByAlias(agentAlias);
    if (selectedAgent) agent = selectedAgent;
  }

  // Estimate duration for relevance analysis
  const estimatedInputTokens = estimateTokens(prompt);
  const relevanceEstimation = await estimateLlmDuration({
    executionType: 'context-analysis',
    modelName: contextModel || 'haiku',
    inputTokenCount: estimatedInputTokens,
    correlationId
  });

  const relevanceStartedAt = new Date().toISOString();
  correlatedLogger.info({
    estimatedDurationMs: relevanceEstimation.estimatedDurationMs,
    isHistoricalEstimate: relevanceEstimation.isHistoricalEstimate,
    sampleCount: relevanceEstimation.sampleCount
  }, 'Estimated relevance analysis duration for preview');

  await updateTrace(draftId, 'relevance', 'in_progress', {
    estimatedDuration: relevanceEstimation.estimatedDurationMs,
    startedAt: relevanceStartedAt,
    isHistoricalEstimate: relevanceEstimation.isHistoricalEstimate,
    sampleCount: relevanceEstimation.sampleCount
  });

  // Find relevant files
  const relevanceResult = await findRelevantFiles(worktreePath, fileRefResult.cleanedPrompt || prompt, {
    correlationId, useSummaryScoring: !!agent, useLLMKeywords: true, agent,
    repoName: draft.repository, branch: baseBranch, modelId: contextModel
  });

  await updateTrace(draftId, 'relevance', 'completed', {
    keywords: relevanceResult.keywordsDetected || [],
    candidates: relevanceResult.files.map(f => ({ path: f.path, reason: f.reason, score: f.score }))
  });

  const autoFilePaths = relevanceResult.files.map(f => f.path);
  const fileScores: Record<string, number> = {};
  for (const file of relevanceResult.files) {
    fileScores[file.path] = file.score;
  }
  const combinedFiles = [...new Set([...allManualFiles, ...autoFilePaths])];

  correlatedLogger.info({ manualFiles: { count: allManualFiles.length }, autoFiles: { count: autoFilePaths.length }, combinedCount: combinedFiles.length }, 'Preview file selection');

  const estimatedContextDuration = estimateContextGatheringDuration(combinedFiles.length);
  const contextStartedAt = new Date().toISOString();

  await updateTrace(draftId, 'context', 'in_progress', {
    estimatedDuration: estimatedContextDuration,
    startedAt: contextStartedAt,
    fileCount: combinedFiles.length
  });

  const filesToInclude = compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined);
  const priorityFiles = compress ? combinedFiles : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: previewTokenLimit, compress, correlationId });

  const smartSummaryBudget = Math.floor(previewTokenLimit * 0.1);
  const smartSummaryResult = await buildSummaryContext({ tokenBudget: smartSummaryBudget, priorityPaths: combinedFiles, repoName: draft.repository as string, correlationId });

  await updateTrace(draftId, 'context', 'completed', {
    includedFiles: contextResult.includedFiles,
    tokenCount: contextResult.totalTokens
  });

  if (contextResult.skippedSecurityFiles && contextResult.skippedSecurityFiles.length > 0) {
    const skippedPaths = contextResult.skippedSecurityFiles.map(f => f.filePath).join(', ');
    securityWarnings.push(`${contextResult.skippedSecurityFiles.length} file(s) skipped due to potential secrets: ${skippedPaths}`);
  }

  return {
    repomixContext: contextResult.context,
    smartSummaries: smartSummaryResult.context || undefined,
    autoFilePaths,
    includedFiles: contextResult.includedFiles,
    repomixTokens: contextResult.totalTokens,
    smartSummaryTokens: smartSummaryResult.estimatedTokens || 0,
    securityWarnings,
    fileTokenCounts: contextResult.fileTokenCounts,
    fileScores
  };
}
