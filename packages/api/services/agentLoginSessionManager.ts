import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  getAgentLoginDescriptor,
  isManagedAgentConfigPath,
  type AgentLoginDescriptor,
  type AgentType,
} from '@propr/shared';
import { redactSecrets, type AgentConfig, type RemoteLoginProcess } from '@propr/core';
import { clearPastedAuthenticationAfterLogin, pastedAuthenticationOverridesLogin } from './agentCredentialStore.js';
import {
  AgentLoginInputError,
  buildAgentLoginCreateArgs,
  ensureAgentLoginImage,
  removeOrphanedAgentLoginContainers,
  resolveAgentLoginConfigPath,
  resolveAgentLoginImage,
} from './agentLoginDocker.js';
import { defaultRunDocker, defaultSpawnDocker, type DockerCommandResult } from './agentLoginDockerProcess.js';

import {
  collectRemoteLoginForAgent,
  createDefaultRemoteLoginResolver,
  localDockerAvailable,
  runRemoteLoginSession,
  type RemoteLoginBackend,
  type RemoteLoginResolver,
} from './agentLoginRemote.js';
import { sanitizeTerminalChunk, type TerminalEscapeState } from './agentLoginTerminal.js';

export { AgentLoginInputError } from './agentLoginDocker.js';

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_RETENTION_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 128 * 1024;
const MAX_INPUT_LENGTH = 4096;

export type AgentLoginSessionStatus = 'starting' | 'running' | 'succeeded'
  | 'failed' | 'cancelled' | 'timed_out';

const TERMINAL_STATUSES = new Set<AgentLoginSessionStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export interface AgentLoginSessionSnapshot {
  id: string;
  agentId: string;
  agentType: AgentType;
  status: AgentLoginSessionStatus;
  output: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  exitCode?: number;
  error?: string;
}

interface AgentLoginSession extends AgentLoginSessionSnapshot {
  owner: string;
  credentialPath: string;
  containerName: string;
  process?: ChildProcessWithoutNullStreams;
  /** Set when the login runs on Sprites or Fly Machines instead of a local container. */
  remote?: RemoteLoginProcess;
  remoteAbort?: AbortController;
  /** Cancels a local login's settings cleanup while it waits for the store lock. */
  localAbort?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  retentionTimeout?: ReturnType<typeof setTimeout>;
  cleanupStarted?: boolean;
  escapeState: TerminalEscapeState;
  outputEndedWithCarriageReturn?: boolean;
}

export type { DockerCommandResult } from './agentLoginDockerProcess.js';

export interface AgentLoginSessionManagerDeps {
  runDocker?: (args: string[]) => Promise<DockerCommandResult>;
  spawnDocker?: (args: string[]) => ChildProcessWithoutNullStreams;
  now?: () => number;
  id?: () => string;
  sessionTimeoutMs?: number;
  sessionRetentionMs?: number;
  scope?: string;
  /** Selects a remote runtime for agents that run on one when no local Docker is usable. */
  resolveRemoteLogin?: RemoteLoginResolver;
  /** Whether a local Docker daemon exists (login containers to sweep). */
  dockerAvailable?: () => boolean;
  /** Copies the login files from the remote runtime into the agent's store; returns how many were stored. */
  collectRemoteLogin?: (agent: AgentConfig, process: RemoteLoginProcess, signal: AbortSignal) => Promise<number>;
}

export class AgentLoginConflictError extends Error {
  constructor() {
    super('A login is already active for this agent credential directory');
    this.name = 'AgentLoginConflictError';
  }
}

