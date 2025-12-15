// Re-export all model definitions from @gitfix/shared
// This ensures gitfix-ui uses the same single source of truth as @gitfix/core
export {
  type AgentType,
  type ModelInfo,
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  ALL_MODELS,
  AGENT_MODELS,
  MODEL_INFO_MAP,
  MODEL_SHORT_NAMES,
  AGENT_DEFAULTS,
  typeBadgeColors,
} from '@gitfix/shared';
