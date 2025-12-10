export type ContextLevel = 'minimal' | 'balanced' | 'max';

export const MODEL_LIMITS: Record<string, number> = {
  'default': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-opus-20240229': 200000,
};

export const CONTEXT_RATIOS: Record<ContextLevel, number> = {
  minimal: 0.1,
  balanced: 0.5,
  max: 0.95
};

export function getEffectiveTokenLimit(modelId: string | undefined, level: ContextLevel): number {
  const limit = MODEL_LIMITS[modelId || 'default'] || MODEL_LIMITS['default'];
  return Math.floor(limit * CONTEXT_RATIOS[level]);
}
