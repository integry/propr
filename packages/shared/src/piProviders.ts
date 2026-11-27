/**
 * Pi model providers ProPR offers in setup and the settings UI, checked
 * against Pi 1.6.1 (`pi auth login --help`, @earendil-works/pi-ai
 * env-api-keys.js). Pi knows more providers; any of them can still be typed in.
 */
export interface PiProviderInfo {
  id: string;
  label: string;
  /** Environment variable Pi reads the provider's API key from. */
  apiKeyEnv?: string;
  /** Whether `pi auth login <id>` offers an account sign-in (OAuth or device code). */
  accountLogin?: boolean;
}

export const PI_PROVIDERS: readonly PiProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', accountLogin: true },
  { id: 'openai-codex', label: 'OpenAI (ChatGPT subscription)', accountLogin: true },
  { id: 'openai', label: 'OpenAI API', apiKeyEnv: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google Gemini', apiKeyEnv: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', accountLogin: true },
  { id: 'github-copilot', label: 'GitHub Copilot', apiKeyEnv: 'COPILOT_GITHUB_TOKEN', accountLogin: true },
  { id: 'mistral', label: 'Mistral', apiKeyEnv: 'MISTRAL_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'xai', label: 'xAI', apiKeyEnv: 'XAI_API_KEY' },
  { id: 'groq', label: 'Groq', apiKeyEnv: 'GROQ_API_KEY' },
  { id: 'zai', label: 'Z.ai', apiKeyEnv: 'ZAI_API_KEY' },
  { id: 'opencode', label: 'OpenCode Zen', apiKeyEnv: 'OPENCODE_API_KEY' },
];

const PI_PROVIDER_MAP = new Map(PI_PROVIDERS.map(provider => [provider.id, provider]));

export function getPiProviderInfo(provider: string): PiProviderInfo | undefined {
  return PI_PROVIDER_MAP.get(provider);
}

/** The API key variable for a provider, e.g. `OPENROUTER_API_KEY`. */
export function getPiProviderApiKeyEnv(provider: string): string | undefined {
  return PI_PROVIDER_MAP.get(provider)?.apiKeyEnv;
}
