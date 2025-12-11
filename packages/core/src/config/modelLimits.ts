export type ContextLevel = number;

export const MIN_CONTEXT_LEVEL = 10;
export const MAX_CONTEXT_LEVEL = 100;
export const CONTEXT_LEVEL_STEP = 10;
export const DEFAULT_CONTEXT_LEVEL = 50;

export const EFFECTIVE_MAX_RATIO = 0.95;

export const MODEL_LIMITS: Record<string, number> = {
  'default': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
};

export function getEffectiveTokenLimit(modelId: string | undefined, level: ContextLevel): number {
  const limit = MODEL_LIMITS[modelId || 'default'] || MODEL_LIMITS['default'];
  const clampedLevel = Math.max(MIN_CONTEXT_LEVEL, Math.min(MAX_CONTEXT_LEVEL, level));
  const ratio = (clampedLevel / 100) * EFFECTIVE_MAX_RATIO;
  return Math.floor(limit * ratio);
}
