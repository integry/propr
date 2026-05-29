// Shared model definitions for AI agents
// This file provides a single source of truth for model information
// Both backend (packages/core) and frontend (propr-ui) import from this package

export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode';

export interface ModelInfo {
  id: string;
  name: string;           // Human-readable name
  shortName: string;      // Human readable short name for PR titles
  shortAlias: string;     // Short alias like "opus", "sonnet", "haiku"
  githubLabel: string;    // Format: llm-<agent-alias>-<model-alias>
  contextWindow: string;  // Display badge value (e.g., "200K", "1M")
  maxTokens: number;      // Numeric limit for calculations
  openRouterId: string;   // OpenRouter model ID for pricing lookups (e.g., "anthropic/claude-opus-4.5")
  minAgentVersion?: string; // Minimum Claude Code version that supports this model (e.g., "2.1.45")
}

export interface AgentDisplayInfo {
  label: string;
  order: number;
}

// Claude models (newest first within each tier, then by capability: Opus > Sonnet > Haiku)
// 4.6 models require newer Claude Code versions; 4.5 models work with older versions
export const CLAUDE_MODELS: ModelInfo[] = [
  // Claude 4.6 series (1M context for Opus/Sonnet)
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', shortName: 'Claude Opus 4.6', shortAlias: 'opus46', githubLabel: 'llm-claude-opus46', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-opus-4.6', minAgentVersion: '2.1.50' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', shortName: 'Claude Sonnet 4.6', shortAlias: 'sonnet46', githubLabel: 'llm-claude-sonnet46', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-sonnet-4.6', minAgentVersion: '2.1.45' },
  // Claude 4.5 series (200K context, works with all Claude Code versions)
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', shortName: 'Claude Opus 4.5', shortAlias: 'opus45', githubLabel: 'llm-claude-opus45', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-opus-4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', shortName: 'Claude Sonnet 4.5', shortAlias: 'sonnet45', githubLabel: 'llm-claude-sonnet45', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-sonnet-4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', shortName: 'Claude Haiku', shortAlias: 'haiku', githubLabel: 'llm-claude-haiku', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-haiku-4.5' },
];

// Codex (OpenAI) models - ChatGPT Plus/Pro available models
// Note: Available models depend on account type (ChatGPT login vs API key)
// Recommended: gpt-5.5 (default), gpt-5.4-mini (fast/subagents), gpt-5.3-codex (industry-leading coding)
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', shortName: 'GPT-5.5', shortAlias: 'gpt55', githubLabel: 'llm-codex-gpt55', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4', shortName: 'GPT-5.4', shortAlias: 'gpt54', githubLabel: 'llm-codex-gpt54', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', shortName: 'GPT-5.4 Mini', shortAlias: 'gpt54-mini', githubLabel: 'llm-codex-gpt54-mini', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.4-mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', shortName: 'GPT-5.3 Codex', shortAlias: 'gpt53-codex', githubLabel: 'llm-codex-gpt53-codex', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.3-codex' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', shortName: 'Codex Spark', shortAlias: 'codex-spark', githubLabel: 'llm-codex-spark', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.3-codex-spark' },
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

