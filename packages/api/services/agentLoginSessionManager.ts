import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  AGENT_DEFAULTS,
  getAgentLoginDescriptor,
  type AgentType,
} from '@propr/shared';
import type { AgentConfig } from '@propr/core';
import {
  AgentLoginInputError,
  buildAgentLoginCreateArgs,
  resolveAgentLoginConfigPath,
} from './agentLoginDocker.js';

export { AgentLoginInputError } from './agentLoginDocker.js';

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_RETENTION_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 128 * 1024;
const MAX_INPUT_LENGTH = 4096;

const TERMINAL_STATUSES = new Set<AgentLoginSessionStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

// OSC, CSI, and the remaining single-character ANSI escape sequences. The UI
// needs readable text and links, not terminal control instructions.
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_SINGLE_RE = /\u001B[@-_]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

export type AgentLoginSessionStatus =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

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
  timeout?: ReturnType<typeof setTimeout>;
  retentionTimeout?: ReturnType<typeof setTimeout>;
  cleanupStarted?: boolean;
}

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export interface AgentLoginSessionManagerDeps {
  runDocker?: (args: string[]) => Promise<DockerCommandResult>;
  spawnDocker?: (args: string[]) => ChildProcessWithoutNullStreams;
  now?: () => number;
  id?: () => string;
  sessionTimeoutMs?: number;
  sessionRetentionMs?: number;
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

function defaultRunDocker(args: string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultSpawnDocker(args: string[]): ChildProcessWithoutNullStreams {
  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = ['docker', ...args].map(shellQuote).join(' ');
  // Docker refuses to attach a container TTY when its own stdin is a pipe.
  // util-linux script(1) supplies the controlling PTY while keeping Node's
  // stdin/stdout pipeable for the browser session.
  return spawn('script', ['-qefc', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function isTerminal(status: AgentLoginSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function sanitizeOutput(value: string): string {
  return value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_SINGLE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(UNSAFE_CONTROL_RE, '');
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

  constructor(deps: AgentLoginSessionManagerDeps = {}) {
    this.runDocker = deps.runDocker ?? defaultRunDocker;
    this.spawnDocker = deps.spawnDocker ?? defaultSpawnDocker;
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
    this.sessionTimeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionRetentionMs = deps.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
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
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + this.sessionTimeoutMs).toISOString(),
    };
    this.sessions.set(id, session);
    this.activeCredentialPaths.add(credentialPath);
    session.timeout = setTimeout(() => {
      void this.timeoutSession(session);
    }, this.sessionTimeoutMs);
    unrefTimer(session.timeout);

    try {
      const image = agent.dockerImage || AGENT_DEFAULTS[agent.type].dockerImage;
      await this.runDocker(['image', 'inspect', image]);
      const createArgs = buildAgentLoginCreateArgs(agent, descriptor, credentialPath, containerName);
      await this.runDocker(createArgs);
      this.attach(session);
    } catch (error) {
      this.appendOutput(session, `${(error as Error).message}\n`);
      this.finish(session, 'failed', undefined, 'Could not start the agent login container');
      await this.cleanupContainer(session);
    }

    return this.snapshot(session);
  }

  get(sessionId: string, owner: string): AgentLoginSessionSnapshot {
    return this.snapshot(this.requireSession(sessionId, owner));
  }

  write(sessionId: string, owner: string, input: string): AgentLoginSessionSnapshot {
    const session = this.requireSession(sessionId, owner);
    if (session.status !== 'running' || !session.process?.stdin.writable) {
      throw new AgentLoginInputError('Agent login session is not accepting input');
    }
    if (!input || input.length > MAX_INPUT_LENGTH) {
      throw new AgentLoginInputError(`Input must contain between 1 and ${MAX_INPUT_LENGTH} characters`);
    }
    session.process.stdin.write(input);
    this.touch(session);
    return this.snapshot(session);
  }

  async cancel(sessionId: string, owner: string): Promise<AgentLoginSessionSnapshot> {
    const session = this.requireSession(sessionId, owner);
    if (!isTerminal(session.status)) {
      this.finish(session, 'cancelled', undefined, 'Login cancelled');
      session.process?.kill();
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
        session.process?.kill();
      }
      await this.cleanupContainer(session);
    }));
    this.sessions.clear();
    this.activeCredentialPaths.clear();
  }

  private attach(session: AgentLoginSession): void {
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
      this.finish(
        session,
        code === 0 ? 'succeeded' : 'failed',
        code ?? undefined,
        code === 0 ? undefined : `Agent login exited with code ${code ?? 'unknown'}`,
      );
      void this.cleanupContainer(session);
    });
  }

  private async timeoutSession(session: AgentLoginSession): Promise<void> {
    if (isTerminal(session.status)) return;
    this.finish(session, 'timed_out', undefined, 'Agent login timed out');
    session.process?.kill();
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
    const next = `${session.output}${sanitizeOutput(chunk)}`;
    session.output = next.length > MAX_OUTPUT_LENGTH
      ? `[Earlier output removed]\n${next.slice(next.length - MAX_OUTPUT_LENGTH)}`
      : next;
    this.touch(session);
  }

  private touch(session: AgentLoginSession): void {
    session.updatedAt = new Date(this.now()).toISOString();
  }

  private requireSession(sessionId: string, owner: string): AgentLoginSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) throw new AgentLoginSessionNotFoundError();
    return session;
  }

  private async cleanupContainer(session: AgentLoginSession): Promise<void> {
    if (session.cleanupStarted) return;
    session.cleanupStarted = true;
    try {
      await this.runDocker(['rm', '-f', session.containerName]);
    } catch {
      // The container may already have been removed by Docker or never created.
    }
  }

  private snapshot(session: AgentLoginSession): AgentLoginSessionSnapshot {
    const {
      id,
      agentId,
      agentType,
      status,
      output,
      createdAt,
      updatedAt,
      expiresAt,
      exitCode,
      error,
    } = session;
    return {
      id,
      agentId,
      agentType,
      status,
      output,
      createdAt,
      updatedAt,
      expiresAt,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(error === undefined ? {} : { error }),
    };
  }
}

export const agentLoginSessionManager = new AgentLoginSessionManager();
