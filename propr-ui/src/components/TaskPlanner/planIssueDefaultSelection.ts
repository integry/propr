import { AgentConfig, SystemSettings } from '../../api/proprApi';
import { PlanIssue } from '../../api/planIssuesApi';

export interface PlanIssueDefaultSelection {
  agentAlias: string | null;
  modelName: string | null;
}

function getModelForAgent(agent: AgentConfig | undefined): string | null {
  return agent?.defaultModel ?? agent?.supportedModels?.[0] ?? null;
}

export function resolvePlanIssueDefaultSelection(
  agents: AgentConfig[],
  defaultAgentAlias?: SystemSettings['default_agent_alias']
): PlanIssueDefaultSelection {
  const enabledAgents = agents.filter(agent => agent.enabled);
  const configuredAgent = defaultAgentAlias
    ? enabledAgents.find(agent => agent.alias === defaultAgentAlias)
    : undefined;
  const fallbackAgent = enabledAgents.find(agent => agent.alias === 'default') ?? enabledAgents[0];
  const selectedAgent = configuredAgent ?? fallbackAgent;

  return {
    agentAlias: selectedAgent?.alias ?? null,
    modelName: getModelForAgent(selectedAgent)
  };
}

export function applyPlanIssueDefaults(
  issues: PlanIssue[],
  selection: PlanIssueDefaultSelection
): PlanIssue[] {
  if (!selection.agentAlias) {
    return issues;
  }

  return issues.map(issue => {
    if (issue.status === 'pending' && !issue.agent_alias && !issue.model_name) {
      return {
        ...issue,
        agent_alias: selection.agentAlias,
        model_name: selection.modelName
      };
    }

    return issue;
  });
}
