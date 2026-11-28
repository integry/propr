import { mkdirSync } from 'node:fs';
import {
  AGENT_MODELS,
  getPastedAgentCredentialDefinition,
  isManagedAgentConfigPath,
  supportsPastedAgentCredentials,
  type AgentCredentialStatusResponse,
  type PastedAgentCredentialKind,
} from '@propr/shared';
import {
  AGENT_DEFAULTS,
  applyPastedCredential,
  CredentialBrokerError,
  describePastedCredentials,
  environmentCredentialPresent,
  isLoginCredentialEntry,
  loadSettings,
  PastedCredentialError,
  providerCredentialManifest,
  readCredentialStoreFile,
  removePastedCredential,
  resolveConfigPath,
  storedConfigCredentialPresent,
  storedLoginPresent,
  withoutPastedClaudeAuthentication,
  writeCredentialStoreFiles,
  type AgentConfig,
  type CredentialStoreKind,
  type CredentialStoreWrite,
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

/**
 * Tolerant reader for status reporting only: an unreadable file reads as
 * absent. Mutations must use {@link strictRead}, or a failed read would be
 * merged as an empty document and overwrite the existing file.
 */
function reader(stores: AgentCredentialStores) {
  return (store: CredentialStoreKind, relative: string): Buffer | undefined => {
    const root = store === 'data' ? stores.data : stores.config;
    if (!root) return undefined;
    try { return readCredentialStoreFile(root, relative); }
    catch { return undefined; }
  };
}

/** The current file for a read-modify-write: missing reads as undefined, any read failure is refused. */
function strictRead(root: string, relative: string): Buffer | undefined {
  try { return readCredentialStoreFile(root, relative); }
  catch (error) {
    const reason = error instanceof CredentialBrokerError ? error.message : (error as NodeJS.ErrnoException).code ?? 'read failed';
    throw new AgentCredentialInputError(`The existing ${relative} could not be read, so it was left unchanged (${reason})`);
  }
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
  // Read and merge under the store lock that publishes the result, so a
  // concurrent edit of the same file is never overwritten with a stale merge.
  try {
    await writeCredentialStoreFiles(root, () => [
      { path: definition.path, content: change(definition.kind, strictRead(root, definition.path)) },
    ]);
  } catch (error) {
    if (error instanceof PastedCredentialError) throw new AgentCredentialInputError(error.message);
    throw error;
  }
  return readAgentCredentialStatus(agent);
}

export function setAgentPastedCredential(agent: AgentConfig, kind: unknown, value: unknown): Promise<AgentCredentialStatusResponse> {
  if (typeof value !== 'string') return Promise.reject(new AgentCredentialInputError('value must be a string'));
  return rewrite(agent, kind, (definitionKind, current) => applyPastedCredential(definitionKind, value, current));
}

export function clearAgentPastedCredential(agent: AgentConfig, kind: unknown): Promise<AgentCredentialStatusResponse> {
  return rewrite(agent, kind, removePastedCredential);
}

const CLAUDE_SETTINGS = 'settings.json';

/** Whether a pasted credential of this provider overrides its interactive login until removed (Claude's settings.json env). */
export function pastedAuthenticationOverridesLogin(type: AgentConfig['type']): boolean {
  return type === 'claude';
}

/** The settings.json rewrite that drops pasted Claude authentication, read under the store lock. */
function pastedAuthenticationCleanup(agent: AgentConfig, store: CredentialStoreKind, root: string): CredentialStoreWrite[] {
  if (!pastedAuthenticationOverridesLogin(agent.type) || store !== 'config') return [];
  const next = withoutPastedClaudeAuthentication(strictRead(root, CLAUDE_SETTINGS));
  return next ? [{ path: CLAUDE_SETTINGS, content: next }] : [];
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

/**
 * Store the files an interactive login on a remote runtime produced. Paths
 * outside the manifest's login files are refused. `signal` (the login
 * session's cancellation) is checked under each store's lock immediately
 * before publication, so a session cancelled or timed out while this waited
 * for the lock stores nothing further.
 *
 * Storing a Claude login also removes the pasted authentication variables
 * from the same store's settings.json, in the same locked publication, so a
 * previously pasted key or token no longer overrides the new login.
 */
export async function storeReturnedLoginFiles(
  agent: AgentConfig, files: readonly ReturnedLoginFile[], signal?: AbortSignal,
): Promise<number> {
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
    const loginWrites: CredentialStoreWrite[] = writes.map(file => ({ path: file.path, content: file.content }));
    try {
      await writeCredentialStoreFiles(root, () => [...loginWrites, ...pastedAuthenticationCleanup(agent, store, root)], { signal });
    } catch (error) {
      if (error instanceof PastedCredentialError) throw new AgentCredentialInputError(error.message);
      throw error;
    }
    written += writes.length;
  }
  return written;
}

/**
 * After a local (Docker) login, whose container wrote the login files into
 * the store itself: remove the pasted authentication that would override
 * them from settings.json under the store lock, as
 * {@link storeReturnedLoginFiles} does for a remote login, keeping other
 * settings. `signal` (the session's cancellation) is checked under the lock
 * immediately before publication.
 */
export async function clearPastedAuthenticationAfterLogin(agent: AgentConfig, signal?: AbortSignal): Promise<void> {
  if (!pastedAuthenticationOverridesLogin(agent.type)) return;
  const root = storeRoot(resolveAgentCredentialStores(agent), 'config');
  try {
    await writeCredentialStoreFiles(root, () => pastedAuthenticationCleanup(agent, 'config', root), { signal });
  } catch (error) {
    if (error instanceof PastedCredentialError) throw new AgentCredentialInputError(error.message);
    throw error;
  }
}

/**
 * The Vibe config directory a run reads, resolved as its execution resolves it
 * (`VIBE_CONFIG_PATH` first; no managed-login path rules). An unmapped default
 * throws, which execution also reports when no API key is available.
 */
function vibeExecutionStores(agent: AgentConfig): AgentCredentialStores {
  return { config: resolveConfigPath(process.env.VIBE_CONFIG_PATH || agent.configPath || AGENT_DEFAULTS.vibe.configPath) };
}

/** Whether an OpenCode agent offers a built-in free model, which runs without any provider credential. */
function offersCredentialFreeModel(agent: AgentConfig): boolean {
  const free = new Set(AGENT_MODELS.opencode.map(model => model.id));
  return agent.supportedModels.some(model => free.has(model));
}

export interface RemoteCredentialProblemOptions {
  /** ProPR settings, read for Vibe's Mistral key setting. Defaults to the stored settings. */
  loadSettings?: () => Promise<Record<string, unknown>>;
}

/**
 * Why a remote run of the agent would have nothing to authenticate with, or
 * undefined when it has a credential execution supplies to the run: a pasted
 * credential or a login file the provider manifest declares; a key in the
 * agent's env vars (and, for Vibe, the ProPR environment or Mistral key
 * setting); a key in a manifest secret environment file (Vibe's `.env`); or
 * a provider `options.apiKey` in OpenCode's config file. An OpenCode agent
 * offering a built-in free model needs none. Login files are checked for every
 * provider, including those without pasted credentials (Antigravity); a
 * provider whose manifest declares neither is not judged here.
 */
export async function remoteCredentialProblem(
  agent: AgentConfig, options: RemoteCredentialProblemOptions = {},
): Promise<string | undefined> {
  const pasted = supportsPastedAgentCredentials(agent.type);
  if (!pasted && loginCredentialPaths(agent).length === 0) return undefined;
  if (agent.type === 'opencode' && offersCredentialFreeModel(agent)) return undefined;
  if (environmentCredentialPresent(agent)) return undefined;
  let storeProblem: string | undefined;
  try {
    // Vibe resolves its config directory as its run does (VIBE_CONFIG_PATH, no managed login path).
    const stores = agent.type === 'vibe' ? vibeExecutionStores(agent) : resolveAgentCredentialStores(agent);
    const read = reader(stores);
    if (storedLoginPresent(agent.type, read) || storedConfigCredentialPresent(agent.type, read)) return undefined;
    if (pasted && describePastedCredentials(agent.type, read).some(credential => credential.set)) return undefined;
  } catch (error) {
    storeProblem = (error as Error).message;
  }
  if (agent.type === 'vibe' && await settingsMistralKeyPresent(agent, options)) return undefined;
  if (storeProblem) return storeProblem;
  if (agent.type === 'vibe') {
    return 'No Mistral API key or Vibe login is available to this agent. Set MISTRAL_API_KEY or add a .env or credentials.json to its config directory, then check again.';
  }
  return pasted
    ? 'No credentials are stored for this agent. Paste an API key or token under Edit agent → Credentials, or log in.'
    : 'No login is stored for this agent. Log in from Edit agent, then check again.';
}

async function settingsMistralKeyPresent(agent: AgentConfig, options: RemoteCredentialProblemOptions): Promise<boolean> {
  try {
    const settings = await (options.loadSettings ?? loadSettings)();
    return environmentCredentialPresent(agent, { settings, env: {} });
  } catch {
    // As at run time: unreadable settings contribute no key.
    return false;
  }
}
