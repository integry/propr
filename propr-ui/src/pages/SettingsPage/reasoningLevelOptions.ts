import {
  REASONING_LEVELS,
  getReasoningLevelsForAgentType,
  type AgentType,
  type ReasoningLevel
} from '@propr/shared';

const reasoningLevelLabels: Record<ReasoningLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra (Codex only)',
  ultracode: 'Ultracode (Claude only)',
  auto: 'Auto (Claude only)',
};

export function formatReasoningLevelOption(level: string, agentType?: AgentType): string {
  const displayLabel = reasoningLevelLabels[level as ReasoningLevel] ?? level;
  if (!(REASONING_LEVELS as readonly string[]).includes(level)) return displayLabel;
  if (agentType && !getReasoningLevelsForAgentType(agentType).includes(level as ReasoningLevel)) {
    const plainLabel = displayLabel.replace(/\s+\([^)]+ only\)$/, '');
    const agentLabel = agentType === 'codex' ? 'Codex' : agentType === 'claude' ? 'Claude' : agentType;
    return `${plainLabel} (unsupported for ${agentLabel}) — GitHub: level-${level}`;
  }
  return `${displayLabel} — GitHub: level-${level}`;
}

export function buildReasoningLevelSelectOptions(
  selectedReasoningLevel: string,
  supportedLevels: readonly ReasoningLevel[] = REASONING_LEVELS
): readonly (ReasoningLevel | string)[] {
  if (!selectedReasoningLevel || supportedLevels.includes(selectedReasoningLevel as ReasoningLevel)) {
    return supportedLevels;
  }
  return [...supportedLevels, selectedReasoningLevel];
}
