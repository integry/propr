import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { Agent } from '../agents/types.js';
import logger from './logger.js';

/**
 * Result of resolving an agent and model from labels.
 */
export interface ResolvedAgent {
    agent: Agent;
    model: string;
}

/**
 * Resolves the agent and model to use based on issue labels.
 *
 * Strategy:
 * 1. Look for 'llm-<alias>' label.
 * 2. If found, verify alias exists in Registry.
 * 3. Look for 'model-<modelId>' label (optional override).
 * 4. If no 'model-*' label, use agent's default model or first supported model.
 * 5. If no 'llm-*' label, returns null (caller should use system default).
 *
 * @param labels - Array of label strings from the issue
 * @returns ResolvedAgent with agent instance and model, or null if no llm label found
 */
export function resolveAgentFromLabels(labels: string[]): ResolvedAgent | null {
    const registry = AgentRegistry.getInstance();

    // 1. Find Agent from llm-* label
    const agentLabel = labels.find(l => l.startsWith('llm-'));
    if (!agentLabel) return null;

    const llmPart = agentLabel.replace('llm-', '');

    // Get all registered agents to check against
    const agents = registry.getAllAgents();

    // Try to find agent by direct alias match first (e.g., "llm-gemini" -> "gemini")
    let matchedAgent: Agent | undefined;
    let modelFromLabel: string | undefined;

    // Check exact alias match (e.g., "llm-gemini" where "gemini" is the alias)
    for (const agent of agents) {
        const aliasLower = agent.config.alias.toLowerCase();
        const llmPartLower = llmPart.toLowerCase();

        if (aliasLower === llmPartLower) {
            // Exact match - use agent's default model
            matchedAgent = agent;
            break;
        }

        // Check if llmPart starts with alias (e.g., "llm-gemini-pro" or "llm-claude-opus")
        if (llmPartLower.startsWith(aliasLower + '-')) {
            matchedAgent = agent;
            const modelPart = llmPart.substring(aliasLower.length + 1);
            // Try to find matching model from supported models
            modelFromLabel = findMatchingModel(modelPart, agent.config.supportedModels);
            break;
        }
    }

    if (!matchedAgent) {
        logger.warn({ llmPart, labels }, 'Label referenced unknown agent alias');
        return null;
    }

    // 2. Determine model - first check for explicit model-* override
    let model = modelFromLabel || matchedAgent.config.defaultModel || matchedAgent.config.supportedModels[0];

    const modelLabel = labels.find(l => l.startsWith('model-'));
    if (modelLabel) {
        const reqModel = modelLabel.replace('model-', '');
        // Validate model is supported by this agent
        const resolvedModel = findMatchingModel(reqModel, matchedAgent.config.supportedModels);
        if (resolvedModel) {
            model = resolvedModel;
        } else {
            logger.warn({
                reqModel,
                supported: matchedAgent.config.supportedModels
            }, 'Requested model not supported by agent, using default');
        }
    }

    return { agent: matchedAgent, model };
}

/**
 * Parses a composite settings value in the format 'alias:model' and resolves to agent/model.
 *
 * @param settingValue - A string in format "alias:model" or just "alias"
 * @returns ResolvedAgent with agent instance and model, or null if not found
 */
export function resolveAgentFromSetting(settingValue: string): ResolvedAgent | null {
    if (!settingValue) return null;

    const registry = AgentRegistry.getInstance();

    // Parse the setting value - can be "alias:model" or just "alias"
    const parts = settingValue.split(':');
    const alias = parts[0];
    const modelPart = parts[1];

    const agent = registry.getAgentByAlias(alias);
    if (!agent) {
        logger.warn({ alias, settingValue }, 'Configured agent alias not found in registry');
        return null;
    }

    // Resolve model
    let model: string;
    if (modelPart) {
        // Try to match the specified model against supported models
        const matchedModel = findMatchingModel(modelPart, agent.config.supportedModels);
        if (matchedModel) {
            model = matchedModel;
        } else {
            // Model specified but not found in supported list - use as-is (might be valid full model ID)
            model = modelPart;
        }
    } else {
        // No model specified - use agent's default
        model = agent.config.defaultModel || agent.config.supportedModels[0];
    }

    return { agent, model };
}

/**
 * Finds a matching model from supported models based on a short name or partial match.
 * E.g., "pro" matches "gemini-2.5-pro", "opus" matches "claude-opus-4-5"
 *
 * @param shortName - Short model name or alias
 * @param supportedModels - Array of supported model IDs
 * @returns Matched model ID or undefined if no match
 */
function findMatchingModel(shortName: string, supportedModels: string[]): string | undefined {
    const lowerShort = shortName.toLowerCase();

    // Try exact match first
    for (const model of supportedModels) {
        if (model.toLowerCase() === lowerShort) {
            return model;
        }
    }

    // Try partial match (model contains the short name)
    for (const model of supportedModels) {
        if (model.toLowerCase().includes(lowerShort)) {
            return model;
        }
    }

    return undefined;
}

/**
 * Gets the default agent and model from the registry.
 * This is the fallback when no labels or settings specify an agent.
 *
 * @returns ResolvedAgent with default agent and model, or null if no agents registered
 */
export function getDefaultAgentResolution(): ResolvedAgent | null {
    const registry = AgentRegistry.getInstance();
    const defaultAgent = registry.getDefaultAgent();

    if (!defaultAgent) {
        return null;
    }

    return {
        agent: defaultAgent,
        model: defaultAgent.config.defaultModel || defaultAgent.config.supportedModels[0]
    };
}
