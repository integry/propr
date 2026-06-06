import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AgentConfig } from '../agents/types.js';
import { MODEL_SHORT_NAMES, MODEL_INFO_MAP, ALL_MODELS, AGENT_MODELS, type AgentType } from './modelDefinitions.js';

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
 * Default aliases (opus, sonnet) point to the latest versions for each tier.
 * Use opus45/sonnet45 aliases for older Claude Code versions.
 */
const MODEL_ALIASES: Record<ModelAlias, ModelId> = {
    // Default aliases point to latest tier models
    'opus': 'claude-opus-4-8',
    'claude-opus': 'claude-opus-4-8',

    // Explicit 4.8 aliases
    'opus48': 'claude-opus-4-8',
    'opus-4-8': 'claude-opus-4-8',
    'claude-opus-4-8': 'claude-opus-4-8',

    'sonnet': 'claude-sonnet-4-6',
    'claude-sonnet': 'claude-sonnet-4-6',

    // Explicit 4.7 aliases
    'opus47': 'claude-opus-4-7',
    'opus-4-7': 'claude-opus-4-7',
    'claude-opus-4-7': 'claude-opus-4-7',

    // Explicit 4.6 aliases
    'opus46': 'claude-opus-4-6',
    'opus-4-6': 'claude-opus-4-6',
    'claude-opus-4-6': 'claude-opus-4-6',

    'sonnet46': 'claude-sonnet-4-6',
    'sonnet-4-6': 'claude-sonnet-4-6',
    'claude-sonnet-4-6': 'claude-sonnet-4-6',

    // Explicit 4.5 aliases (for older Claude Code versions)
    'opus45': 'claude-opus-4-5-20251101',
    'opus-4-5': 'claude-opus-4-5-20251101',
    'claude-opus-4-5': 'claude-opus-4-5-20251101',

    'sonnet45': 'claude-sonnet-4-5-20250929',
    'sonnet-4-5': 'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',

    // Haiku aliases (only 4.5 available)
    'haiku': 'claude-haiku-4-5-20251001',
    'haiku45': 'claude-haiku-4-5-20251001',
    'claude-haiku': 'claude-haiku-4-5-20251001',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001'
};

/**
 * Gets the OpenRouter model ID for pricing lookups.
 * Uses the openRouterId field from ModelInfo (modelDefinitions.ts).
 */
function getOpenRouterId(internalModelId: ModelId): string {
    const modelInfo = MODEL_INFO_MAP[internalModelId];
    return modelInfo?.openRouterId ?? internalModelId;
}

function isOpenCodeModelId(modelId: string): boolean {
    const lowerModel = modelId.toLowerCase();
    return lowerModel.startsWith('opencode-go/') || lowerModel.startsWith('opencode:');
}

function isOpenCodeKimiModel(modelId: string): boolean {
    return isOpenCodeModelId(modelId) && modelId.toLowerCase().includes('kimi-k2.6');
}

/**
 * Error thrown when no default model is configured.
 * Users must configure at least one AI agent with a default model.
 */
export class NoDefaultModelConfiguredError extends Error {
    constructor() {
        super(
            'No default AI model configured. Please go to the AI Agents screen and set up at least one AI agent with a default model.'
        );
        this.name = 'NoDefaultModelConfiguredError';
    }
}

function resolveModelAlias(modelNameOrAlias?: string | null): ModelId {
    if (!modelNameOrAlias) {
        const defaultModel = getDefaultModel();
        if (!defaultModel) {
            throw new NoDefaultModelConfiguredError();
        }
        return defaultModel;
    }

    const lowerCaseModel = modelNameOrAlias.toLowerCase();

    // 1. Check static MODEL_ALIASES (backwards compatibility for Claude aliases)
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }

    // 2. Check if it's an exact model ID in MODEL_INFO_MAP
    if (MODEL_INFO_MAP[modelNameOrAlias]) {
        return modelNameOrAlias;
    }

    // 3. Check if it matches a shortAlias in MODEL_INFO_MAP (e.g., "mistral" -> "mistral-medium-3.5")
    for (const modelInfo of ALL_MODELS) {
        if (modelInfo.shortAlias.toLowerCase() === lowerCaseModel) {
            return modelInfo.id;
        }
    }

    // 4. Check if it matches an "agentType-shortAlias" pattern (e.g., "vibe-mistral" -> "mistral-medium-3.5")
    // This handles labels like "llm-vibe-mistral" where the prefix indicates agent type
    const dashIdx = lowerCaseModel.indexOf('-');
    if (dashIdx > 0) {
        const possibleAgentType = lowerCaseModel.substring(0, dashIdx);
        const possibleAlias = lowerCaseModel.substring(dashIdx + 1);
        const candidateModels = possibleAgentType in AGENT_MODELS
            ? AGENT_MODELS[possibleAgentType as AgentType]
            : ALL_MODELS;
        for (const modelInfo of candidateModels) {
            if (modelInfo.shortAlias.toLowerCase() === possibleAlias) {
                return modelInfo.id;
            }
        }
    }

    return modelNameOrAlias;
}

