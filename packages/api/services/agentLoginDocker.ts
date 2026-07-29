import os from 'node:os';
import path from 'node:path';
import { AGENT_DEFAULTS, type AgentLoginDescriptor, type AgentType } from '@propr/shared';
import type { AgentConfig } from '@propr/core';

const CONTAINER_WORKSPACE = '/home/node/workspace';

export class AgentLoginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoginInputError';
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
    case 'vibe':
      return process.env.VIBE_CONFIG_PATH || process.env.HOST_VIBE_DIR;
  }
}

/**
 * Expand a saved config path into the absolute path understood by the host
 * Docker daemon. Compose deployments set the type-specific *_CONFIG_PATH to
 * the host path, which takes precedence when the saved value is still "~".
 */
export function resolveAgentLoginConfigPath(agent: AgentConfig): string {
  const configured = agent.configPath || AGENT_DEFAULTS[agent.type].configPath;
  let resolved = configured;
  if (configured === '~' || configured.startsWith('~/')) {
    const environmentPath = envConfigPath(agent.type);
    if (configured !== AGENT_DEFAULTS[agent.type].configPath) {
      throw new AgentLoginInputError('Custom agent credential paths must be absolute; "~" is only supported for the default path');
    } else if (environmentPath && path.isAbsolute(environmentPath)) {
      resolved = environmentPath;
    } else {
      resolved = configured === '~'
        ? os.homedir()
        : path.join(os.homedir(), configured.slice(2));
    }
  }
  resolved = path.normalize(resolved);
  if (!path.isAbsolute(resolved) || resolved.includes(':') || /[\0\r\n]/.test(resolved)) {
    throw new AgentLoginInputError('Agent credential path must be an absolute Linux path without colons or control characters');
  }
  if (resolved === path.parse(resolved).root) {
    throw new AgentLoginInputError('Agent credential path cannot be the filesystem root');
  }
  return resolved;
}

export function resolveOpenCodeDataPath(configPath: string): string {
  const configured = process.env.HOST_OPENCODE_DATA_DIR;
  if (configured) {
    const normalized = path.normalize(configured);
    if (!path.isAbsolute(normalized) || normalized.includes(':') || /[\0\r\n]/.test(normalized)) {
      throw new AgentLoginInputError('HOST_OPENCODE_DATA_DIR must be an absolute Linux path without colons or control characters');
    }
    return normalized;
  }
  const suffix = path.join('.config', 'opencode');
  return configPath.endsWith(suffix)
    ? path.join(configPath.slice(0, -suffix.length), '.local', 'share', 'opencode')
    : path.join(path.dirname(configPath), 'opencode-data');
}

export function buildAgentLoginCreateArgs(
  agent: AgentConfig,
  descriptor: AgentLoginDescriptor,
  credentialPath: string,
  containerName: string,
): string[] {
  const image = agent.dockerImage || AGENT_DEFAULTS[agent.type].dockerImage;
  if (!image || image.startsWith('-') || /\s/.test(image)) {
    throw new AgentLoginInputError('Agent Docker image is not configured correctly');
  }

  const environment = Object.entries(descriptor.environment ?? {})
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const additionalMounts = descriptor.additionalCredentialStore === 'opencode-data'
    ? ['-v', `${resolveOpenCodeDataPath(credentialPath)}:/home/node/.local/share/opencode:rw`]
    : [];

  return [
    'create',
    '--name', containerName,
    '--label', 'propr.agent-login=true',
    '-i',
    '-t',
    '--security-opt', 'no-new-privileges',
    '--cap-add', 'CHOWN',
    '--network', 'bridge',
    '--user', '0:0',
    '--tmpfs', `${CONTAINER_WORKSPACE}:rw,nosuid,nodev,size=16m`,
    '-v', `${credentialPath}:${descriptor.containerConfigPath}:rw`,
    ...additionalMounts,
    '-e', `PROPR_AGENT_TYPE=${agent.type}`,
    ...environment,
    '-w', CONTAINER_WORKSPACE,
    image,
    ...descriptor.command,
  ];
}
