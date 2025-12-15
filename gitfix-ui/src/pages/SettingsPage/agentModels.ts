export type AgentType = 'claude' | 'codex' | 'gemini';

// Model info with ID, human-readable name, short alias, and GitHub label
export interface ModelInfo {
  id: string;
  name: string;           // Human-readable name
  shortName: string;     // New Field: Human readable short name
  shortAlias: string;     // Short alias like "opus", "sonnet", "haiku"
  githubLabel: string;    // Format: llm-<agent-alias>-<model-alias>
  contextWindow: string; // New Field: Display badge value
}

// Claude models (Opus first as default, then Sonnet, then Haiku)
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    shortName: 'Claude Opus',
    shortAlias: 'opus',
    githubLabel: 'llm-claude-opus',
    contextWindow: '200K'
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    shortName: 'Claude Sonnet',
    shortAlias: 'sonnet',
    githubLabel: 'llm-claude-sonnet',
    contextWindow: '200K'
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    shortName: 'Claude Haiku',
    shortAlias: 'haiku',
    githubLabel: 'llm-claude-haiku',
    contextWindow: '200K'
  },
];

// Codex (OpenAI) models
export const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    shortName: 'GPT-5',
    shortAlias: 'gpt5',
    githubLabel: 'llm-codex-gpt5',
    contextWindow: '400K'
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    shortName: 'GPT-5 Mini',
    shortAlias: 'gpt5-mini',
    githubLabel: 'llm-codex-gpt5-mini',
    contextWindow: '128K'
  },
  {
    id: 'gpt-5-codex',
    name: 'GPT-5 Codex',
    shortName: 'Codex',
    shortAlias: 'codex',
    githubLabel: 'llm-codex-codex',
    contextWindow: '400K'
  },
  {
    id: 'o3',
    name: 'OpenAI o3',
    shortName: 'o3',
    shortAlias: 'o3',
    githubLabel: 'llm-codex-o3',
    contextWindow: '200K'
  },
  {
    id: 'o4-mini',
    name: 'OpenAI o4-mini',
    shortName: 'o4-mini',
    shortAlias: 'o4-mini',
    githubLabel: 'llm-codex-o4-mini',
    contextWindow: '128K'
  },
];

// Gemini models
export const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    shortName: 'Gemini 3 Preview',
    shortAlias: 'pro-preview',
    githubLabel: 'llm-gemini-pro-preview',
    contextWindow: '2M'
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    shortName: 'Gemini Pro',
    shortAlias: 'pro',
    githubLabel: 'llm-gemini-pro',
    contextWindow: '2M'
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    shortName: 'Gemini Flash',
    shortAlias: 'flash',
    githubLabel: 'llm-gemini-flash',
    contextWindow: '1M'
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    shortName: 'Flash Lite',
    shortAlias: 'flash-lite',
    githubLabel: 'llm-gemini-flash-lite',
    contextWindow: '1M'
  },
];

export const AGENT_MODELS: Record<AgentType, ModelInfo[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
};

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
