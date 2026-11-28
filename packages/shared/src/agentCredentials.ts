import type { AgentType } from './modelDefinitions.js';

/**
 * Credentials an operator can paste into an agent's credential store instead
 * of running an interactive login. Each kind is written to a file the
 * provider's credential manifest declares (`credentials/providerManifests.ts`
 * in core), so Docker, Sprites and Fly Machines runs all pick it up unchanged.
 *
 * Values are write-only: the API only ever reports whether a kind is set and
 * its last four characters.
 */
export type PastedAgentCredentialKind =
  | 'anthropic-api-key'
  | 'claude-oauth-token'
  | 'openai-api-key'
  | 'codex-auth-json'
  | 'opencode-auth-json';

export interface PastedAgentCredentialDefinition {
  kind: PastedAgentCredentialKind;
  provider: AgentType;
  /** Which credential store of the agent holds the file. */
  store: 'config' | 'data';
  /** POSIX path relative to the store root; always a manifest entry. */
  path: string;
  label: string;
  /** Short input placeholder; never a real-looking secret. */
  placeholder: string;
  /** Whether the value is a JSON document rather than a single token. */
  multiline: boolean;
  description: string;
  links: readonly { label: string; url: string }[];
}

export const PASTED_AGENT_CREDENTIALS: readonly PastedAgentCredentialDefinition[] = Object.freeze([
  {
    kind: 'anthropic-api-key',
    provider: 'claude',
    store: 'config',
    path: 'settings.json',
    label: 'Anthropic API key',
    placeholder: 'sk-ant-api…',
    multiline: false,
    description: 'Stored as ANTHROPIC_API_KEY in the agent\'s Claude Code settings. Runs are billed to the API key\'s Console organization.',
    links: [{ label: 'Anthropic Console API keys', url: 'https://console.anthropic.com/settings/keys' }],
  },
  {
    kind: 'claude-oauth-token',
    provider: 'claude',
    store: 'config',
    path: 'settings.json',
    label: 'Claude subscription token (claude setup-token)',
    placeholder: 'sk-ant-oat…',
    multiline: false,
    description: 'A long-lived token printed by `claude setup-token` on any machine with Claude Code. Stored as CLAUDE_CODE_OAUTH_TOKEN in the agent\'s Claude Code settings.',
    links: [{ label: 'Claude Code authentication', url: 'https://code.claude.com/docs/en/iam' }],
  },
  {
    kind: 'openai-api-key',
    provider: 'codex',
    store: 'config',
    path: 'auth.json',
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    multiline: false,
    description: 'Written to the agent\'s Codex auth.json, as `codex login --with-api-key` does. Runs are billed to the key\'s OpenAI project.',
    links: [{ label: 'OpenAI API keys', url: 'https://platform.openai.com/api-keys' }],
  },
  {
    kind: 'codex-auth-json',
    provider: 'codex',
    store: 'config',
    path: 'auth.json',
    label: 'Codex auth.json (ChatGPT login)',
    placeholder: '{ "tokens": { … } }',
    multiline: true,
    description: 'Paste ~/.codex/auth.json from a machine where `codex login` was run. Codex refreshes it during runs and ProPR keeps the refreshed copy.',
    links: [{ label: 'Codex authentication', url: 'https://developers.openai.com/codex/auth' }],
  },
  {
    kind: 'opencode-auth-json',
    provider: 'opencode',
    store: 'data',
    path: 'auth.json',
    label: 'OpenCode auth.json',
    placeholder: '{ "anthropic": { "type": "api", "key": "…" } }',
    multiline: true,
    description: 'Paste ~/.local/share/opencode/auth.json from a machine where `opencode auth login` was run.',
    links: [{ label: 'OpenCode providers', url: 'https://opencode.ai/docs/providers/' }],
  },
]);

export function pastedAgentCredentialDefinitions(provider: AgentType): PastedAgentCredentialDefinition[] {
  return PASTED_AGENT_CREDENTIALS.filter(definition => definition.provider === provider);
}

export function getPastedAgentCredentialDefinition(kind: string): PastedAgentCredentialDefinition | undefined {
  return PASTED_AGENT_CREDENTIALS.find(definition => definition.kind === kind);
}

export function supportsPastedAgentCredentials(provider: AgentType): boolean {
  return PASTED_AGENT_CREDENTIALS.some(definition => definition.provider === provider);
}

/** What the API reports about one pasted credential kind: never the value. */
export interface PastedAgentCredentialStatus {
  kind: PastedAgentCredentialKind;
  set: boolean;
  /** Last four characters of the stored secret, when set. */
  last4?: string;
}

export interface AgentCredentialStatusResponse {
  agentId: string;
  credentials: PastedAgentCredentialStatus[];
  /** Whether a stored interactive login (for example Claude's .credentials.json) is present. */
  loginPresent: boolean;
}
