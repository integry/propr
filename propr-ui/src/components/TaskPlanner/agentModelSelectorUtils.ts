import { AgentModelPair } from '../../api/planIssuesApi';
import { getModelDisplayName } from '../../utils/modelDisplay';

export type AgentModelPairWithDisplay = AgentModelPair & { displayName: string };

const getSelectBaseClass = (compact: boolean): string =>
  compact ? 'text-xs px-2 py-1 pr-6' : 'text-sm px-3 py-1.5 pr-8';

export const getSelectClass = (compact: boolean): string => `
  ${getSelectBaseClass(compact)}
  appearance-none
  bg-white
  border border-gray-300
  rounded-md
  focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500
  disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed
  transition-colors
`.trim();

export const getMultiButtonLabel = (count: number): string => {
  if (count === 0) return 'Select Agents';
  return `${count} agent${count !== 1 ? 's' : ''}`;
};
