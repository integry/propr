// Re-export all model definitions from @propr/shared
// This provides backwards compatibility for existing imports from @propr/core
export {
  type AgentType,
  type ModelInfo,
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  VIBE_MODELS,
  ALL_MODELS,
  AGENT_MODELS,
  MODEL_INFO_MAP,
  MODEL_SHORT_NAMES,
  AGENT_DEFAULTS,
  typeBadgeColors,
} from '@propr/shared';
