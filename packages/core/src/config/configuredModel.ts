import { AgentRegistry } from '../agents/AgentRegistry.js';
import { NoDefaultModelConfiguredError, resolveLlmLabel } from './modelAliases.js';

/**
 * Return an explicitly configured model, or route through the configured
 * default agent and its default model. The returned fallback uses
 * `agent:model` format so lightweight calls never enter a provider-specific
 * legacy execution path.
 */
export async function resolveConfiguredModel(configuredModel?: unknown): Promise<string> {
    const model = typeof configuredModel === 'string' ? configuredModel.trim() : '';
    if (model.includes(':')) {
        return model;
    }

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    if (model) {
        const resolution = await resolveLlmLabel(model);
        if (!resolution.agentAlias || !resolution.model) {
            throw new NoDefaultModelConfiguredError();
        }
        return `${resolution.agentAlias}:${resolution.model}`;
    }

    const defaultAgent = registry.getDefaultAgent();
    const defaultModel = defaultAgent?.config.defaultModel?.trim();
    if (!defaultAgent || !defaultModel) {
        throw new NoDefaultModelConfiguredError();
    }

    return `${defaultAgent.config.alias}:${defaultModel}`;
}
