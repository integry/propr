// Shared model definitions for AI agents
// This file provides a single source of truth for model information
// Both backend (packages/core) and frontend (gitfix-ui) import from this package

export type AgentType = 'claude' | 'codex' | 'gemini';

export interface ModelInfo {
  id: string;
  name: string;           // Human-readable name
  shortName: string;      // Human readable short name for PR titles
  shortAlias: string;     // Short alias like "opus", "sonnet", "haiku"
  githubLabel: string;    // Format: llm-<agent-alias>-<model-alias>
  contextWindow: string;  // Display badge value (e.g., "200K", "1M")
  maxTokens: number;      // Numeric limit for calculations
  openRouterId: string;   // OpenRouter model ID for pricing lookups (e.g., "anthropic/claude-opus-4.5")
}

// Claude models (Opus first as default, then Sonnet, then Haiku)
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', shortName: 'Claude Opus', shortAlias: 'opus', githubLabel: 'llm-claude-opus', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-opus-4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', shortName: 'Claude Sonnet', shortAlias: 'sonnet', githubLabel: 'llm-claude-sonnet', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-sonnet-4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', shortName: 'Claude Haiku', shortAlias: 'haiku', githubLabel: 'llm-claude-haiku', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-haiku-4.5' },
];

// Codex (OpenAI) models - ChatGPT Plus/Pro available models
// Note: Available models depend on account type (ChatGPT login vs API key)
// These are the models shown for ChatGPT Plus accounts as of Jan 2026
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', shortName: 'GPT-5.2 Codex', shortAlias: 'gpt52-codex', githubLabel: 'llm-codex-gpt52-codex', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.2-codex' },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', shortName: 'Codex Max', shortAlias: 'codex-max', githubLabel: 'llm-codex-max', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.1-codex-max' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', shortName: 'Codex Mini', shortAlias: 'codex-mini', githubLabel: 'llm-codex-mini', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.1-codex-mini' },
  { id: 'gpt-5.2', name: 'GPT-5.2', shortName: 'GPT-5.2', shortAlias: 'gpt52', githubLabel: 'llm-codex-gpt52', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.2' },
];

// Gemini models
export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', shortName: 'Gemini 3 Preview', shortAlias: 'pro-preview', githubLabel: 'llm-gemini-pro-preview', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3-pro-preview' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', shortName: 'Gemini 3 Flash', shortAlias: 'g3-flash-preview', githubLabel: 'llm-gemini-g3-flash-preview', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3-flash-preview' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', shortName: 'Gemini Pro', shortAlias: 'pro', githubLabel: 'llm-gemini-pro', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', shortName: 'Gemini Flash', shortAlias: 'flash', githubLabel: 'llm-gemini-flash', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-2.5-flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', shortName: 'Flash Lite', shortAlias: 'flash-lite', githubLabel: 'llm-gemini-flash-lite', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-2.5-flash-lite' },
];

// All models combined
export const ALL_MODELS: ModelInfo[] = [...CLAUDE_MODELS, ...CODEX_MODELS, ...GEMINI_MODELS];

// Map of agent types to their models
export const AGENT_MODELS: Record<AgentType, ModelInfo[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
};

// Lookup map for all models by ID
export const MODEL_INFO_MAP: Record<string, ModelInfo> = {};
ALL_MODELS.forEach(m => {
  MODEL_INFO_MAP[m.id] = m;
});

// Generate MODEL_SHORT_NAMES from MODEL_INFO_MAP for backwards compatibility
export const MODEL_SHORT_NAMES: Record<string, string> = {};
ALL_MODELS.forEach(m => {
  MODEL_SHORT_NAMES[m.id] = m.shortName;
});

// Agent default configurations
export const AGENT_DEFAULTS: Record<AgentType, { dockerImage: string; configPath: string; defaultModels: string[]; defaultAlias: string }> = {
  claude: {
    dockerImage: 'claude-code-processor:latest',
    configPath: '~/.claude',
    defaultModels: CLAUDE_MODELS.map(m => m.id),
    defaultAlias: 'claude'
  },
  codex: {
    dockerImage: 'codex-cli:latest',
    configPath: '~/.codex',
    defaultModels: CODEX_MODELS.map(m => m.id),
    defaultAlias: 'codex'
  },
  gemini: {
    dockerImage: 'gemini-cli:latest',
    configPath: '~/.gemini',
    defaultModels: GEMINI_MODELS.map(m => m.id),
    defaultAlias: 'gemini'
  }
};

// Badge colors for each agent type (for UI)
export const typeBadgeColors: Record<AgentType, string> = {
  claude: 'bg-orange-100 text-orange-800 border-orange-300',
  codex: 'bg-green-100 text-green-800 border-green-300',
  gemini: 'bg-blue-100 text-blue-800 border-blue-300'
};