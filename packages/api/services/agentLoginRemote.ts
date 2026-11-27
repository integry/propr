import { existsSync } from 'node:fs';
import {
  effectiveAgentRuntimeName,
  redactSecrets,
  RemoteLoginCapacityError,
  FLY_MACHINES_AGENT_RUNTIME,
  FlyMachinesRuntime,
  REMOTE_LOGIN_HOME,
  SPRITES_AGENT_RUNTIME,
  SpritesRuntime,
  type AgentConfig,
  type RemoteLoginProcess,
  type RemoteLoginRequest,
} from '@propr/core';
import { getAgentLoginDescriptor, type AgentLoginDescriptor } from '@propr/shared';
import { loginCredentialPaths, storeReturnedLoginFiles, type ReturnedLoginFile } from './agentCredentialStore.js';

/**
 * Interactive logins on a remote agent runtime: used when the agent runs on
 * Sprites or Fly Machines and this instance has no local Docker daemon to
 * run the login container in (a Fly-launched instance, for example).
 */
export interface RemoteLoginBackend {
  runtime: typeof SPRITES_AGENT_RUNTIME | typeof FLY_MACHINES_AGENT_RUNTIME;
  start(request: RemoteLoginRequest): Promise<RemoteLoginProcess>;
}

export type RemoteLoginResolver = (agent: AgentConfig) => Promise<RemoteLoginBackend | undefined>;

/** OpenCode's data store inside the agent home (the Docker login mounts it at the same path). */
const OPENCODE_DATA_DIR = `${REMOTE_LOGIN_HOME}/.local/share/opencode`;

/** A local Docker daemon the login container can use: DOCKER_HOST, or the default socket. */
export function localDockerAvailable(environment: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (environment.DOCKER_HOST?.trim()) return true;
  return exists('/var/run/docker.sock');
}

interface RemoteLoginRuntimes {
  sprites?: SpritesRuntime;
  fly?: FlyMachinesRuntime;
}

/**
 * Picks the agent's remote runtime when there is no usable local Docker. With
 * Docker available the login keeps running in a local container, which writes
 * the same credential store.
 */
export function createDefaultRemoteLoginResolver(
  environment: NodeJS.ProcessEnv = process.env,
  dockerAvailable: () => boolean = () => localDockerAvailable(environment),
): { resolve: RemoteLoginResolver; close(): Promise<void> } {
  const runtimes: RemoteLoginRuntimes = {};
  return {
    async resolve(agent) {
      if (dockerAvailable()) return undefined;
      const runtime = await effectiveAgentRuntimeName(agent, environment);
      if (runtime === SPRITES_AGENT_RUNTIME) {
        return { runtime, start: request => (runtimes.sprites ??= new SpritesRuntime(undefined, environment)).startLogin(request) };
      }
      if (runtime === FLY_MACHINES_AGENT_RUNTIME) {
        return { runtime, start: request => (runtimes.fly ??= new FlyMachinesRuntime(undefined, environment)).startLogin(request) };
      }
      return undefined;
    },
    async close() {
      await runtimes.sprites?.close();
    },
  };
}

/** Where each login file of the manifest lives on the remote runtime. */
export function remoteLoginFileLocations(agent: AgentConfig, descriptor: AgentLoginDescriptor) {
  return loginCredentialPaths(agent).map(entry => ({
    ...entry,
    remotePath: `${entry.store === 'data' ? OPENCODE_DATA_DIR : descriptor.containerConfigPath}/${entry.path}`,
  }));
}

/** Directories the login CLI writes to: its config directory and, for OpenCode, its data directory. */
export function remoteLoginDirectories(agent: AgentConfig, descriptor: AgentLoginDescriptor): string[] {
  return [descriptor.containerConfigPath, ...(loginCredentialPaths(agent).some(entry => entry.store === 'data') ? [OPENCODE_DATA_DIR] : [])];
}

/** {@link collectRemoteLoginFiles} with the agent type's login descriptor. */
export function collectRemoteLoginForAgent(agent: AgentConfig, process: RemoteLoginProcess): Promise<number> {
  const descriptor = getAgentLoginDescriptor(agent.type);
  if (!descriptor) return Promise.reject(new Error(`${agent.type} does not support interactive login`));
  return collectRemoteLoginFiles(agent, descriptor, process);
}

