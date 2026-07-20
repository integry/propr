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
