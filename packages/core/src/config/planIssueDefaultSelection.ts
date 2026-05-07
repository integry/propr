export interface PlanIssueSelectionAgent {
    alias: string;
    enabled: boolean;
    supportedModels: string[];
    defaultModel?: string;
}

export interface PlanIssueDefaultSelection {
    agent_alias: string | null;
    model_name: string | null;
}

export function getPlanIssueDefaultSelection(
    agents: PlanIssueSelectionAgent[],
    configuredDefaultAlias?: string | null,
    registryDefaultAlias?: string | null
): PlanIssueDefaultSelection {
    const enabledAgents = agents.filter(agent => agent.enabled);
    const configuredAgent = configuredDefaultAlias
        ? enabledAgents.find(agent => agent.alias === configuredDefaultAlias)
        : undefined;
    const registryDefaultAgent = registryDefaultAlias
        ? enabledAgents.find(agent => agent.alias === registryDefaultAlias)
        : undefined;
    const selectedAgent = configuredAgent ?? registryDefaultAgent ?? enabledAgents[0];

    return {
        agent_alias: selectedAgent?.alias ?? null,
        model_name: selectedAgent?.defaultModel ?? selectedAgent?.supportedModels?.[0] ?? null
    };
}