export class AgentLoginSessionNotFoundError extends Error {
  constructor() {
    super('Agent login session not found');
    this.name = 'AgentLoginSessionNotFoundError';
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function isTerminal(status: AgentLoginSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function normalizeScope(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128);
  return normalized || 'propr';
}

export class AgentLoginSessionManager {
  private readonly sessions = new Map<string, AgentLoginSession>();
  private readonly activeCredentialPaths = new Set<string>();
  private readonly runDocker: NonNullable<AgentLoginSessionManagerDeps['runDocker']>;
  private readonly spawnDocker: NonNullable<AgentLoginSessionManagerDeps['spawnDocker']>;
  private readonly now: NonNullable<AgentLoginSessionManagerDeps['now']>;
  private readonly id: NonNullable<AgentLoginSessionManagerDeps['id']>;
  private readonly sessionTimeoutMs: number;
  private readonly sessionRetentionMs: number;
  private readonly scope: string;
  private readonly resolveRemoteLogin: RemoteLoginResolver;
  private readonly collectRemoteLogin: NonNullable<AgentLoginSessionManagerDeps['collectRemoteLogin']>;
  private readonly closeRemote: () => Promise<void>;
  private readonly dockerAvailable: () => boolean;

  constructor(deps: AgentLoginSessionManagerDeps = {}) {
    this.runDocker = deps.runDocker ?? defaultRunDocker;
    this.spawnDocker = deps.spawnDocker ?? defaultSpawnDocker;
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
    this.sessionTimeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionRetentionMs = deps.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    this.scope = normalizeScope(deps.scope ?? process.env.PROPR_STACK ?? 'propr');
    // An injected Docker runner (tests, embedders) keeps every login local unless a resolver is injected too.
    this.dockerAvailable = deps.dockerAvailable ?? (deps.runDocker ? () => true : () => localDockerAvailable());
    const remote = deps.resolveRemoteLogin || deps.runDocker
      ? { resolve: deps.resolveRemoteLogin ?? (async () => undefined), close: async () => {} }
      : createDefaultRemoteLoginResolver();
    this.resolveRemoteLogin = remote.resolve;
    this.closeRemote = remote.close;
    this.collectRemoteLogin = deps.collectRemoteLogin ?? collectRemoteLoginForAgent;
  }

  /**
   * Remove login containers left behind by an API crash. The stack-scoped
   * label avoids interrupting an active login owned by another ProPR stack on
   * the same Docker daemon.
   */
  async cleanupOrphanedContainers(): Promise<number> {
    // Sprites-only and Fly-only instances have no Docker daemon to sweep.
    if (!this.dockerAvailable()) return 0;
    return removeOrphanedAgentLoginContainers(this.runDocker, this.scope);
  }

  async start(agent: AgentConfig, owner: string): Promise<AgentLoginSessionSnapshot> {
    const descriptor = getAgentLoginDescriptor(agent.type);
    if (!descriptor) {
      throw new AgentLoginInputError(`${agent.type} does not support interactive login`);
    }
    const credentialPath = resolveAgentLoginConfigPath(agent);
    if (this.activeCredentialPaths.has(credentialPath)) throw new AgentLoginConflictError();

    const id = this.id();
    const containerName = `propr-agent-login-${id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48)}`;
    const timestamp = this.now();
    const session: AgentLoginSession = {
      id,
      agentId: agent.id,
      agentType: agent.type,
      owner,
      credentialPath,
      containerName,
      status: 'starting',
      output: '',
      escapeState: 'text',
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + this.sessionTimeoutMs).toISOString(),
    };
    this.sessions.set(id, session);
    this.activeCredentialPaths.add(credentialPath);
    this.scheduleTimeout(session, timestamp);

    let remote;
    try {
      remote = await this.resolveRemoteLogin(agent);
    } catch (error) {
      this.appendOutput(session, `${(error as Error).message}\n`);
      this.finish(session, 'failed', undefined, (error as Error).message || 'Could not select the agent login runtime');
      return this.snapshot(session);
    }
    if (remote) {
      this.startRemote(session, agent, descriptor, remote);
      return this.snapshot(session);
    }

    try {
      if (isManagedAgentConfigPath(agent.configPath)) {
        // Materialize the isolated bind source explicitly. The provider
        // entrypoint then normalizes ownership of the mounted leaf before
        // dropping privileges and writing credential files.
        mkdirSync(credentialPath, { recursive: true, mode: 0o755 });
      }
      const image = resolveAgentLoginImage(agent);
      const createArgs = buildAgentLoginCreateArgs(
        agent,
        descriptor,
        credentialPath,
        containerName,
        this.scope,
      );
      await ensureAgentLoginImage(this.runDocker, image, chunk => this.appendOutput(session, chunk));
      await this.runDocker(createArgs);
      this.attach(session, agent);
    } catch (error) {
      this.appendOutput(session, `${(error as Error).message}\n`);
      this.finish(session, 'failed', undefined, (error as Error).message || 'Could not start the agent login container');
      await this.cleanupContainer(session);
    }

    return this.snapshot(session);
  }

  get(sessionId: string, owner: string): AgentLoginSessionSnapshot {
    return this.snapshot(this.requireSession(sessionId, owner));
  }

  write(sessionId: string, owner: string, input: string): AgentLoginSessionSnapshot {
    const session = this.requireSession(sessionId, owner);
    if (session.status === 'running' && session.remote) {
      if (!input || input.length > MAX_INPUT_LENGTH) {
        throw new AgentLoginInputError(`Input must contain between 1 and ${MAX_INPUT_LENGTH} characters`);
      }
      session.remote.write(input).catch(error => this.appendOutput(session, `${(error as Error).message}\n`));
      const timestamp = this.now();
      this.touch(session, timestamp);
      this.scheduleTimeout(session, timestamp);
      return this.snapshot(session);
    }
    if (session.status !== 'running' || !session.process?.stdin.writable) {
      throw new AgentLoginInputError('Agent login session is not accepting input');
    }
    if (!input || input.length > MAX_INPUT_LENGTH) {
      throw new AgentLoginInputError(`Input must contain between 1 and ${MAX_INPUT_LENGTH} characters`);
    }
    session.process.stdin.write(input);
    const timestamp = this.now();
    this.touch(session, timestamp);
    this.scheduleTimeout(session, timestamp);
    return this.snapshot(session);
  }

  async cancel(sessionId: string, owner: string): Promise<AgentLoginSessionSnapshot> {
    const session = this.requireSession(sessionId, owner);
    if (!isTerminal(session.status)) {
      this.finish(session, 'cancelled', undefined, 'Login cancelled');
      this.stopProcess(session);
      await this.cleanupContainer(session);
    }
    return this.snapshot(session);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map(async (session) => {
      if (session.timeout) clearTimeout(session.timeout);
      if (session.retentionTimeout) clearTimeout(session.retentionTimeout);
      if (!isTerminal(session.status)) {
        session.status = 'cancelled';
        this.stopProcess(session);
      }
      await this.cleanupContainer(session);
    }));
    this.sessions.clear();
    this.activeCredentialPaths.clear();
    await this.closeRemote();
  }