/** Copy the login files the manifest declares from the runtime into the agent's credential store. */
export async function collectRemoteLoginFiles(
  agent: AgentConfig,
  descriptor: AgentLoginDescriptor,
  process: Pick<RemoteLoginProcess, 'readFile'>,
  store: typeof storeReturnedLoginFiles = storeReturnedLoginFiles,
): Promise<number> {
  const files: ReturnedLoginFile[] = [];
  for (const location of remoteLoginFileLocations(agent, descriptor)) {
    const content = await process.readFile(location.remotePath);
    if (content && content.length > 0) files.push({ store: location.store, path: location.path, content });
  }
  if (files.length === 0) return 0;
  return store(agent, files);
}

type TerminalStatus = 'succeeded' | 'failed';

export interface RemoteLoginSessionHooks {
  agent: AgentConfig;
  descriptor: AgentLoginDescriptor;
  backend: RemoteLoginBackend;
  signal: AbortSignal;
  output(chunk: string): void;
  /** Whether the session already ended (cancelled, timed out). */
  terminal(): boolean;
  attach(process: RemoteLoginProcess): void;
  finish(status: TerminalStatus, exitCode?: number, error?: string): void;
  collect(process: RemoteLoginProcess): Promise<number>;
  /** Destroys the Sprite or Machine once attached. */
  cleanup(): Promise<void>;
}

/**
 * Drives one login session on a remote runtime. The runtime is prepared in
 * the background (a new Sprite takes minutes), so the session stays in
 * `starting` while the browser keeps polling; output and input then flow
 * through the runtime. The login files are stored before the session reports
 * success, and the Sprite or Machine is destroyed in every outcome.
 */
export async function runRemoteLoginSession(hooks: RemoteLoginSessionHooks): Promise<void> {
  const { agent, descriptor, backend } = hooks;
  const runtimeLabel = backend.runtime === SPRITES_AGENT_RUNTIME ? 'Sprites' : 'Fly Machines';
  hooks.output(`No local Docker daemon: running the ${agent.type} login on ${runtimeLabel}.\n`);
  let remote: RemoteLoginProcess;
  try {
    remote = await backend.start({
      agentType: agent.type,
      command: descriptor.command,
      environment: descriptor.environment,
      directories: remoteLoginDirectories(agent, descriptor),
      signal: hooks.signal,
      onProgress: message => hooks.output(`${message}\n`),
    });
  } catch (error) {
    if (hooks.terminal()) return;
    const message = redactSecrets((error as Error).message || 'Could not start the remote login');
    hooks.output(`${message}\n`);
    hooks.finish('failed', undefined, error instanceof RemoteLoginCapacityError ? message : `Could not start the login on ${runtimeLabel}: ${message}`);
    return;
  }
  if (hooks.terminal()) {
    remote.kill();
    await remote.close();
    return;
  }
  hooks.attach(remote);
  remote.onOutput(chunk => hooks.output(chunk));
  hooks.output(`Connected to ${remote.location}.\n`);
  try {
    const code = await remote.exited;
    if (hooks.terminal()) return;
    if (code !== 0) {
      hooks.finish('failed', code, `Agent login exited with code ${code}`);
      return;
    }
    const stored = await hooks.collect(remote).catch((error: Error) => {
      const message = redactSecrets(error.message);
      hooks.output(`${message}\n`);
      hooks.finish('failed', 0, `Could not save the login: ${message}`);
      return undefined;
    });
    if (stored === undefined) return;
    if (stored === 0) {
      hooks.finish('failed', 0, 'Could not save the login: the login finished but wrote no credential files');
      return;
    }
    hooks.output(`Saved ${stored} credential file${stored === 1 ? '' : 's'} to this agent's credential store.\n`);
    hooks.finish('succeeded', 0);
  } catch (error) {
    if (!hooks.terminal()) {
      hooks.output(`${redactSecrets((error as Error).message)}\n`);
      hooks.finish('failed', undefined, 'Lost the connection to the remote login');
    }
  } finally {
    await hooks.cleanup();
  }
}
