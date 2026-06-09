// Shared model definitions for AI agents
// This file provides a single source of truth for model information
// Both backend (packages/core) and frontend (propr-ui) import from this package

export type AgentType = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'vibe';
export const AGENT_TYPES: AgentType[] = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'];

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
// 4.8/4.7/4.6 models require newer Claude Code versions; 4.5 models work with older versions
export const CLAUDE_MODELS: ModelInfo[] = [
  // Claude Fable 5 (top tier, above Opus)
  { id: 'claude-fable-5', name: 'Claude Fable 5', shortName: 'Claude Fable 5', shortAlias: 'fable', githubLabel: 'llm-claude-fable', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-fable-5', minAgentVersion: '2.1.170' },
  // Claude 4.8 series
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', shortName: 'Claude Opus 4.8', shortAlias: 'opus48', githubLabel: 'llm-claude-opus48', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-opus-4.8' },
  // Claude 4.7 series
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', shortName: 'Claude Opus 4.7', shortAlias: 'opus47', githubLabel: 'llm-claude-opus47', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-opus-4.7' },
  // Claude 4.6 series (1M context for Opus/Sonnet)
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', shortName: 'Claude Opus 4.6', shortAlias: 'opus46', githubLabel: 'llm-claude-opus46', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-opus-4.6', minAgentVersion: '2.1.50' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', shortName: 'Claude Sonnet 4.6', shortAlias: 'sonnet46', githubLabel: 'llm-claude-sonnet46', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-sonnet-4.6', minAgentVersion: '2.1.45' },
  // Claude 4.5 series (200K context, works with all Claude Code versions)
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', shortName: 'Claude Opus 4.5', shortAlias: 'opus45', githubLabel: 'llm-claude-opus45', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-opus-4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', shortName: 'Claude Sonnet 4.5', shortAlias: 'sonnet45', githubLabel: 'llm-claude-sonnet45', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-sonnet-4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', shortName: 'Claude Haiku', shortAlias: 'haiku', githubLabel: 'llm-claude-haiku', contextWindow: '200K', maxTokens: 200000, openRouterId: 'anthropic/claude-haiku-4.5' },
];

// Codex (OpenAI) models - availability depends on account type (ChatGPT login vs API key)
// Recommended: gpt-5.5 (default), gpt-5.4-mini/nano (fast/subagents), gpt-5.3-codex (agentic coding)
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', shortName: 'GPT-5.5', shortAlias: 'gpt55', githubLabel: 'llm-codex-gpt55', contextWindow: '1M', maxTokens: 1050000, openRouterId: 'openai/gpt-5.5' },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', shortName: 'GPT-5.5 Pro', shortAlias: 'gpt55-pro', githubLabel: 'llm-codex-gpt55-pro', contextWindow: '1M', maxTokens: 1050000, openRouterId: 'openai/gpt-5.5-pro' },
  { id: 'gpt-5.4', name: 'GPT-5.4', shortName: 'GPT-5.4', shortAlias: 'gpt54', githubLabel: 'llm-codex-gpt54', contextWindow: '1M', maxTokens: 1050000, openRouterId: 'openai/gpt-5.4' },
  { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', shortName: 'GPT-5.4 Pro', shortAlias: 'gpt54-pro', githubLabel: 'llm-codex-gpt54-pro', contextWindow: '1M', maxTokens: 1050000, openRouterId: 'openai/gpt-5.4-pro' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', shortName: 'GPT-5.4 Mini', shortAlias: 'gpt54-mini', githubLabel: 'llm-codex-gpt54-mini', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.4-mini' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', shortName: 'GPT-5.4 Nano', shortAlias: 'gpt54-nano', githubLabel: 'llm-codex-gpt54-nano', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.4-nano' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', shortName: 'GPT-5.3 Codex', shortAlias: 'gpt53-codex', githubLabel: 'llm-codex-gpt53-codex', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.3-codex' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', shortName: 'Codex Spark', shortAlias: 'codex-spark', githubLabel: 'llm-codex-spark', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.3-codex-spark' },
  { id: 'gpt-5.2', name: 'GPT-5.2', shortName: 'GPT-5.2', shortAlias: 'gpt52', githubLabel: 'llm-codex-gpt52', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5.2' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', shortName: 'GPT-5 Mini', shortAlias: 'gpt5-mini', githubLabel: 'llm-codex-gpt5-mini', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5-mini' },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', shortName: 'GPT-5 Nano', shortAlias: 'gpt5-nano', githubLabel: 'llm-codex-gpt5-nano', contextWindow: '400K', maxTokens: 400000, openRouterId: 'openai/gpt-5-nano' },
];

