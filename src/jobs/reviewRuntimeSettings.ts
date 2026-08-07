import { loadSettings } from '@propr/core';
import type { Logger } from 'pino';

export interface ReviewRuntimeSettings {
    reviewPromptOverride: string;
    reviewContextEnabled: boolean;
    reviewContextModel: string;
    configuredReviewMaxContextTokens: number;
}

export async function loadReviewRuntimeSettings(correlatedLogger: Logger): Promise<ReviewRuntimeSettings> {
    const defaults: ReviewRuntimeSettings = {
        reviewPromptOverride: '',
        reviewContextEnabled: true,
        reviewContextModel: '',
        configuredReviewMaxContextTokens: 0,
    };
    try {
        const configured = await loadSettings() as Record<string, unknown>;
        return {
            reviewPromptOverride: typeof configured.pr_review_prompt === 'string' ? configured.pr_review_prompt : '',
            reviewContextEnabled: typeof configured.pr_review_context_enabled === 'boolean' ? configured.pr_review_context_enabled : true,
            reviewContextModel: typeof configured.pr_review_context_model === 'string' && configured.pr_review_context_model
                ? configured.pr_review_context_model
                : (typeof configured.analysis_model_fast === 'string' ? configured.analysis_model_fast : ''),
            configuredReviewMaxContextTokens: typeof configured.pr_review_max_context_tokens === 'number' && Number.isInteger(configured.pr_review_max_context_tokens)
                ? configured.pr_review_max_context_tokens
                : 0,
        };
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message }, 'Failed to load review settings, using defaults');
        return defaults;
    }
}
