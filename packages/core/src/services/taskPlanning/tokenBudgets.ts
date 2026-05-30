/**
 * Token budget calculation for plan generation.
 */

import { PlanningFailedError } from '../planning/planningErrors.js';
import { CHARS_PER_TOKEN } from '../planning/planningTypes.js';
import type { TokenBudgetOptions, TokenBudgetResult } from './types.js';

/** Maximum percentage of token budget that attachments can consume */
const MAX_ATTACHMENT_PERCENT = 0.25;

/** Safety factor to account for tiktoken-to-Claude estimation variance */
const BUDGET_SAFETY_FACTOR = 0.85;

/** Reserved overhead for system prompts, XML structure, etc. */
const RESERVED_OVERHEAD_TOKENS = 5000;

const FULL_SCAN_CONTEXT_LEVEL = 80;

/**
 * Calculate token budgets for different context components.
 * Allocates fixed percentages to ensure repomix always gets at least 50% of available space.
 * Applies a safety factor to account for tiktoken estimation variance.
 */
export function calculateTokenBudgets(options: TokenBudgetOptions): TokenBudgetResult {
  const { tokenLimit, contextLevel, attachmentTokens, fullSummaryText, hasContextRepositories, correlatedLogger } = options;

  // Apply safety factor to total budget to account for tiktoken-to-Claude variance
  const safeTokenLimit = Math.floor(tokenLimit * BUDGET_SAFETY_FACTOR);

  // Cap attachments at 25% of budget
  const attachmentBudget = Math.floor(safeTokenLimit * MAX_ATTACHMENT_PERCENT);
  const effectiveAttachmentTokens = Math.min(attachmentTokens, attachmentBudget);
  const attachmentsCapped = attachmentTokens > attachmentBudget;

  if (attachmentsCapped) {
    correlatedLogger.warn({
      attachmentTokens, attachmentBudget, tokenLimit,
      percentUsed: Math.round((attachmentTokens / tokenLimit) * 100)
    }, 'Attachments exceed budget - images may be excluded or context reduced');
  }

  // Calculate available space after attachments and overhead
  const availableAfterFixed = safeTokenLimit - effectiveAttachmentTokens - RESERVED_OVERHEAD_TOKENS;

  // Allocate fixed percentages of the available space:
  // - 10% for file summaries (capped)
  // - 10% for smart summaries
  // - 20% for additional context repos (if any)
  // - Remaining 60-80% for repomix code context
  const fileSummaryBudget = Math.floor(availableAfterFixed * 0.10);
  const smartSummaryBudget = Math.floor(availableAfterFixed * 0.10);
  const additionalContextBudget = hasContextRepositories ? Math.floor(availableAfterFixed * 0.20) : 0;

  // Calculate actual summary cost and cap it
  const rawSummaryCost = Math.ceil(fullSummaryText.length / CHARS_PER_TOKEN);
  const summaryTokenCost = Math.min(rawSummaryCost, fileSummaryBudget);
  const summaryTruncated = rawSummaryCost > fileSummaryBudget;

  // Repomix gets the rest
  const repomixTokenLimit = Math.max(5000, availableAfterFixed - summaryTokenCost - smartSummaryBudget - additionalContextBudget);

  // Error if there's not enough room for context
  if (repomixTokenLimit < 5000) {
    throw new PlanningFailedError(
      `Attachments use ${attachmentTokens} tokens, leaving insufficient room for code context. ` +
      `Try removing large images or increasing the context level.`
    );
  }

  correlatedLogger.info({
    totalLimit: tokenLimit, safeTokenLimit, attachmentTokens, effectiveAttachmentTokens, attachmentsCapped,
    rawSummaryCost, summaryCost: summaryTokenCost, summaryTruncated, fileSummaryBudget,
    smartSummaryBudget, additionalContextBudget, repomixLimit: repomixTokenLimit, contextLevel
  }, 'Calculated token budgets');

  return { summaryTokenCost, smartSummaryBudget, additionalContextBudget, repomixTokenLimit };
}

export function calculateEffectiveAdditionalContextBudget(options: {
  baseBudget: number;
  repomixBudget: number;
  repomixTokensUsed: number;
  tokenLimit: number;
  contextLevel?: number;
}): number {
  const { baseBudget, repomixBudget, repomixTokensUsed, tokenLimit, contextLevel } = options;
  if (!baseBudget) return 0;
  if ((contextLevel ?? 0) < FULL_SCAN_CONTEXT_LEVEL) return baseBudget;

  const unusedRepomixBudget = Math.max(0, repomixBudget - repomixTokensUsed);
  return Math.min(tokenLimit, baseBudget + unusedRepomixBudget);
}
