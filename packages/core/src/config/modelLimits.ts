import { MODEL_INFO_MAP } from './modelDefinitions.js';

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
// Codex/OpenAI reasoning models reserve ~128K tokens for output/tooling, so the
// usable input cap is materially lower than the advertised 400K context window.
export const CODEX_CLI_CONTEXT_LIMIT = 272000;

export const MODEL_LIMITS: Record<string, number> = {
  'default': 200000,
  // Claude 4.6 models (1M context)
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 1000000,
  // Claude 4.5 models (200K context)
  'claude-opus-4-5': 200000,
  'claude-opus-4-5-20251101': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

function shouldApplyCodexCliLimit(agentAlias: string, modelId: string): boolean {
  const normalizedModelId = modelId.toLowerCase();
  return agentAlias === 'codex' && (
    normalizedModelId.startsWith('gpt-') ||
    normalizedModelId.includes('codex')
  );
}

export function getEffectiveTokenLimit(modelId: string | undefined, level: ContextLevel): number {
  let limit = MODEL_LIMITS['default'];
  let agentAlias = '';
  let effectiveModelId = '';

  if (modelId) {
    // Handle agent:model format if present
    const colonIdx = modelId.indexOf(':');
    agentAlias = colonIdx >= 0 ? modelId.substring(0, colonIdx).toLowerCase() : '';
    effectiveModelId = colonIdx >= 0 ? modelId.substring(colonIdx + 1) : modelId;
    const modelInfo = MODEL_INFO_MAP[effectiveModelId];

    if (modelInfo?.maxTokens) {
      limit = modelInfo.maxTokens;
    } else if (MODEL_LIMITS[effectiveModelId]) {
      limit = MODEL_LIMITS[effectiveModelId];
    }

    if (shouldApplyCodexCliLimit(agentAlias, effectiveModelId)) {
      limit = Math.min(limit, CODEX_CLI_CONTEXT_LIMIT);
    }
  }

  const clampedLevel = Math.max(MIN_CONTEXT_LEVEL, Math.min(MAX_CONTEXT_LEVEL, level));
  const ratio = (clampedLevel / 100) * EFFECTIVE_MAX_RATIO;
  return Math.floor(limit * ratio);
}

/**
 * Get the model's absolute maximum token limit (hard limit).
 * This is used for validation - prompts must fit within this limit.
 */
export function getModelHardLimit(modelId: string | undefined): number {
  let limit = MODEL_LIMITS['default'];
  let agentAlias = '';
  let effectiveModelId = '';

  if (modelId) {
    // Handle agent:model format if present
    const colonIdx = modelId.indexOf(':');
    agentAlias = colonIdx >= 0 ? modelId.substring(0, colonIdx).toLowerCase() : '';
    effectiveModelId = colonIdx >= 0 ? modelId.substring(colonIdx + 1) : modelId;
    const modelInfo = MODEL_INFO_MAP[effectiveModelId];

    if (modelInfo?.maxTokens) {
      limit = modelInfo.maxTokens;
    } else if (MODEL_LIMITS[effectiveModelId]) {
      limit = MODEL_LIMITS[effectiveModelId];
    }

    if (shouldApplyCodexCliLimit(agentAlias, effectiveModelId)) {
      limit = Math.min(limit, CODEX_CLI_CONTEXT_LIMIT);
    }
  }

  // Use 98% of model limit to leave some buffer for response
  return Math.floor(limit * EFFECTIVE_MAX_RATIO);
}
