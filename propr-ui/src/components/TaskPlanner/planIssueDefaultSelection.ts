import type { InstanceCatalogAgent } from '@propr/shared';
import { PlanIssue } from '../../api/planIssuesApi';

export interface PlanIssueDefaultSelection {
  agentAlias: string | null;
  modelName: string | null;
}

function getModelForAgent(agent: InstanceCatalogAgent | undefined): string | null {
  return agent?.defaultModel ?? agent?.supportedModels?.[0] ?? null;
}

export function resolvePlanIssueDefaultSelection(
  agents: InstanceCatalogAgent[],
  defaultAgentAlias?: string
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

/** True when the issue carries its own agent/model rather than the plan default. */
export const isOverriddenFromDefault = (
  issue: Pick<PlanIssue, 'agent_alias' | 'model_name'>,
  defaultSelection?: PlanIssueDefaultSelection | null
): boolean => {
  if (!defaultSelection?.agentAlias) return false;
  if (issue.agent_alias !== defaultSelection.agentAlias) return true;
  // A missing model on either side means "the agent's default model", so only two explicit models can differ.
  return !!issue.model_name && !!defaultSelection.modelName && issue.model_name !== defaultSelection.modelName;
};
