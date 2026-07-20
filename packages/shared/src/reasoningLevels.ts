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

export type ReasoningLevelLabel = string | { name?: string | null } | null | undefined;

const REASONING_LEVEL_LABEL_PATTERN = /^level-(low|medium|high|xhigh|max|ultra|ultracode|auto)$/i;

function getLabelName(label: ReasoningLevelLabel): string | null {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return null;
}

export function parseReasoningLevelFromLabels(labels: readonly ReasoningLevelLabel[]): ReasoningLevel | undefined {
  for (const label of labels) {
    const labelName = getLabelName(label);
    if (!labelName) continue;

    const match = labelName.match(REASONING_LEVEL_LABEL_PATTERN);
    if (match) return match[1].toLowerCase() as ReasoningLevel;
  }

  return undefined;
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
