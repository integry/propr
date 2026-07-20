import type { AgentType } from './modelDefinitions.js';

export const REASONING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'ultracode',
  'auto',
] as const;

export type ReasoningLevel = typeof REASONING_LEVELS[number];

export const CODEX_REASONING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ReasoningLevel[];

export const CLAUDE_REASONING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
  'auto',
] as const satisfies readonly ReasoningLevel[];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

export function getReasoningLevelsForAgentType(agentType: AgentType): readonly ReasoningLevel[] {
  if (agentType === 'codex') return CODEX_REASONING_LEVELS;
  if (agentType === 'claude') return CLAUDE_REASONING_LEVELS;
  return [];
}

export function isReasoningLevelSupportedByAgentType(
  agentType: AgentType,
  level: ReasoningLevel
): boolean {
  return getReasoningLevelsForAgentType(agentType).includes(level);
}
