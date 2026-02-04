import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AgentConfig } from '../agents/types.js';
import { MODEL_SHORT_NAMES, MODEL_INFO_MAP } from './modelDefinitions.js';

export type ModelAlias = string;
export type ModelId = string;

// Re-export MODEL_SHORT_NAMES from modelDefinitions for backwards compatibility
export { MODEL_SHORT_NAMES };

/**
 * Gets the short display name for a model ID.
 * Used for PR titles and other display purposes.
 * Sources short names from modelDefinitions.ts (single source of truth).
 */
export function getModelShortName(modelId: string | undefined): string {
    if (!modelId) return 'AI';
    const modelInfo = MODEL_INFO_MAP[modelId];
    return modelInfo?.shortName || 'AI';
}

/**
 * Gets the full display name for a model ID.
 * Used for PR comments and detailed displays where the full name is preferred.
 * E.g., "Claude Opus 4.5" instead of "Claude Opus"
 */
export function getModelName(modelId: string | undefined): string {
    if (!modelId) return 'AI';
    const modelInfo = MODEL_INFO_MAP[modelId];
    return modelInfo?.name || 'AI';
}

/**
 * Result of resolving an LLM label to agent and model.
 */
export interface LlmLabelResolution {
    agentAlias: string;
    model: string;
}

/**
 * Static model aliases for backwards compatibility.
 * These map short names to full Claude model IDs.
 */
const MODEL_ALIASES: Record<ModelAlias, ModelId> = {
    'opus': 'claude-opus-4-5',
    'opus4': 'claude-opus-4-5',
    'opus-4-0': 'claude-opus-4-5',
    'claude-opus': 'claude-opus-4-5',
    'claude-opus-4-0': 'claude-opus-4-5',

    'sonnet': 'claude-sonnet-4-5',
    'sonnet4': 'claude-sonnet-4-5',
    'sonnet-4-0': 'claude-sonnet-4-5',
    'claude-sonnet': 'claude-sonnet-4-5',
    'claude-sonnet-4-0': 'claude-sonnet-4-5',

    'haiku': 'claude-haiku-4-5',
    'haiku45': 'claude-haiku-4-5',
    'haiku4': 'claude-haiku-4-5',
    'claude-haiku': 'claude-haiku-4-5',
    'claude-haiku-4-0': 'claude-haiku-4-5',
    'claude-4-5-haiku': 'claude-haiku-4-5'
};

/**
 * Gets the OpenRouter model ID for pricing lookups.
 * Uses the openRouterId field from ModelInfo (modelDefinitions.ts).
 */
function getOpenRouterId(internalModelId: ModelId): string {
    const modelInfo = MODEL_INFO_MAP[internalModelId];
    return modelInfo?.openRouterId ?? internalModelId;
}

// Default model to use when none specified
const DEFAULT_MODEL_ALIAS: ModelAlias = 'sonnet';

function resolveModelAlias(modelNameOrAlias?: string | null): ModelId {
    if (!modelNameOrAlias) {
        return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
    }

    const lowerCaseModel = modelNameOrAlias.toLowerCase();
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }

    return modelNameOrAlias;
}

function getDefaultModel(): ModelId {
    return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
}

/**
 * Resolves an LLM label (e.g., "gemini-pro", "claude-opus", "codex") to an agent alias and model.
 *
 * Resolution order:
 * 1. Check if label matches an agent alias directly (e.g., "gemini" -> gemini agent with default model)
 * 2. Check if label starts with an agent alias (e.g., "gemini-pro" -> gemini agent, find matching model)
 * 3. Check static MODEL_ALIASES for backwards compatibility (e.g., "opus" -> claude agent)
 * 4. Fall back to default agent with the label as the model name
 *
 * @param label - The LLM label without the "llm-" prefix (e.g., "gemini-pro", "claude-opus", "opus")
 * @returns Object with agentAlias and model
 */
async function resolveLlmLabel(label: string): Promise<LlmLabelResolution> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agents = registry.getAllAgents();
    const lowerLabel = label.toLowerCase();

    // 1. Check if label matches an agent alias exactly (use default model)
    for (const agent of agents) {
        if (agent.config.alias.toLowerCase() === lowerLabel) {
            return {
                agentAlias: agent.config.alias,
                model: agent.config.defaultModel || agent.config.supportedModels[0]
            };
        }
    }

    // 2. Check if label starts with an agent alias (e.g., "gemini-pro", "claude-opus")
    for (const agent of agents) {
        const aliasLower = agent.config.alias.toLowerCase();
        if (lowerLabel.startsWith(aliasLower + '-')) {
            const modelPart = label.substring(aliasLower.length + 1); // e.g., "pro" from "gemini-pro"
            const matchedModel = findMatchingModel(modelPart, agent.config);
            return {
                agentAlias: agent.config.alias,
                model: matchedModel || agent.config.defaultModel || agent.config.supportedModels[0]
            };
        }
    }

    // 3. Check static MODEL_ALIASES for backwards compatibility
    if (MODEL_ALIASES[lowerLabel]) {
        const defaultAgent = registry.getDefaultAgent();
        return {
            agentAlias: defaultAgent?.config.alias || 'default',
            model: MODEL_ALIASES[lowerLabel]
        };
    }

    // 4. Fall back to default agent with the label as model name
    const defaultAgent = registry.getDefaultAgent();
    return {
        agentAlias: defaultAgent?.config.alias || 'default',
        model: label
    };
}

/**
 * Finds a matching model from agent's supported models based on a short name.
 * E.g., "pro" matches "gemini-2.5-pro", "opus" matches "claude-opus-4-5-20251101"
 */
function findMatchingModel(shortName: string, config: AgentConfig): string | null {
    const lowerShort = shortName.toLowerCase();

    // Try exact match first
    for (const model of config.supportedModels) {
        if (model.toLowerCase() === lowerShort) {
            return model;
        }
    }

    // Try partial match (model contains the short name)
    for (const model of config.supportedModels) {
        if (model.toLowerCase().includes(lowerShort)) {
            return model;
        }
    }

    return null;
}

export {
    MODEL_ALIASES,
    DEFAULT_MODEL_ALIAS,
    resolveModelAlias,
    getDefaultModel,
    getOpenRouterId,
    resolveLlmLabel
};
