import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AgentConfig } from '../agents/types.js';
import { MODEL_SHORT_NAMES, MODEL_INFO_MAP, ALL_MODELS } from './modelDefinitions.js';

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
 * Default aliases (opus, sonnet) point to latest 4.6 versions.
 * Use opus45/sonnet45 aliases for older Claude Code versions.
 */
const MODEL_ALIASES: Record<ModelAlias, ModelId> = {
    // Default aliases point to latest (4.6)
    'opus': 'claude-opus-4-6',
    'claude-opus': 'claude-opus-4-6',

    'sonnet': 'claude-sonnet-4-6',
    'claude-sonnet': 'claude-sonnet-4-6',

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
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }

    return modelNameOrAlias;
}

/**
 * Selects the preferred default model for an agent type when no explicit default is set.
 * Preference rules:
 * - Claude: prefer Opus, then Sonnet (skip Haiku)
 * - Gemini: prefer Pro models (skip Flash)
 * - Codex/OpenAI: prefer GPT (skip mini/spark variants)
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
        case 'gemini': {
            // Prefer Pro (not Flash)
            const pro = models.find((_m, i) => lowerModels[i].includes('pro'));
            if (pro) return pro;
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
 * Resolves a custom label to an agent and specific model.
 * Custom labels are now configured per-model, so this finds the exact agent+model combination.
 *
 * @param label - The full label from GitHub (e.g., "my-opus-bot", "custom-helper")
 * @returns The matching agent's alias and specific model, or null if no match
 */
