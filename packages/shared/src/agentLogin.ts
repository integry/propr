import type { AgentType } from './modelDefinitions.js';

/**
 * Portable prefix used for credential directories created by ProPR.
 *
 * The saved value deliberately looks like a normal home-relative path so it is
 * understandable in configuration and UI output. Containerized deployments
 * map it to a host-visible ProPR data directory through
 * PROPR_MANAGED_CREDENTIALS_DIR.
 */
export const MANAGED_AGENT_CREDENTIALS_PREFIX = '~/.propr/agent-credentials';

const MANAGED_CONFIG_SUFFIXES = {
  claude: '.claude',
  codex: '.codex',
  antigravity: '.gemini',
  opencode: '.config/opencode',
} as const satisfies Record<LoginableAgentType, string>;

const MANAGED_AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

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

/**
 * Return the isolated config path for a ProPR-managed agent account.
 *
 * Each agent id gets its own home-like directory tree. Keeping OpenCode's
 * .config and .local layouts under the same agent directory lets its separate
 * auth data store be inferred without a provider-wide HOST_* override.
 */
export function getManagedAgentConfigPath(
  agentId: string,
  type: LoginableAgentType,
): string {
  if (!MANAGED_AGENT_ID_RE.test(agentId)) {
    throw new Error('Managed agent credential paths require a safe agent id');
  }
  return `${MANAGED_AGENT_CREDENTIALS_PREFIX}/${agentId}/${MANAGED_CONFIG_SUFFIXES[type]}`;
}

/**
 * Return the validated path below MANAGED_AGENT_CREDENTIALS_PREFIX.
 *
 * An exact generated layout is required so callers can safely join the result
 * to a deployment-specific host root without allowing path traversal.
 */
export function getManagedAgentConfigRelativePath(configPath: string): string | undefined {
  const prefix = `${MANAGED_AGENT_CREDENTIALS_PREFIX}/`;
  if (!configPath.startsWith(prefix)) return undefined;
  const relativePath = configPath.slice(prefix.length);
  const separator = relativePath.indexOf('/');
  if (separator <= 0) return undefined;
  const agentId = relativePath.slice(0, separator);
  const suffix = relativePath.slice(separator + 1);
  if (!MANAGED_AGENT_ID_RE.test(agentId)) return undefined;
  return Object.values(MANAGED_CONFIG_SUFFIXES).includes(
    suffix as (typeof MANAGED_CONFIG_SUFFIXES)[keyof typeof MANAGED_CONFIG_SUFFIXES],
  )
    ? relativePath
    : undefined;
}

export function isManagedAgentConfigPath(configPath: string): boolean {
  return getManagedAgentConfigRelativePath(configPath) !== undefined;
}