/**
 * Selects the preferred default model for an agent type when no explicit default is set.
 * Preference rules:
 * - Claude: prefer Opus, then Sonnet (skip Haiku)
 * - Antigravity: prefer Pro models, then Opus-class models
 * - Codex (OpenAI): prefer GPT (skip mini/spark variants)
 * - OpenCode: prefer the configured Kimi default
 */
function getPreferredModelForAgent(config: AgentConfig): string | null {
    const models = config.supportedModels;
    if (!models || models.length === 0) return null;

    const lowerModels = models.map(m => m.toLowerCase());

    switch (config.type) {
        case 'claude': {
            // Prefer Opus, then Sonnet
            const opus = models.find((_m, i) => lowerModels[i].includes('opus'));
            if (opus) return opus;
            const sonnet = models.find((_m, i) => lowerModels[i].includes('sonnet'));
            if (sonnet) return sonnet;
            break;
        }
        case 'antigravity': {
            // Prefer Pro (not Flash)
            const pro = models.find((_m, i) => lowerModels[i].includes('pro'));
            if (pro) return pro;
            const opus = models.find((_m, i) => lowerModels[i].includes('opus'));
            if (opus) return opus;
            break;
        }
        case 'codex': {
            // Prefer GPT (not mini, not spark)
            const gpt = models.find((_m, i) =>
                lowerModels[i].startsWith('gpt') &&
                !lowerModels[i].includes('mini') &&
                !lowerModels[i].includes('spark')
            );
            if (gpt) return gpt;
            break;
        }
        case 'opencode': {
            const kimi = models.find(isOpenCodeKimiModel);
            if (kimi) return kimi;
            break;
        }
    }

    // Ultimate fallback: first supported model
    return models[0];
}

function getDefaultModel(): ModelId | null {
    // Try env var first (explicit user configuration)
    if (process.env.DEFAULT_CLAUDE_MODEL) {
        return process.env.DEFAULT_CLAUDE_MODEL;
    }

    // Try the configured default agent's model from settings
    try {
        const registry = AgentRegistry.getInstance();
        const defaultAgent = registry.getDefaultAgent();
        if (defaultAgent) {
            // Use the agent's explicit default model if set
            if (defaultAgent.config.defaultModel) {
                return defaultAgent.config.defaultModel;
            }
            // Otherwise auto-select the preferred model for this agent type
            const preferred = getPreferredModelForAgent(defaultAgent.config);
            if (preferred) {
                return preferred;
            }
        }
    } catch {
        // Registry not initialized yet
    }

    // No default model configured - return null for clear failure
    return null;
}

/**
 * Determines the agent type from a model ID.
 * E.g., "antigravity-gemini-3-flash-preview" -> "antigravity", "claude-opus-4-5-20251101" -> "claude"
 */
function getAgentTypeFromModel(modelId: string): AgentType {
    const lowerModel = modelId.toLowerCase();
    if (isOpenCodeModelId(lowerModel)) return 'opencode';
    if (lowerModel.startsWith('antigravity')) return 'antigravity';
    if (lowerModel.startsWith('claude')) return 'claude';
    if (lowerModel.startsWith('mistral') || lowerModel.startsWith('devstral') || lowerModel.includes('vibe')) return 'vibe';
    if (lowerModel.startsWith('gpt') || lowerModel.includes('codex')) return 'codex';
    return 'claude'; // Default fallback
}

/**
 * Finds a matching model from agent's supported models based on a short name.
 * E.g., "pro" matches "gemini-2.5-pro", "opus" matches "claude-opus-4-5-20251101"
 * Also matches shortAlias from modelDefinitions (e.g., "g3-flash-preview" matches "gemini-3-flash-preview")
 */
function findMatchingModel(shortName: string, config: AgentConfig): string | null {
    const lowerShort = shortName.toLowerCase();

    // Try exact match against model ID first
    for (const model of config.supportedModels) {
        if (model.toLowerCase() === lowerShort) {
            return model;
        }
    }

    // Try exact match against shortAlias from modelDefinitions
    // This handles cases like "g3-flash-preview" matching model "gemini-3-flash-preview"
    for (const model of config.supportedModels) {
        const modelInfo = MODEL_INFO_MAP[model];
        if (modelInfo && modelInfo.shortAlias.toLowerCase() === lowerShort) {
            return model;
        }
    }

    // Try partial match (model ID contains the short name)
    for (const model of config.supportedModels) {
        if (model.toLowerCase().includes(lowerShort)) {
            return model;
        }
    }

    // Try partial match against shortAlias
    for (const model of config.supportedModels) {
        const modelInfo = MODEL_INFO_MAP[model];
        if (modelInfo && modelInfo.shortAlias.toLowerCase().includes(lowerShort)) {
            return model;
        }
    }

    return null;
}

export {
    MODEL_ALIASES,
    resolveModelAlias,
    getDefaultModel,
    getPreferredModelForAgent,
    getOpenRouterId,
    getAgentTypeFromModel,
    findMatchingModel,
};

export {
    getAllCustomLabels,
    resolveCustomLabel,
    resolveLlmLabel,
    resolveReviewModels,
    ReviewModelResolutionError,
    type ReviewAssignment,
} from './modelLabelResolution.js';