// OpenCode Go models. IDs use OpenCode config syntax: provider/model.
// Context limits are sourced from models.dev's opencode-go provider metadata.
export const OPENCODE_MODELS: ModelInfo[] = [
  { id: 'opencode-go/glm-5.1', name: 'GLM-5.1', shortName: 'GLM-5.1', shortAlias: 'glm51', githubLabel: 'llm-opencode-glm51', contextWindow: '203K', maxTokens: 202752, openRouterId: 'z-ai/glm-5.1' },
  { id: 'opencode-go/glm-5', name: 'GLM-5', shortName: 'GLM-5', shortAlias: 'glm5', githubLabel: 'llm-opencode-glm5', contextWindow: '203K', maxTokens: 202752, openRouterId: 'z-ai/glm-5' },
  { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6', shortName: 'Kimi K2.6', shortAlias: 'kimi-k26', githubLabel: 'llm-opencode-kimi-k26', contextWindow: '262K', maxTokens: 262144, openRouterId: 'moonshotai/kimi-k2.6' },
  { id: 'opencode-go/kimi-k2.5', name: 'Kimi K2.5', shortName: 'Kimi K2.5', shortAlias: 'kimi-k25', githubLabel: 'llm-opencode-kimi-k25', contextWindow: '262K', maxTokens: 262144, openRouterId: 'moonshotai/kimi-k2.5' },
  { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro', shortName: 'DeepSeek V4 Pro', shortAlias: 'deepseek-v4-pro', githubLabel: 'llm-opencode-deepseek-v4-pro', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'deepseek/deepseek-v4-pro' },
  { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', shortName: 'DeepSeek V4 Flash', shortAlias: 'deepseek-v4-flash', githubLabel: 'llm-opencode-deepseek-v4-flash', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'deepseek/deepseek-v4-flash' },
  { id: 'opencode-go/qwen3.7-max', name: 'Qwen3.7 Max', shortName: 'Qwen3.7 Max', shortAlias: 'qwen37-max', githubLabel: 'llm-opencode-qwen37-max', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'qwen/qwen3.7-max' },
  { id: 'opencode-go/qwen3.6-plus', name: 'Qwen3.6 Plus', shortName: 'Qwen3.6 Plus', shortAlias: 'qwen36-plus', githubLabel: 'llm-opencode-qwen36-plus', contextWindow: '262K', maxTokens: 262144, openRouterId: 'qwen/qwen3.6-plus' },
  { id: 'opencode-go/qwen3.5-plus', name: 'Qwen3.5 Plus', shortName: 'Qwen3.5 Plus', shortAlias: 'qwen35-plus', githubLabel: 'llm-opencode-qwen35-plus', contextWindow: '262K', maxTokens: 262144, openRouterId: 'qwen/qwen3.5-plus-20260420' },
  { id: 'opencode-go/minimax-m2.7', name: 'MiniMax M2.7', shortName: 'MiniMax M2.7', shortAlias: 'minimax-m27', githubLabel: 'llm-opencode-minimax-m27', contextWindow: '205K', maxTokens: 204800, openRouterId: 'minimax/minimax-m2.7' },
  { id: 'opencode-go/minimax-m2.5', name: 'MiniMax M2.5', shortName: 'MiniMax M2.5', shortAlias: 'minimax-m25', githubLabel: 'llm-opencode-minimax-m25', contextWindow: '205K', maxTokens: 204800, openRouterId: 'minimax/minimax-m2.5' },
  { id: 'opencode-go/mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', shortName: 'MiMo Pro', shortAlias: 'mimo-v25-pro', githubLabel: 'llm-opencode-mimo-v25-pro', contextWindow: '1M', maxTokens: 1048576, openRouterId: 'xiaomi/mimo-v2.5-pro' },
  { id: 'opencode-go/mimo-v2.5', name: 'MiMo-V2.5', shortName: 'MiMo', shortAlias: 'mimo-v25', githubLabel: 'llm-opencode-mimo-v25', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'xiaomi/mimo-v2.5' },
];

// All models combined
export const ALL_MODELS: ModelInfo[] = [...CLAUDE_MODELS, ...CODEX_MODELS, ...GEMINI_MODELS, ...OPENCODE_MODELS];

// Map of agent types to their models
export const AGENT_MODELS: Record<AgentType, ModelInfo[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
  opencode: OPENCODE_MODELS,
};

export const AGENT_DISPLAY: Record<AgentType, AgentDisplayInfo> = {
  claude: { label: 'Claude', order: 10 },
  gemini: { label: 'Gemini', order: 20 },
  codex: { label: 'Codex (OpenAI)', order: 30 },
  opencode: { label: 'OpenCode', order: 40 },
};

export const AGENT_DISPLAY_ORDER: AgentType[] = (Object.keys(AGENT_DISPLAY) as AgentType[])
  .sort((a, b) => AGENT_DISPLAY[a].order - AGENT_DISPLAY[b].order);

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
export const AGENT_DEFAULTS: Record<AgentType, {
  dockerImage: string;
  configPath: string;
  defaultModels: string[];
  defaultAlias: string;
  npmPackage: string;
  defaultCliVersion: string;
}> = {
  claude: {
    dockerImage: 'claude-code-processor:latest',
    configPath: '~/.claude',
    defaultModels: CLAUDE_MODELS.map(m => m.id),
    defaultAlias: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    defaultCliVersion: '2.1.85'
  },
  codex: {
    dockerImage: 'codex-cli:latest',
    configPath: '~/.codex',
    defaultModels: CODEX_MODELS.map(m => m.id),
    defaultAlias: 'codex',
    npmPackage: '@openai/codex',
    defaultCliVersion: '0.133.0'
  },
  gemini: {
    dockerImage: 'gemini-cli:latest',
    configPath: '~/.gemini',
    defaultModels: GEMINI_MODELS.map(m => m.id),
    defaultAlias: 'gemini',
    npmPackage: '@google/gemini-cli',
    defaultCliVersion: '0.35.1'
  },
  opencode: {
    dockerImage: 'opencode-cli:latest',
    configPath: '~/.opencode',
    defaultModels: OPENCODE_MODELS.map(m => m.id),
    defaultAlias: 'opencode',
    npmPackage: 'opencode-ai',
    defaultCliVersion: '1.15.12'
  }
};

// Badge colors for each agent type (for UI)
export const typeBadgeColors: Record<AgentType, string> = {
  claude: 'bg-orange-100 text-orange-800 border-orange-300',
  codex: 'bg-green-100 text-green-800 border-green-300',
  gemini: 'bg-blue-100 text-blue-800 border-blue-300',
  opencode: 'bg-cyan-100 text-cyan-800 border-cyan-300'
};
