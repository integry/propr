import type { SystemAgentStatus } from '../api/proprTypes';

export const formatAgentLabel = (
  agent: Pick<SystemAgentStatus, 'type' | 'alias'>,
  agents: Pick<SystemAgentStatus, 'type' | 'alias'>[] = []
): string => {
  const matchingTypeCount = agents.filter(candidate => candidate.type === agent.type).length;
  const shouldShowAlias = agent.alias !== 'default' && (agents.length === 0 || matchingTypeCount > 1);
  const alias = shouldShowAlias ? ` (${agent.alias})` : '';
  return `${agent.type.charAt(0).toUpperCase()}${agent.type.slice(1)}${alias}`;
};
