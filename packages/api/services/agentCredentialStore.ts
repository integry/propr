import { mkdirSync } from 'node:fs';
import {
  getPastedAgentCredentialDefinition,
  isManagedAgentConfigPath,
  supportsPastedAgentCredentials,
  type AgentCredentialStatusResponse,
  type PastedAgentCredentialKind,
} from '@propr/shared';
import {
  applyPastedCredential,
  describePastedCredentials,
  isLoginCredentialEntry,
  PastedCredentialError,
  providerCredentialManifest,
  readCredentialStoreFile,
  removePastedCredential,
  storedLoginPresent,
  writeCredentialStoreFiles,
  type AgentConfig,
  type CredentialStoreKind,
} from '@propr/core';
import { AgentLoginInputError, resolveAgentLoginConfigPath, resolveOpenCodeDataPath } from './agentLoginDocker.js';

/**
 * The agent's canonical credential stores: the files Docker binds and the
 * remote runtimes upload. Pasted credentials and remote interactive logins
 * both write here, so every runtime sees them without further configuration.
 */
export interface AgentCredentialStores {
  config: string;
  data?: string;
}

export class AgentCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCredentialInputError';
  }
}

export function resolveAgentCredentialStores(agent: AgentConfig): AgentCredentialStores {
  let config: string;
  try {
    config = resolveAgentLoginConfigPath(agent);
  } catch (error) {
    if (error instanceof AgentLoginInputError) throw new AgentCredentialInputError(error.message);
    throw error;
  }
  const managed = isManagedAgentConfigPath(agent.configPath);
  const data = providerCredentialManifest(agent.type, 'data')
    ? resolveOpenCodeDataPath(config, managed)
    : undefined;
  return { config, ...(data ? { data } : {}) };
}

function storeRoot(stores: AgentCredentialStores, store: CredentialStoreKind): string {
  const root = store === 'data' ? stores.data : stores.config;
  if (!root) throw new AgentCredentialInputError(`This agent has no ${store} credential store`);
  return root;
}

function reader(stores: AgentCredentialStores) {
  return (store: CredentialStoreKind, relative: string): Buffer | undefined => {
    const root = store === 'data' ? stores.data : stores.config;
    if (!root) return undefined;
    try { return readCredentialStoreFile(root, relative); }
    catch { return undefined; }
  };
}

function prepareStore(agent: AgentConfig, root: string): void {
  // ProPR-managed stores are created on demand, as for an interactive login.
  if (isManagedAgentConfigPath(agent.configPath)) mkdirSync(root, { recursive: true, mode: 0o755 });
}

export function readAgentCredentialStatus(agent: AgentConfig): AgentCredentialStatusResponse {
  if (!supportsPastedAgentCredentials(agent.type)) {
    return { agentId: agent.id, credentials: [], loginPresent: false };
  }
  const read = reader(resolveAgentCredentialStores(agent));
  return {
    agentId: agent.id,
    credentials: describePastedCredentials(agent.type, read),
    loginPresent: storedLoginPresent(agent.type, read),
  };
}

function definitionFor(agent: AgentConfig, kind: unknown) {
  const definition = typeof kind === 'string' ? getPastedAgentCredentialDefinition(kind) : undefined;
  if (!definition) throw new AgentCredentialInputError('Unknown credential kind');
  if (definition.provider !== agent.type) {
    throw new AgentCredentialInputError(`${definition.label} cannot be used with a ${agent.type} agent`);
  }
  return definition;
}

async function rewrite(
  agent: AgentConfig,
  kind: unknown,
  change: (kind: PastedAgentCredentialKind, current: Buffer | undefined) => Buffer | null,
): Promise<AgentCredentialStatusResponse> {
  const definition = definitionFor(agent, kind);
  const stores = resolveAgentCredentialStores(agent);
  const root = storeRoot(stores, definition.store);
  prepareStore(agent, root);
  let content: Buffer | null;
  try {
    content = change(definition.kind, reader(stores)(definition.store, definition.path));
  } catch (error) {
    if (error instanceof PastedCredentialError) throw new AgentCredentialInputError(error.message);
    throw error;
  }
  await writeCredentialStoreFiles(root, [{ path: definition.path, content }]);
  return readAgentCredentialStatus(agent);
}

export function setAgentPastedCredential(agent: AgentConfig, kind: unknown, value: unknown): Promise<AgentCredentialStatusResponse> {
  if (typeof value !== 'string') return Promise.reject(new AgentCredentialInputError('value must be a string'));
  return rewrite(agent, kind, (definitionKind, current) => applyPastedCredential(definitionKind, value, current));
}

export function clearAgentPastedCredential(agent: AgentConfig, kind: unknown): Promise<AgentCredentialStatusResponse> {
  return rewrite(agent, kind, removePastedCredential);
}

export interface ReturnedLoginFile {
  store: CredentialStoreKind;
  path: string;
  content: Buffer;
}

/** The login files (manifest `login`/`refresh` entries) a remote login must copy back, per store. */
export function loginCredentialPaths(agent: AgentConfig): { store: CredentialStoreKind; path: string }[] {
  return (['config', 'data'] as const).flatMap(store => (providerCredentialManifest(agent.type, store)?.entries ?? [])
    .filter(isLoginCredentialEntry)
    .map(entry => ({ store, path: entry.path })));
}

/** Store the files an interactive login on a remote runtime produced. Paths outside the manifest's login files are refused. */
export async function storeReturnedLoginFiles(agent: AgentConfig, files: readonly ReturnedLoginFile[]): Promise<number> {
  const allowed = new Set(loginCredentialPaths(agent).map(entry => `${entry.store}:${entry.path}`));
  const stores = resolveAgentCredentialStores(agent);
  let written = 0;
  for (const store of ['config', 'data'] as const) {
    const writes = files.filter(file => file.store === store);
    if (writes.length === 0) continue;
    for (const file of writes) {
      if (!allowed.has(`${store}:${file.path}`)) throw new AgentCredentialInputError(`Unexpected login file ${file.path}`);
    }
    const root = storeRoot(stores, store);
    prepareStore(agent, root);
    await writeCredentialStoreFiles(root, writes.map(file => ({ path: file.path, content: file.content })));
    written += writes.length;
  }
  return written;
}

/**
 * Why a remote run of the agent would have nothing to authenticate with, or
 * undefined when its store holds a pasted credential or a login (or its
 * configuration sets the provider's API key variable). Providers without
 * pasted credentials are not judged here.
 */
export function remoteCredentialProblem(agent: AgentConfig): string | undefined {
  if (!supportsPastedAgentCredentials(agent.type)) return undefined;
  const apiKeyEnv = providerCredentialManifest(agent.type, 'config')?.apiKeyEnv ?? [];
  if (apiKeyEnv.some(name => agent.envVars?.[name]?.trim())) return undefined;
  let status: AgentCredentialStatusResponse;
  try {
    status = readAgentCredentialStatus(agent);
  } catch (error) {
    return (error as Error).message;
  }
  if (status.loginPresent || status.credentials.some(credential => credential.set)) return undefined;
  return 'No credentials are stored for this agent. Paste an API key or token under Edit agent → Credentials, or log in.';
}