  private attach(session: AgentLoginSession, agent: AgentConfig): void {
    const child = this.spawnDocker(['start', '-a', '-i', session.containerName]);
    session.process = child;
    session.status = 'running';
    this.touch(session);
    child.stdout.on('data', chunk => this.appendOutput(session, chunk.toString()));
    child.stderr.on('data', chunk => this.appendOutput(session, chunk.toString()));
    child.stdin.on('error', () => {
      // A provider can close stdin as it transitions to browser polling.
    });
    child.on('error', error => {
      if (isTerminal(session.status)) return;
      this.appendOutput(session, `${error.message}\n`);
      this.finish(session, 'failed', undefined, 'Agent login process failed');
      void this.cleanupContainer(session);
    });
    child.on('close', code => {
      if (isTerminal(session.status)) return;
      if (code === 0 && pastedAuthenticationOverridesLogin(agent.type)) {
        void this.completeLocalLogin(session, agent);
        return;
      }
      this.finish(
        session,
        code === 0 ? 'succeeded' : 'failed',
        code ?? undefined,
        code === 0 ? undefined : `Agent login exited with code ${code ?? 'unknown'}`,
      );
      void this.cleanupContainer(session);
    });
  }

  /**
   * A local login container wrote its files into the store itself, so a
   * pasted credential that would override them is removed (as a remote
   * login's collection does) before the session reports success. A session
   * cancelled or timed out meanwhile aborts the cleanup before it publishes.
   */
  private async completeLocalLogin(session: AgentLoginSession, agent: AgentConfig): Promise<void> {
    const abort = new AbortController();
    session.localAbort = abort;
    try {
      await clearPastedAuthenticationAfterLogin(agent, abort.signal);
      if (!isTerminal(session.status)) this.finish(session, 'succeeded', 0);
    } catch (error) {
      if (!isTerminal(session.status)) {
        const message = redactSecrets((error as Error).message);
        this.appendOutput(session, `${message}\n`);
        this.finish(session, 'failed', 0, `Could not save the login: ${message}`);
      }
    } finally {
      await this.cleanupContainer(session);
    }
  }

