import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DEFAULTS,
  getManagedAgentConfigPath,
  getManagedAgentConfigRelativePath,
  isAgentLoginSupported,
  isManagedAgentConfigPath,
  type AgentLoginDescriptor,
  type AgentType,
} from '@propr/shared';
import type { AgentConfig } from '@propr/core';

const CONTAINER_WORKSPACE = '/home/node/workspace';
const ANTIGRAVITY_TOKEN_PATH = 'antigravity-cli/antigravity-oauth-token';
const ANTIGRAVITY_ONBOARDING_PATH = 'antigravity-cli/cache/onboarding.json';
const ANTIGRAVITY_SETTINGS_PATH = 'antigravity-cli/settings.json';

export const AGENT_LOGIN_TERMINAL = {
  rows: 30,
  columns: 120,
  type: 'xterm-256color',
} as const;

export class AgentLoginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoginInputError';
  }
}

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AgentLoginInputError(`${label} is not valid JSON`);
  }
  throw new AgentLoginInputError(`${label} must contain a JSON object`);
}

/**
 * Apply privacy-preserving, non-legal defaults before Antigravity's first-run
 * wizard starts. The user still sees and accepts the provider's terms, while
 * interaction telemetry begins unchecked and the isolated login workspace does
 * not require another trust prompt.
 */
