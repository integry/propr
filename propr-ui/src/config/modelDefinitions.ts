// Re-export all model definitions from @propr/shared
// This ensures propr-ui uses the same single source of truth as @propr/core
export {
  type AgentType,
  AGENT_TYPES,
  type ModelInfo,
  CLAUDE_MODELS,
  CODEX_MODELS,
  ANTIGRAVITY_MODELS,
  GEMINI_MODELS,
  VIBE_MODELS,
  ALL_MODELS,
  AGENT_MODELS,
  MODEL_INFO_MAP,
  MODEL_SHORT_NAMES,
  AGENT_DEFAULTS,
  typeBadgeColors,
} from '@propr/shared';
