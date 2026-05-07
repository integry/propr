import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { Agent } from '../agents/types.js';
import { loadSettings } from './configManager.js';
import { getPlanIssueDefaultSelection, type PlanIssueDefaultSelection } from './planIssueDefaultSelection.js';

function getFirstValidModel(agent: Agent | undefined): string | null {
    return agent?.config.defaultModel ?? agent?.config.supportedModels?.[0] ?? null;
}

function getFallbackAgent(registry: AgentRegistry): Agent | undefined {
    return registry.getDefaultAgent() ?? registry.getAllAgents().find(agent => agent.config.enabled);
}

export async function resolvePlanIssueDefaultSelection(
    current: Partial<PlanIssueDefaultSelection> = {}
): Promise<PlanIssueDefaultSelection> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const explicitAlias = current.agent_alias ?? null;
    const explicitModel = current.model_name ?? null;

    if (explicitAlias) {
        return {
            agent_alias: explicitAlias,
            model_name: explicitModel ?? getFirstValidModel(registry.getAgentByAlias(explicitAlias))
        };
    }

    let resolvedAgent = undefined;

    try {
        const settings = await loadSettings();
        const configuredAlias = typeof settings.default_agent_alias === 'string'
            ? settings.default_agent_alias.trim()
            : '';

        if (configuredAlias) {
            const configuredAgent = registry.getAgentByAlias(configuredAlias);
            if (configuredAgent?.config.enabled) {
                resolvedAgent = configuredAgent;
            }
        }
    } catch {
        // Ignore settings read failures and fall back to registry defaults.
    }

    resolvedAgent = resolvedAgent ?? getFallbackAgent(registry);

    if (!resolvedAgent) {
        return {
            agent_alias: null,
            model_name: explicitModel
        };
    }

    const fallbackSelection = getPlanIssueDefaultSelection(
        [{
            alias: resolvedAgent.config.alias,
            enabled: resolvedAgent.config.enabled,
            supportedModels: resolvedAgent.config.supportedModels,
            defaultModel: resolvedAgent.config.defaultModel
        }],
        resolvedAgent.config.alias,
        resolvedAgent.config.alias
    );

    return {
        agent_alias: fallbackSelection.agent_alias,
        model_name: explicitModel ?? fallbackSelection.model_name
    };
}