export function prepareAgentLoginCredentialDefaults(type: AgentType, credentialPath: string): void {
  if (type !== 'antigravity') return;
  const settingsPath = path.join(credentialPath, ANTIGRAVITY_SETTINGS_PATH);
  const settings = readJsonObject(settingsPath, 'Antigravity settings');
  settings.enableTelemetry = false;
  if (typeof settings.colorScheme !== 'string') settings.colorScheme = 'terminal';
  const trustedWorkspaces = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((value): value is string => typeof value === 'string')
    : [];
  if (!trustedWorkspaces.includes(CONTAINER_WORKSPACE)) trustedWorkspaces.push(CONTAINER_WORKSPACE);
  settings.trustedWorkspaces = trustedWorkspaces;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function isAgentLoginComplete(type: AgentType, credentialPath: string): boolean {
  if (type !== 'antigravity') return false;
  if (!fs.existsSync(path.join(credentialPath, ANTIGRAVITY_TOKEN_PATH))) return false;
  try {
    const onboarding = readJsonObject(
      path.join(credentialPath, ANTIGRAVITY_ONBOARDING_PATH),
      'Antigravity onboarding state',
    );
    return onboarding.onboardingComplete === true;
  } catch {
    return false;
  }
}

function envConfigPath(type: AgentType): string | undefined {
  switch (type) {
    case 'claude':
      return process.env.CLAUDE_CONFIG_PATH || process.env.HOST_CLAUDE_DIR;
    case 'codex':
      return process.env.CODEX_CONFIG_PATH || process.env.HOST_CODEX_DIR;
    case 'antigravity':
      return process.env.ANTIGRAVITY_CONFIG_PATH || process.env.HOST_ANTIGRAVITY_DIR;
    case 'opencode':
      return process.env.OPENCODE_CONFIG_PATH || process.env.HOST_OPENCODE_XDG_DIR;
    default:
      return undefined;
  }
}

function isContainerizedApi(): boolean {
  return process.env.PROPR_CONTAINERIZED === '1'
    || process.env.PROPR_CONTAINERIZED === 'true'
    || fs.existsSync('/.dockerenv');
}

function validateAbsoluteCredentialPath(value: string, label: string): string {
  const normalized = path.normalize(value);
  if (!path.isAbsolute(normalized) || normalized.includes(':') || /[\0\r\n]/.test(normalized)) {
    throw new AgentLoginInputError(`${label} must be an absolute Linux path without colons or control characters`);
  }
  if (normalized === path.parse(normalized).root) {
    throw new AgentLoginInputError(`${label} cannot be the filesystem root`);
  }
  return normalized;
}

/**
 * Expand a saved config path into the absolute path understood by the host
 * Docker daemon. ProPR-managed paths resolve below the deployment's managed
 * credential root; existing default paths use a type-specific host mapping.
 */
export function resolveAgentLoginConfigPath(agent: AgentConfig): string {
  const configured = agent.configPath || AGENT_DEFAULTS[agent.type].configPath;
  const managedRelativePath = getManagedAgentConfigRelativePath(configured);
  if (managedRelativePath) {
    if (!isAgentLoginSupported(agent.type)) {
      throw new AgentLoginInputError(`${agent.type} does not support ProPR-managed interactive login`);
    }
    let expectedPath: string;
    try {
      expectedPath = getManagedAgentConfigPath(agent.id, agent.type);
    } catch {
      throw new AgentLoginInputError('Managed agent credentials require a safe agent id');
    }
    if (configured !== expectedPath) {
      throw new AgentLoginInputError('Managed agent credential path does not match this agent');
    }
    const configuredRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    if (!configuredRoot && isContainerizedApi()) {
      throw new AgentLoginInputError(
        'ProPR-managed credentials are not mounted in this API container; restart the stack with managed credential storage enabled',
      );
    }
    const managedRoot = configuredRoot
      ? validateAbsoluteCredentialPath(configuredRoot, 'PROPR_MANAGED_CREDENTIALS_DIR')
      : path.join(os.homedir(), '.propr', 'agent-credentials');
    return validateAbsoluteCredentialPath(
      path.join(managedRoot, managedRelativePath),
      'Agent credential path',
    );
  }

  let resolved = configured;
  if (configured === '~' || configured.startsWith('~/')) {
    const environmentPath = envConfigPath(agent.type);
    if (configured !== AGENT_DEFAULTS[agent.type].configPath) {
      throw new AgentLoginInputError('Custom agent credential paths must be absolute; "~" is only supported for the default path');
    } else if (environmentPath) {
      resolved = validateAbsoluteCredentialPath(environmentPath, `${agent.type} credential mapping`);
    } else if (isContainerizedApi()) {
      throw new AgentLoginInputError(
        `The existing ${configured} credential path has no host mapping in this container; configure the provider host directory or use a ProPR-managed login`,
      );
    } else {
      resolved = configured === '~'
        ? os.homedir()
        : path.join(os.homedir(), configured.slice(2));
    }
  }
  return validateAbsoluteCredentialPath(resolved, 'Agent credential path');
}

export function resolveOpenCodeDataPath(configPath: string, managedCredentials = false): string {
  const configured = process.env.HOST_OPENCODE_DATA_DIR;
  if (configured && !managedCredentials) {
    return validateAbsoluteCredentialPath(configured, 'HOST_OPENCODE_DATA_DIR');
  }
  const suffix = path.join('.config', 'opencode');
  return configPath.endsWith(suffix)
    ? path.join(configPath.slice(0, -suffix.length), '.local', 'share', 'opencode')
    : path.join(path.dirname(configPath), 'opencode-data');
}

export function resolveAgentLoginImage(agent: AgentConfig): string {
  const image = agent.dockerImage || AGENT_DEFAULTS[agent.type].dockerImage;
  if (!image || image.startsWith('-') || /\s/.test(image)) {
    throw new AgentLoginInputError('Agent Docker image is not configured correctly');
  }
  return image;
}

export function buildAgentLoginCreateArgs(
  agent: AgentConfig,
  descriptor: AgentLoginDescriptor,
  credentialPath: string,
  ...container: [containerName: string, scope?: string]
): string[] {
  const [containerName, scope = 'propr'] = container;
  const image = resolveAgentLoginImage(agent);
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(scope)) {
    throw new AgentLoginInputError('Agent login container scope is not configured correctly');
  }

  const managedCredentials = isManagedAgentConfigPath(agent.configPath);
  const environment = Object.entries(descriptor.environment ?? {})
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const additionalMounts = descriptor.additionalCredentialStore === 'opencode-data'
    ? ['-v', `${resolveOpenCodeDataPath(credentialPath, managedCredentials)}:/home/node/.local/share/opencode:rw`]
    : [];

  return [
    'create',
    '--name', containerName,
    '--label', 'propr.agent-login=true',
    '--label', `propr.agent-login.scope=${scope}`,
    '-i',
    '-t',
    '--security-opt', 'no-new-privileges',
    '--cap-add', 'CHOWN',
    '--network', 'bridge',
    // The allowlisted agent entrypoint prepares mounted credential ownership,
    // then drops to the node user before executing the provider CLI.
    '--user', '0:0',
    '--tmpfs', `${CONTAINER_WORKSPACE}:rw,nosuid,nodev,size=16m`,
    '-v', `${credentialPath}:${descriptor.containerConfigPath}:rw`,
    ...additionalMounts,
    '-e', `PROPR_AGENT_TYPE=${agent.type}`,
    '-e', `TERM=${AGENT_LOGIN_TERMINAL.type}`,
    '-e', `COLUMNS=${AGENT_LOGIN_TERMINAL.columns}`,
    '-e', `LINES=${AGENT_LOGIN_TERMINAL.rows}`,
    ...(managedCredentials ? ['-e', 'PROPR_MANAGED_CREDENTIALS=1'] : []),
    ...environment,
    '-w', CONTAINER_WORKSPACE,
    image,
    ...descriptor.command,
  ];
}
