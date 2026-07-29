import type { AgentType } from './modelDefinitions.js';

/**
 * Static, provider-owned pieces of an interactive agent login.
 *
 * Host paths and image tags are intentionally absent: callers must resolve
 * those from trusted local configuration rather than accepting them from a
 * browser or other remote client.
 */
export interface AgentLoginDescriptor {
  type: AgentType;
  containerConfigPath: string;
  command: readonly string[];
  environment?: Readonly<Record<string, string>>;
  /** OpenCode stores provider credentials outside its XDG config directory. */
  additionalCredentialStore?: 'opencode-data';
}

export const AGENT_LOGIN_DESCRIPTORS = {
  claude: {
    type: 'claude',
    containerConfigPath: '/home/node/.claude',
    command: ['claude', 'auth', 'login'],
  },
  codex: {
    type: 'codex',
    containerConfigPath: '/home/node/.codex',
    command: ['codex', 'login', '--device-auth'],
  },
  antigravity: {
    type: 'antigravity',
    containerConfigPath: '/home/node/.gemini',
    command: ['/bin/bash', '-lc', 'exec agy login'],
    environment: {
      ANTIGRAVITY_CLI: '1',
      ANTIGRAVITY_CLI_TRUST_WORKSPACE: 'true',
    },
  },
  opencode: {
    type: 'opencode',
    containerConfigPath: '/home/node/.config/opencode',
    command: ['opencode', 'auth', 'login'],
    additionalCredentialStore: 'opencode-data',
  },
} as const satisfies Partial<Record<AgentType, AgentLoginDescriptor>>;

export type LoginableAgentType = keyof typeof AGENT_LOGIN_DESCRIPTORS;

export const LOGINABLE_AGENT_TYPES = Object.freeze(
  Object.keys(AGENT_LOGIN_DESCRIPTORS) as LoginableAgentType[],
);

export function isAgentLoginSupported(type: AgentType): type is LoginableAgentType {
  return Object.prototype.hasOwnProperty.call(AGENT_LOGIN_DESCRIPTORS, type);
}

export function getAgentLoginDescriptor(type: AgentType): AgentLoginDescriptor | undefined {
  return isAgentLoginSupported(type) ? AGENT_LOGIN_DESCRIPTORS[type] : undefined;
}
