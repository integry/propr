import type { SystemAgentStatus } from '../api/proprTypes';

export const formatAgentLabel = (agent: Pick<SystemAgentStatus, 'type' | 'alias'>): string => {
  const alias = agent.alias === 'default' ? '' : ` (${agent.alias})`;
  return `${agent.type.charAt(0).toUpperCase()}${agent.type.slice(1)}${alias}`;
};
