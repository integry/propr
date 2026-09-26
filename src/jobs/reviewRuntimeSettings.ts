import { loadSettings } from '@propr/core';
import { DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT, normalizeLegacyReviewMaxContextTokens, normalizeReviewContextBudgetPercent } from '@propr/shared';
import type { Logger } from 'pino';

export interface ReviewRuntimeSettings {
    reviewPromptOverride: string;
    reviewContextEnabled: boolean;
    reviewContextModel: string;
    fastAnalysisModel: string;
    /** Retained legacy absolute token cap (`pr_review_max_context_tokens`); 0 = none. */
    configuredReviewMaxContextTokens: number;
    /** Percentage of each reviewer's safe input capacity; missing/legacy 0 = 100. */
    reviewContextBudgetPercent: number;
}

export async function loadReviewRuntimeSettings(correlatedLogger: Logger): Promise<ReviewRuntimeSettings> {
    const fastAnalysisModelDefault = process.env.ANALYSIS_MODEL_FAST || '';
    const defaults: ReviewRuntimeSettings = {
        reviewPromptOverride: '',
        reviewContextEnabled: true,
        reviewContextModel: '',
        fastAnalysisModel: fastAnalysisModelDefault,
        configuredReviewMaxContextTokens: 0,
        reviewContextBudgetPercent: DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT,
    };
    try {
        const configured = await loadSettings() as Record<string, unknown>;
        return {
            reviewPromptOverride: typeof configured.pr_review_prompt === 'string' ? configured.pr_review_prompt : '',
            reviewContextEnabled: typeof configured.pr_review_context_enabled === 'boolean' ? configured.pr_review_context_enabled : true,
            reviewContextModel: typeof configured.pr_review_context_model === 'string' ? configured.pr_review_context_model : '',
            fastAnalysisModel: typeof configured.analysis_model_fast === 'string'
                ? configured.analysis_model_fast
                : fastAnalysisModelDefault,
            configuredReviewMaxContextTokens: normalizeLegacyReviewMaxContextTokens(configured.pr_review_max_context_tokens),
            reviewContextBudgetPercent: normalizeReviewContextBudgetPercent(configured.pr_review_context_budget_percent),
        };
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message }, 'Failed to load review settings, using defaults');
        return defaults;
    }
}
