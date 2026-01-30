export type ContextLevel = number;

export const MIN_CONTEXT_LEVEL = 10;
export const MAX_CONTEXT_LEVEL = 100;
export const CONTEXT_LEVEL_STEP = 10;
export const DEFAULT_CONTEXT_LEVEL = 50;

// With --tools "" and minimal system prompt, Claude Code overhead is ~1K tokens.
// The tiktoken-to-Claude conversion is handled in contextService.ts.
// Using 0.98 to leave just 2% (~4K tokens) for overhead since we validate before sending.
export const EFFECTIVE_MAX_RATIO = 0.98;

// Tiktoken (cl100k_base) underestimates tokens for code/XML content.
// Tests show actual Claude tokens are ~36% higher than tiktoken estimates.
export const TIKTOKEN_TO_CLAUDE_RATIO = 1.36;

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

/**
 * Get the model's absolute maximum token limit (hard limit).
 * This is used for validation - prompts must fit within this limit.
 */
export function getModelHardLimit(modelId: string | undefined): number {
  const limit = MODEL_LIMITS[modelId || 'default'] || MODEL_LIMITS['default'];
  // Use 98% of model limit to leave some buffer for response
  return Math.floor(limit * EFFECTIVE_MAX_RATIO);
}