async function resolveCustomLabel(label: string): Promise<LlmLabelResolution | null> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agents = registry.getAllAgents();
    const lowerLabel = label.toLowerCase();

    for (const agent of agents) {
        // Check modelCustomLabels for this agent
        if (agent.config.modelCustomLabels) {
            for (const [modelId, customLabel] of Object.entries(agent.config.modelCustomLabels)) {
                if (customLabel && customLabel.toLowerCase() === lowerLabel) {
                    return {
                        agentAlias: agent.config.alias,
                        model: modelId
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Gets all custom labels configured across all models in all agents.
 *
 * @returns Array of custom labels
 */
async function getAllCustomLabels(): Promise<string[]> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agents = registry.getAllAgents();
    const customLabels: string[] = [];

    for (const agent of agents) {
        if (agent.config.enabled && agent.config.modelCustomLabels) {
            for (const customLabel of Object.values(agent.config.modelCustomLabels)) {
                if (customLabel) {
                    customLabels.push(customLabel);
                }
            }
        }
    }

    return customLabels;
}

/**
 * Resolves an LLM label (e.g., "gemini-pro", "claude-opus", "codex") to an agent alias and model.
 *
 * Resolution order:
 * 1. Check if label matches a githubLabel from modelDefinitions (exact match for labels like "gemini-g3-flash-preview")
 * 2. Check if label matches an agent alias directly (e.g., "gemini" -> gemini agent with default model)
 * 3. Check if label starts with an agent alias (e.g., "gemini-pro" -> gemini agent, find matching model)
 * 4. Check static MODEL_ALIASES for backwards compatibility (e.g., "opus" -> claude agent)
 * 5. Fall back to default agent with the label as the model name
 *
 * @param label - The LLM label without the "llm-" prefix (e.g., "gemini-pro", "claude-opus", "opus")
 * @returns Object with agentAlias and model
 */
async function resolveLlmLabel(label: string): Promise<LlmLabelResolution> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agents = registry.getAllAgents();
    const lowerLabel = label.toLowerCase();
    const fullLabel = `llm-${lowerLabel}`;

    // 1. Check if label matches a githubLabel from modelDefinitions exactly
    // This ensures labels like "gemini-g3-flash-preview" correctly resolve to "gemini-3-flash-preview"
    for (const modelInfo of ALL_MODELS) {
        if (modelInfo.githubLabel.toLowerCase() === fullLabel) {
            // Found exact match - determine the agent from the model
            const agentType = getAgentTypeFromModel(modelInfo.id);
            const agent = agents.find(a => a.config.type === agentType);
            if (agent) {
                return {
                    agentAlias: agent.config.alias,
                    model: modelInfo.id
                };
            }
        }
    }

    // 2. Check if label matches an agent alias exactly (use default model)
    for (const agent of agents) {
        if (agent.config.alias.toLowerCase() === lowerLabel) {
            return {
                agentAlias: agent.config.alias,
                model: agent.config.defaultModel || getPreferredModelForAgent(agent.config) || agent.config.supportedModels[0]
            };
        }
    }

    // 3. Check if label starts with an agent alias (e.g., "gemini-pro", "claude-opus")
    for (const agent of agents) {
        const aliasLower = agent.config.alias.toLowerCase();
        if (lowerLabel.startsWith(aliasLower + '-')) {
            const modelPart = label.substring(aliasLower.length + 1); // e.g., "pro" from "gemini-pro"
            const matchedModel = findMatchingModel(modelPart, agent.config);
            return {
                agentAlias: agent.config.alias,
                model: matchedModel || agent.config.defaultModel || getPreferredModelForAgent(agent.config) || agent.config.supportedModels[0]
            };
        }
    }

    // 4. Check static MODEL_ALIASES for backwards compatibility
    if (MODEL_ALIASES[lowerLabel]) {
        const defaultAgent = registry.getDefaultAgent();
        return {
            agentAlias: defaultAgent?.config.alias || 'default',
            model: MODEL_ALIASES[lowerLabel]
        };
    }

    // 5. Fall back to default agent with the label as model name
    const defaultAgent = registry.getDefaultAgent();
    return {
        agentAlias: defaultAgent?.config.alias || 'default',
        model: label
    };
}

/**
 * Determines the agent type from a model ID.
 * E.g., "gemini-3-flash-preview" -> "gemini", "claude-opus-4-5-20251101" -> "claude"
 */
function getAgentTypeFromModel(modelId: string): 'claude' | 'codex' | 'gemini' {
    const lowerModel = modelId.toLowerCase();
    if (lowerModel.startsWith('gemini')) return 'gemini';
    if (lowerModel.startsWith('claude')) return 'claude';
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

/**
 * A single concrete review assignment: agent/model pair with display label.
 */
export interface ReviewAssignment {
    /** Agent alias (e.g., "claude", "gemini", "codex") */
    agentAlias: string;
    /** Resolved model ID (e.g., "claude-opus-4-6", "gemini-3-pro-preview") */
    model: string;
    /** Display-friendly label for review comments (e.g., "Claude Opus 4.6", "Gemini Pro") */
    displayLabel: string;
}

/**
 * Error thrown when a requested review model cannot be resolved to an enabled agent/model pair.
 */
export class ReviewModelResolutionError extends Error {
    /** The token(s) that could not be resolved */
    unresolvedTokens: string[];

    constructor(unresolvedTokens: string[]) {
        const tokenList = unresolvedTokens.map(t => `"${t}"`).join(', ');
        super(`Unable to resolve review model(s): ${tokenList}. No matching enabled agent/model found.`);
        this.name = 'ReviewModelResolutionError';
        this.unresolvedTokens = unresolvedTokens;
    }
}

/**
 * Resolves an array of `/review` model arguments into concrete, deduplicated review assignments.
 *
 * Each requested label is resolved via `resolveLlmLabel`. The results are deduplicated by
 * agent+model pair, and validated against the agent registry to ensure the resolved agent
 * is actually enabled with the resolved model in its supported list.
 *
 * @param requestedLabels - Normalized model labels (llm- prefix already stripped)
 * @returns Array of unique ReviewAssignment objects
 * @throws ReviewModelResolutionError if any label cannot be resolved to a valid enabled agent/model
 */
async function resolveReviewModels(requestedLabels: string[]): Promise<ReviewAssignment[]> {
    if (!requestedLabels || requestedLabels.length === 0) {
        // Default to the default model when /review is called with no arguments
        const defaultModel = getDefaultModel();
        if (!defaultModel) {
            throw new NoDefaultModelConfiguredError();
        }
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const defaultAgent = registry.getDefaultAgent();
        if (!defaultAgent) {
            throw new NoDefaultModelConfiguredError();
        }
        const modelInfo = MODEL_INFO_MAP[defaultModel];
        return [{
            agentAlias: defaultAgent.config.alias,
            model: defaultModel,
            displayLabel: modelInfo?.name || getModelShortName(defaultModel),
        }];
    }

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const seen = new Map<string, ReviewAssignment>(); // key: "agentAlias:model"
    const unresolvedTokens: string[] = [];

    for (const label of requestedLabels) {
        const resolution = await resolveLlmLabel(label);

        // Validate that the resolved agent exists and is enabled
        const agent = registry.getAgentByAlias(resolution.agentAlias);
        if (!agent) {
            unresolvedTokens.push(label);
            continue;
        }

        // Check that the resolved model is in the agent's supported models
        // (resolveLlmLabel step 5 fallback can produce arbitrary model strings)
        const modelSupported = agent.config.supportedModels.some(
            m => m.toLowerCase() === resolution.model.toLowerCase()
        );
        if (!modelSupported) {
            unresolvedTokens.push(label);
            continue;
        }

        const dedupeKey = `${resolution.agentAlias}:${resolution.model}`.toLowerCase();
        if (!seen.has(dedupeKey)) {
            const modelInfo = MODEL_INFO_MAP[resolution.model];
            const displayLabel = modelInfo?.name || getModelShortName(resolution.model);
            seen.set(dedupeKey, {
                agentAlias: resolution.agentAlias,
                model: resolution.model,
                displayLabel,
            });
        }
    }

    if (unresolvedTokens.length > 0) {
        throw new ReviewModelResolutionError(unresolvedTokens);
    }

    return Array.from(seen.values());
}

export {
    MODEL_ALIASES,
    resolveModelAlias,
    getDefaultModel,
    getPreferredModelForAgent,
    getOpenRouterId,
    resolveLlmLabel,
    resolveCustomLabel,
    getAllCustomLabels,
    findMatchingModel,
    resolveReviewModels
};
