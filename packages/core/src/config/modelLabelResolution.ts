import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AgentConfig } from '../agents/types.js';
import { toProprOpenCodeModelId } from '../agents/impl/openCodeModelIds.js';
import { ALL_MODELS, MODEL_INFO_MAP, type AgentType } from './modelDefinitions.js';
import {
    MODEL_ALIASES,
    NoDefaultModelConfiguredError,
    findMatchingModel,
    getAgentTypeFromModel,
    getDefaultModel,
    getModelShortName,
    getPreferredModelForAgent,
    resolveModelAlias,
    type LlmLabelResolution,
} from './modelAliases.js';

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
 * Resolves a full github label (e.g., "llm-gemini-g3-flash-preview") to an agent alias and model
 * by matching against modelDefinitions' githubLabel field.
 */
function findAgentByType(agentType: AgentType, agents: { config: AgentConfig }[]): { config: AgentConfig } | null {
    return agents.find(a => a.config.type === agentType && a.config.enabled) || agents.find(a => a.config.type === agentType) || null;
}

function resolveByGithubLabel(fullLabel: string, agents: { config: AgentConfig }[]): LlmLabelResolution | null {
    for (const modelInfo of ALL_MODELS) {
        if (modelInfo.githubLabel.toLowerCase() === fullLabel) {
            const agentType = getAgentTypeFromModel(modelInfo.id);
            const agent = findAgentByType(agentType, agents);
            return { agentAlias: agent?.config.alias || agentType, model: modelInfo.id };
        }
    }
    return null;
}

function resolveBySupportedModelId(label: string, agents: { config: AgentConfig }[]): LlmLabelResolution | null {
    const lowerLabel = label.toLowerCase();

    for (const agent of agents) {
        const model = agent.config.supportedModels.find(m => m.toLowerCase() === lowerLabel);
        if (model) {
            return { agentAlias: agent.config.alias, model };
        }

        if (agent.config.type === 'opencode') {
            const proprOpenCodeModel = toProprOpenCodeModelId(label).toLowerCase();
            const prefixedModel = agent.config.supportedModels.find(m => m.toLowerCase() === proprOpenCodeModel);
            if (prefixedModel) {
                return { agentAlias: agent.config.alias, model: prefixedModel };
            }
        }
    }

    return null;
}

function resolveByAgentTypePrefix(label: string, agents: { config: AgentConfig }[]): LlmLabelResolution | null {
    const lowerLabel = label.toLowerCase();
    const agentTypes: AgentType[] = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'];

    for (const agentType of agentTypes) {
        if (!lowerLabel.startsWith(`${agentType}-`)) {
            continue;
        }

        const modelPart = label.substring(agentType.length + 1);
        const agent = findAgentByType(agentType, agents);
        const matchedModel = agent ? findMatchingModel(modelPart, agent.config) : null;
        const resolvedModel = matchedModel || resolveModelAlias(`${agentType}-${modelPart}`);

        if (getAgentTypeFromModel(resolvedModel) === agentType) {
            return { agentAlias: agent?.config.alias || agentType, model: resolvedModel };
        }
    }

    return null;
}

function resolveExplicitAgentModelLabel(label: string, agents: { config: AgentConfig }[]): LlmLabelResolution | null {
    const colonIdx = label.indexOf(':');
    if (colonIdx <= 0 || colonIdx >= label.length - 1) {
        return null;
    }

    const explicitAlias = label.substring(0, colonIdx);
    const explicitModel = label.substring(colonIdx + 1);
    const resolvedModel = resolveModelAlias(explicitModel);
    const agent = agents.find(a => a.config.alias.toLowerCase() === explicitAlias.toLowerCase());
    if (!agent) {
        return null;
    }

    const candidateModels = agent.config.type === 'opencode'
        ? [resolvedModel, toProprOpenCodeModelId(resolvedModel)]
        : [resolvedModel];
    const supportedModel = agent.config.supportedModels.find(m =>
        candidateModels.some(candidate => m.toLowerCase() === candidate.toLowerCase())
    );
    if (!supportedModel) {
        return null;
    }

    return { agentAlias: agent.config.alias, model: supportedModel };
}

function resolveAgentAliasLabel(lowerLabel: string, agents: { config: AgentConfig }[]): LlmLabelResolution | null {
    for (const agent of agents) {
        if (agent.config.alias.toLowerCase() === lowerLabel) {
            return {
                agentAlias: agent.config.alias,
                model: agent.config.defaultModel || getPreferredModelForAgent(agent.config) || agent.config.supportedModels[0]
            };
        }
    }

    return null;
}

function resolveAgentPrefixedLabel(
    label: string,
    lowerLabel: string,
    agents: { config: AgentConfig }[]
): LlmLabelResolution | null {
    for (const agent of agents) {
        const aliasLower = agent.config.alias.toLowerCase();
        if (lowerLabel.startsWith(aliasLower + '-')) {
            const modelPart = label.substring(aliasLower.length + 1); // e.g., "pro" from "gemini-pro"
            const matchedModel = findMatchingModel(modelPart, agent.config);
            if (!matchedModel && agent.config.type === 'opencode') {
                continue;
            }
            return {
                agentAlias: agent.config.alias,
                model: matchedModel || agent.config.defaultModel || getPreferredModelForAgent(agent.config) || agent.config.supportedModels[0]
            };
        }
    }

    return null;
}