// Antigravity models. Antigravity can route to multiple model families, so
// these IDs are intentionally namespaced instead of treating every model as a
// Google/Gemini model.
export const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'antigravity-gemini-3.5-flash-medium', name: 'Antigravity Gemini 3.5 Flash Medium', shortName: 'Gemini 3.5 Flash Medium', shortAlias: 'flash-medium', githubLabel: 'llm-antigravity-flash-medium', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3.5-flash' },
  { id: 'antigravity-gemini-3.5-flash-high', name: 'Antigravity Gemini 3.5 Flash High', shortName: 'Gemini 3.5 Flash High', shortAlias: 'flash-high', githubLabel: 'llm-antigravity-flash-high', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3.5-flash' },
  { id: 'antigravity-gemini-3.5-flash-low', name: 'Antigravity Gemini 3.5 Flash Low', shortName: 'Gemini 3.5 Flash Low', shortAlias: 'flash-low', githubLabel: 'llm-antigravity-flash-low', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3.5-flash' },
  { id: 'antigravity-gemini-3.1-pro-low', name: 'Antigravity Gemini 3.1 Pro Low', shortName: 'Gemini 3.1 Pro Low', shortAlias: 'pro-low', githubLabel: 'llm-antigravity-pro-low', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3.1-pro' },
  { id: 'antigravity-gemini-3.1-pro-high', name: 'Antigravity Gemini 3.1 Pro High', shortName: 'Gemini 3.1 Pro High', shortAlias: 'pro-high', githubLabel: 'llm-antigravity-pro-high', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'google/gemini-3.1-pro' },
  { id: 'antigravity-claude-sonnet-4.6-thinking', name: 'Antigravity Claude Sonnet 4.6 Thinking', shortName: 'Claude Sonnet 4.6 Thinking', shortAlias: 'sonnet46-thinking', githubLabel: 'llm-antigravity-sonnet46-thinking', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-sonnet-4.6' },
  { id: 'antigravity-claude-opus-4.6-thinking', name: 'Antigravity Claude Opus 4.6 Thinking', shortName: 'Claude Opus 4.6 Thinking', shortAlias: 'opus46-thinking', githubLabel: 'llm-antigravity-opus46-thinking', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'anthropic/claude-opus-4.6' },
  { id: 'antigravity-gpt-oss-120b-medium', name: 'Antigravity GPT-OSS 120B Medium', shortName: 'GPT-OSS 120B Medium', shortAlias: 'gpt-oss-120b', githubLabel: 'llm-antigravity-gpt-oss-120b', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'openai/gpt-oss-120b' },
];


// OpenCode built-in free models. IDs are namespaced for ProPR and converted
// back to OpenCode's provider/model syntax at CLI execution time.
// These are available from `opencode models` without provider login.
export const OPENCODE_MODELS: ModelInfo[] = [
  { id: 'opencode-minimax-m3-free', name: 'MiniMax M3 Free', shortName: 'MiniMax M3 Free', shortAlias: 'minimax-m3-free', githubLabel: 'llm-opencode-minimax-m3-free', contextWindow: '200K', maxTokens: 200000, openRouterId: 'minimax/minimax-m3' },
  { id: 'opencode-deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', shortName: 'DeepSeek V4 Flash Free', shortAlias: 'deepseek-v4-flash-free', githubLabel: 'llm-opencode-deepseek-v4-flash-free', contextWindow: '200K', maxTokens: 200000, openRouterId: 'deepseek/deepseek-v4-flash' },
  { id: 'opencode-mimo-v2.5-free', name: 'MiMo V2.5 Free', shortName: 'MiMo V2.5 Free', shortAlias: 'mimo-v25-free', githubLabel: 'llm-opencode-mimo-v25-free', contextWindow: '200K', maxTokens: 200000, openRouterId: 'xiaomi/mimo-v2.5' },
  { id: 'opencode-nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', shortName: 'Nemotron 3 Ultra Free', shortAlias: 'nemotron-3-ultra-free', githubLabel: 'llm-opencode-nemotron-3-ultra-free', contextWindow: '1M', maxTokens: 1000000, openRouterId: 'nvidia/nemotron-3-ultra' },
  { id: 'opencode-big-pickle', name: 'Big Pickle', shortName: 'Big Pickle', shortAlias: 'big-pickle', githubLabel: 'llm-opencode-big-pickle', contextWindow: '200K', maxTokens: 200000, openRouterId: 'opencode/big-pickle' },
];

// Mistral Vibe coding models
// Available models from `vibe /model`: mistral-medium-3.5, devstral-small, local
export const VIBE_MODELS: ModelInfo[] = [
  { id: 'mistral-medium-3.5', name: 'Mistral Medium 3.5', shortName: 'Mistral Medium', shortAlias: 'mistral', githubLabel: 'llm-vibe-mistral', contextWindow: '256K', maxTokens: 256000, openRouterId: 'mistralai/mistral-medium-3-5' },
  { id: 'devstral-small', name: 'Devstral Small', shortName: 'Devstral Small', shortAlias: 'devstral', githubLabel: 'llm-vibe-devstral', contextWindow: '256K', maxTokens: 256000, openRouterId: 'mistralai/devstral-2512' },
];

// All models combined
export const ALL_MODELS: ModelInfo[] = [...CLAUDE_MODELS, ...CODEX_MODELS, ...ANTIGRAVITY_MODELS, ...OPENCODE_MODELS, ...VIBE_MODELS];

// Map of agent types to their models
export const AGENT_MODELS: Record<AgentType, ModelInfo[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  antigravity: ANTIGRAVITY_MODELS,
  opencode: OPENCODE_MODELS,
  vibe: VIBE_MODELS,
};

export const AGENT_DISPLAY: Record<AgentType, AgentDisplayInfo> = {
  claude: { label: 'Claude', order: 10 },
  antigravity: { label: 'Antigravity', order: 20 },
  codex: { label: 'Codex (OpenAI)', order: 30 },
  opencode: { label: 'OpenCode', order: 40 },
  vibe: { label: 'Vibe', order: 50 },
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
    dockerImage: 'propr/agent-claude:latest',
    configPath: '~/.claude',
    defaultModels: CLAUDE_MODELS.map(m => m.id),
    defaultAlias: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    defaultCliVersion: '2.1.170'
  },
  codex: {
    dockerImage: 'propr/agent-codex:latest',
    configPath: '~/.codex',
    defaultModels: CODEX_MODELS.map(m => m.id),
    defaultAlias: 'codex',
    npmPackage: '@openai/codex',
    defaultCliVersion: '0.137.0'
  },
  antigravity: {
    dockerImage: 'propr/agent-antigravity:latest',
    configPath: '~/.gemini',
    defaultModels: ANTIGRAVITY_MODELS.map(m => m.id),
    defaultAlias: 'antigravity',
    npmPackage: 'https://antigravity.google/cli/install.sh',
    defaultCliVersion: 'latest'
  },
  opencode: {
    dockerImage: 'propr/agent-opencode:latest',
    configPath: '~/.config/opencode',
    defaultModels: OPENCODE_MODELS.map(m => m.id),
    defaultAlias: 'opencode',
    npmPackage: 'opencode-ai',
    defaultCliVersion: '1.16.2'
  },
  vibe: {
    dockerImage: 'propr/agent-vibe:latest',
    configPath: '~/.vibe',
    defaultModels: VIBE_MODELS.map(m => m.id),
    defaultAlias: 'vibe',
    npmPackage: 'mistral-vibe',
    defaultCliVersion: '2.12.1'
  }
};

// Badge colors for each agent type (for UI)
export const typeBadgeColors: Record<AgentType, string> = {
  claude: 'bg-orange-100 text-orange-800 border-orange-300',
  codex: 'bg-green-100 text-green-800 border-green-300',
  antigravity: 'bg-violet-100 text-violet-800 border-violet-300',
  opencode: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  vibe: 'bg-red-100 text-red-700 border-red-400'  // Mistral Vibe brand orange-red (#FA500F)
};
