import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
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
const MAX_ANTIGRAVITY_TOKEN_LENGTH = 1024 * 1024;
const MAX_ANTIGRAVITY_ONBOARDING_LENGTH = 64 * 1024;
const MAX_CREDENTIAL_JSON_DEPTH = 16;
const MAX_CREDENTIAL_JSON_NODES = 2048;

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

interface BoundedFile {
  text: string;
  fingerprintPart: string;
}

async function readBoundedFile(filePath: string, maxLength: number): Promise<BoundedFile | undefined> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxLength) return undefined;
    const buffer = Buffer.alloc(Math.min(maxLength + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxLength) return undefined;
    return {
      text: buffer.subarray(0, offset).toString('utf8'),
      fingerprintPart: `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(buffer.subarray(0, offset)).digest('hex')}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

const CREDENTIAL_FIELD_NAMES = new Set([
  'token',
  'oauthtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
]);
const EXPIRATION_FIELD_NAMES = new Set([
  'expiresat',
  'expires',
  'expiry',
  'expiration',
  'expirydate',
]);

function normalizedCredentialKey(value: string): string {
  return value.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

function parseExpiration(value: unknown): number | undefined {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    parsed = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(parsed)) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function hasValidCredential(payload: Record<string, unknown>, now = Date.now()): boolean {
  let visited = 0;
  const visit = (value: unknown, depth: number, inheritedExpiration?: unknown): boolean => {
    if (!value || typeof value !== 'object' || depth > MAX_CREDENTIAL_JSON_DEPTH) return false;
    if (++visited > MAX_CREDENTIAL_JSON_NODES) return false;
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1, inheritedExpiration));

    const record = value as Record<string, unknown>;
    const localExpirationEntry = Object.entries(record).find(([key]) => (
      EXPIRATION_FIELD_NAMES.has(normalizedCredentialKey(key))
    ));
    const effectiveExpiration = localExpirationEntry?.[1] ?? inheritedExpiration;
    for (const [key, credential] of Object.entries(record)) {
      if (!CREDENTIAL_FIELD_NAMES.has(normalizedCredentialKey(key))) continue;
      if (typeof credential !== 'string' || !credential.trim()) continue;
      if (effectiveExpiration === undefined) return true;
      const expiration = parseExpiration(effectiveExpiration);
      if (expiration !== undefined && expiration > now) return true;
    }
    return Object.values(record).some(child => visit(child, depth + 1, effectiveExpiration));
  };
  return visit(payload, 0);
}

export interface AgentLoginCompletion {
  complete: boolean;
  fingerprint?: string;
}

export async function inspectAgentLoginCompletion(
  type: AgentType,
  credentialPath: string,
): Promise<AgentLoginCompletion> {
  if (type !== 'antigravity') return { complete: false };
  try {
    const [tokenFile, onboardingFile] = await Promise.all([
      readBoundedFile(path.join(credentialPath, ANTIGRAVITY_TOKEN_PATH), MAX_ANTIGRAVITY_TOKEN_LENGTH),
      readBoundedFile(path.join(credentialPath, ANTIGRAVITY_ONBOARDING_PATH), MAX_ANTIGRAVITY_ONBOARDING_LENGTH),
    ]);
    if (!tokenFile || !onboardingFile) return { complete: false };
    const fingerprint = createHash('sha256')
      .update(tokenFile.fingerprintPart)
      .update('\0')
      .update(onboardingFile.fingerprintPart)
      .digest('hex');
    const token = tokenFile.text.trim();
    if (!token) return { complete: false, fingerprint };
    let credentialValid = true;
    if (token.startsWith('{') || token.startsWith('[')) {
      const payload = JSON.parse(token) as unknown;
      credentialValid = Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
        && hasValidCredential(payload as Record<string, unknown>));
    }
    const onboarding = JSON.parse(onboardingFile.text) as unknown;
    const onboardingComplete = Boolean(onboarding
      && typeof onboarding === 'object'
      && !Array.isArray(onboarding)
      && (onboarding as Record<string, unknown>).onboardingComplete === true);
    return { complete: credentialValid && onboardingComplete, fingerprint };
  } catch {
    return { complete: false };
  }
}

export async function isAgentLoginComplete(type: AgentType, credentialPath: string): Promise<boolean> {
  return (await inspectAgentLoginCompletion(type, credentialPath)).complete;
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
    ...(agent.type === 'antigravity' ? ['-e', 'PROPR_AGENT_LOGIN=1'] : []),
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