  private async timeoutSession(session: AgentLoginSession): Promise<void> {
    if (isTerminal(session.status)) return;
    this.finish(session, 'timed_out', undefined, 'Agent login timed out');
    this.stopProcess(session);
    await this.cleanupContainer(session);
  }

  private finish(
    session: AgentLoginSession,
    status: AgentLoginSessionStatus,
    exitCode?: number,
    error?: string,
  ): void {
    session.status = status;
    session.exitCode = exitCode;
    session.error = error;
    this.touch(session);
    this.activeCredentialPaths.delete(session.credentialPath);
    if (session.timeout) {
      clearTimeout(session.timeout);
      session.timeout = undefined;
    }
    if (!session.retentionTimeout) {
      session.retentionTimeout = setTimeout(() => {
        this.sessions.delete(session.id);
      }, this.sessionRetentionMs);
      unrefTimer(session.retentionTimeout);
    }
  }

  private appendOutput(session: AgentLoginSession, chunk: string): void {
    const next = `${session.output}${sanitizeTerminalChunk(session, chunk)}`;
    session.output = next.length > MAX_OUTPUT_LENGTH
      ? `[Earlier output removed]\n${next.slice(next.length - MAX_OUTPUT_LENGTH)}`
      : next;
    this.touch(session);
  }

  private touch(session: AgentLoginSession, timestamp = this.now()): void {
    session.updatedAt = new Date(timestamp).toISOString();
  }

  private scheduleTimeout(session: AgentLoginSession, timestamp = this.now()): void {
    if (session.timeout) clearTimeout(session.timeout);
    session.expiresAt = new Date(timestamp + this.sessionTimeoutMs).toISOString();
    session.timeout = setTimeout(() => {
      void this.timeoutSession(session);
    }, this.sessionTimeoutMs);
    unrefTimer(session.timeout);
  }

  private requireSession(sessionId: string, owner: string): AgentLoginSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) throw new AgentLoginSessionNotFoundError();
    return session;
  }

  private stopProcess(session: AgentLoginSession): void {
    session.process?.kill();
    session.localAbort?.abort();
    session.remoteAbort?.abort();
    session.remote?.kill();
  }

  /** A login on Sprites or Fly Machines; see {@link runRemoteLoginSession}. */
  private startRemote(
    session: AgentLoginSession,
    agent: AgentConfig,
    descriptor: AgentLoginDescriptor,
    backend: RemoteLoginBackend,
  ): void {
    const abort = new AbortController();
    session.remoteAbort = abort;
    void runRemoteLoginSession({
      agent, descriptor, backend, signal: abort.signal,
      output: chunk => this.appendOutput(session, chunk),
      terminal: () => isTerminal(session.status),
      attach: remote => {
        session.remote = remote;
        session.status = 'running';
        this.touch(session);
      },
      finish: (status, exitCode, error) => this.finish(session, status, exitCode, error),
      collect: (remote, signal) => this.collectRemoteLogin(agent, remote, signal),
      cleanup: () => this.cleanupContainer(session),
    });
  }

  private async cleanupContainer(session: AgentLoginSession): Promise<void> {
    if (session.cleanupStarted) return;
    if (session.remote) {
      session.cleanupStarted = true;
      await session.remote.close().catch(() => {});
      return;
    }
    // A remote login still being prepared closes its runtime itself once it is ready.
    if (session.remoteAbort) return;
    session.cleanupStarted = true;
    try {
      await this.runDocker(['rm', '-f', session.containerName]);
    } catch {
      // The container may already have been removed by Docker or never created.
    }
  }

  private snapshot(session: AgentLoginSession): AgentLoginSessionSnapshot {
    const { id, agentId, agentType, status, output, createdAt, updatedAt, expiresAt, exitCode, error } = session;
    return {
      id, agentId, agentType, status, output,
      createdAt, updatedAt, expiresAt,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(error === undefined ? {} : { error }),
    };
  }
}

export const agentLoginSessionManager = new AgentLoginSessionManager();
