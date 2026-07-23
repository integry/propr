import { REASONING_LEVELS, type ReasoningLevel } from '@propr/shared';

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

export function formatReasoningLevelOption(level: string): string {
  const displayLabel = reasoningLevelLabels[level as ReasoningLevel] ?? level;
  if (!(REASONING_LEVELS as readonly string[]).includes(level)) return displayLabel;
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