function resolveStaticModelAliasLabel(lowerLabel: string): LlmLabelResolution | null {
    const model = MODEL_ALIASES[lowerLabel];
    if (!model) return null;

    const defaultAgent = AgentRegistry.getInstance().getDefaultAgent();
    return { agentAlias: defaultAgent?.config.alias || 'default', model };
}

/**
 * Resolves an LLM label (e.g., "gemini-pro", "claude-opus", "codex") to an agent alias and model.
 *
 * Resolution order:
 * 1. Check if label is an exact configured model ID, including prefixed dynamic OpenCode IDs like "opencode-openai/gpt-5.5"
 * 2. Check explicit "agentAlias:modelId" format (used by settings UI for pr_review_model)
 * 3. Check if label matches a githubLabel from modelDefinitions (exact match for labels like "gemini-g3-flash-preview")
 * 4. Check if label matches an agent alias directly (e.g., "gemini" -> gemini agent with default model)
 * 5. Check if label starts with an agent alias (e.g., "gemini-pro" -> gemini agent, find matching model)
 * 6. Check static MODEL_ALIASES for backwards compatibility (e.g., "opus" -> claude agent)
 * 7. Fall back to default agent with the label as the model name
 *
 * @param label - The LLM label without the "llm-" prefix (e.g., "gemini-pro", "claude-opus", "opus")
 * @returns Object with agentAlias and model
 */
async function resolveLlmLabel(label: string): Promise<LlmLabelResolution> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agents = registry.getAllAgents();

    const supportedModelMatch = resolveBySupportedModelId(label, agents);
    if (supportedModelMatch) {
        return supportedModelMatch;
    }

    // Handle explicit "agentAlias:modelId" format (used by settings UI for pr_review_model)
    const explicitLabelMatch = resolveExplicitAgentModelLabel(label, agents);
    if (explicitLabelMatch) {
        return explicitLabelMatch;
    }

    const lowerLabel = label.toLowerCase();
    const fullLabel = `llm-${lowerLabel}`;

    // Check if label matches a githubLabel from modelDefinitions exactly
    // This ensures labels like "gemini-g3-flash-preview" correctly resolve to "gemini-3-flash-preview"
    const githubLabelMatch = resolveByGithubLabel(fullLabel, agents);
    if (githubLabelMatch) {
        return githubLabelMatch;
    }

    // Check generated "agentType-modelAlias" labels even when the configured
    // agent alias is different from the built-in type name.
    const agentTypePrefixMatch = resolveByAgentTypePrefix(label, agents);
    if (agentTypePrefixMatch) {
        return agentTypePrefixMatch;
    }

    const agentAliasMatch = resolveAgentAliasLabel(lowerLabel, agents);
    if (agentAliasMatch) {
        return agentAliasMatch;
    }

    const agentPrefixMatch = resolveAgentPrefixedLabel(label, lowerLabel, agents);
    if (agentPrefixMatch) {
        return agentPrefixMatch;
    }

    const staticAliasMatch = resolveStaticModelAliasLabel(lowerLabel);
    if (staticAliasMatch) {
        return staticAliasMatch;
    }

    const defaultAgent = registry.getDefaultAgent();
    return { agentAlias: defaultAgent?.config.alias || 'default', model: label };
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

function getRoutedOpenCodeModelName(modelId: string): string | null {
    const lowerModel = modelId.toLowerCase();
    if (!lowerModel.startsWith('opencode:')) return null;

    const routedModel = lowerModel.substring('opencode:'.length);
    return routedModel.substring(routedModel.lastIndexOf('/') + 1);
}

function isOpenCodeModelId(modelId: string): boolean {
    const lowerModel = modelId.toLowerCase();
    return lowerModel.startsWith('opencode-') || lowerModel.startsWith('opencode/') || lowerModel.startsWith('opencode-go/') || lowerModel.startsWith('opencode:');
}

function getReviewDisplayLabel(modelId: string): string {
    const modelInfo = MODEL_INFO_MAP[modelId];
    if (modelInfo) return modelInfo.name;

    const routedOpenCodeModelName = getRoutedOpenCodeModelName(modelId);
    if (!routedOpenCodeModelName) return getModelShortName(modelId);

    const routedModelInfo = ALL_MODELS.find(model => {
        const lowerModelId = model.id.toLowerCase();
        return isOpenCodeModelId(model.id) && lowerModelId.substring(lowerModelId.lastIndexOf('/') + 1) === routedOpenCodeModelName;
    });
    return routedModelInfo?.name || routedOpenCodeModelName;
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
        return [{
            agentAlias: defaultAgent.config.alias,
            model: defaultModel,
            displayLabel: getReviewDisplayLabel(defaultModel),
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
        if (!agent || !agent.config.enabled) {
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
            seen.set(dedupeKey, { agentAlias: resolution.agentAlias, model: resolution.model, displayLabel: getReviewDisplayLabel(resolution.model) });
        }
    }

    if (unresolvedTokens.length > 0) {
        throw new ReviewModelResolutionError(unresolvedTokens);
    }

    return Array.from(seen.values());
}

export {
    getAllCustomLabels,
    resolveCustomLabel,
    resolveLlmLabel,
    resolveReviewModels,
};
