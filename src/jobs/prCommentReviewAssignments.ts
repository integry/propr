import type { Logger } from 'pino';
import { AgentRegistry, loadPrReviewModel, resolveLlmLabel } from '@propr/core';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import type { ReviewAssignment } from './prCommentReviewRecovery.js';

export async function resolveReviewAssignments(
    requestedModels: string[] | undefined,
    llm: string | null | undefined,
    correlatedLogger: Logger,
): Promise<ReviewAssignment[]> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const assignments: ReviewAssignment[] = [];

    let modelsToReview: string[];
    if (requestedModels && requestedModels.length > 0) {
        modelsToReview = requestedModels;
    } else {
        let prReviewModel = '';
        try {
            prReviewModel = await loadPrReviewModel();
        } catch (err) {
            correlatedLogger.debug({ error: (err as Error).message }, 'Failed to load pr_review_model setting');
        }
        if (prReviewModel) {
            modelsToReview = [prReviewModel];
            correlatedLogger.info({ prReviewModel }, 'Using configured pr_review_model as default review model');
        } else if (llm) {
            modelsToReview = [llm];
            correlatedLogger.info({ llm }, 'No pr_review_model configured, falling back to llm from labels');
        } else {
            modelsToReview = ['default'];
        }
    }

    for (const modelLabel of modelsToReview) {
        try {
            if (modelLabel === 'default') {
                const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
                assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
            } else {
                const resolution = await resolveLlmLabel(modelLabel);
                assignments.push({ agentAlias: resolution.agentAlias, model: resolution.model, label: modelLabel });
            }
        } catch (resolveError) {
            correlatedLogger.warn({ modelLabel, error: (resolveError as Error).message }, 'Failed to resolve review model, skipping');
        }
    }

    if (assignments.length === 0) {
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
    }
    return assignments;
}
