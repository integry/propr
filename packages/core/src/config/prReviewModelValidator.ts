import { resolveModelAlias } from './modelAliases.js';
import { MODEL_INFO_MAP } from './modelDefinitions.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { toProprOpenCodeModelId } from '../agents/impl/openCodeModelIds.js';

export interface PrReviewModelValidationResult {
    valid: boolean;
    error?: string;
}

export async function validatePrReviewModelValue(model: string): Promise<PrReviewModelValidationResult> {
    if (typeof model !== 'string') {
        return { valid: false, error: 'pr_review_model must be a string' };
    }
    if (model === '') return { valid: true };

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) {
        return { valid: false, error: 'pr_review_model contains invalid characters' };
    }

    const colonIdx = model.indexOf(':');
    if (colonIdx > 0 && colonIdx < model.length - 1) {
        const agentAlias = model.substring(0, colonIdx);
        const modelPart = model.substring(colonIdx + 1);
        const resolved = resolveModelAlias(modelPart);
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const agent = registry.getAgentByAlias(agentAlias);
        if (!agent) {
            return { valid: false, error: `pr_review_model agent "${agentAlias}" is not a recognized agent alias` };
        }
        if (!agent.config.enabled) {
            return { valid: false, error: `pr_review_model agent "${agentAlias}" is not enabled` };
        }
        const candidates = agent.config.type === 'opencode' ? [resolved, toProprOpenCodeModelId(resolved)] : [resolved];
        const modelSupported = agent.config.supportedModels.some((m: string) =>
            candidates.some(candidate => m.toLowerCase() === candidate.toLowerCase())
        );
        if (!modelSupported) {
            return { valid: false, error: `pr_review_model "${model}": model "${modelPart}" is not supported by agent "${agentAlias}"` };
        }
    } else {
        const resolved = resolveModelAlias(model);
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const allAgents = registry.getAllAgents();
        const canRun = allAgents.some(a =>
            a.config.enabled && a.config.supportedModels.some((m: string) => {
                const candidates = a.config.type === 'opencode' ? [resolved, toProprOpenCodeModelId(resolved)] : [resolved];
                return candidates.some(candidate => m.toLowerCase() === candidate.toLowerCase());
            })
        );
        if (!canRun) {
            if (!MODEL_INFO_MAP[resolved]) {
                return { valid: false, error: `pr_review_model "${model}" does not resolve to a known configured model` };
            }
            return { valid: false, error: `pr_review_model "${model}": no enabled agent supports this model` };
        }
    }

    return { valid: true };
}
