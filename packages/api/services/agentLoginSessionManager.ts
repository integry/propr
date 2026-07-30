import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  getAgentLoginDescriptor,
  isManagedAgentConfigPath,
  type AgentType,
} from '@propr/shared';
import type { AgentConfig } from '@propr/core';
import {
  AgentLoginInputError,
  buildAgentLoginCreateArgs,
  resolveAgentLoginConfigPath,
  resolveAgentLoginImage,
} from './agentLoginDocker.js';

export { AgentLoginInputError } from './agentLoginDocker.js';

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_RETENTION_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 128 * 1024;
const MAX_INPUT_LENGTH = 4096;

type TerminalEscapeState = 'text' | 'escape' | 'escape_intermediate' | 'csi'
  | 'control_string' | 'control_string_escape';
type EscapeSequenceState = Exclude<TerminalEscapeState, 'text'>;

export type AgentLoginSessionStatus = 'starting' | 'running' | 'succeeded'
  | 'failed' | 'cancelled' | 'timed_out';

const TERMINAL_STATUSES = new Set<AgentLoginSessionStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CONTROL_STRING_STARTS = new Set([']', 'P', 'X', '^', '_']);
const C1_CONTROL_STRING_STARTS = new Set(['\u0090', '\u0098', '\u009d', '\u009e', '\u009f']);
const CSI_FINAL_CHARACTER = /[\u0040-\u007e]/u;
const ESCAPE_INTERMEDIATE_CHARACTER = /[\u0020-\u002f]/u;
const UNSAFE_CONTROL_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1a], [0x1c, 0x1f], [0x7f, 0x9f]];

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
  escapeState: TerminalEscapeState;
  outputEndedWithCarriageReturn?: boolean;
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
  scope?: string;
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
    const timeout = args[0] === 'pull' ? 5 * 60_000 : 30_000;
    execFile('docker', args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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
  // script(1) supplies the controlling PTY while keeping Node's stdin/stdout
  // pipeable for the browser session.
  return spawn('script', ['-qefc', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
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

const ESCAPE_TRANSITIONS: Record<
  EscapeSequenceState,
  (value: string) => TerminalEscapeState
> = {
  escape: value => {
    if (value === '[') return 'csi';
    if (CONTROL_STRING_STARTS.has(value)) return 'control_string';
    return ESCAPE_INTERMEDIATE_CHARACTER.test(value) ? 'escape_intermediate' : 'text';
  },
  escape_intermediate: value => (
    ESCAPE_INTERMEDIATE_CHARACTER.test(value) ? 'escape_intermediate' : 'text'
  ),
  csi: value => CSI_FINAL_CHARACTER.test(value) ? 'text' : 'csi',
  control_string: value => {
    if (value === '\u0007' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_escape' : 'control_string';
  },
  control_string_escape: value => {
    if (value === '\\' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_escape' : 'control_string';
  },
};

function startEscapeSequence(value: string): EscapeSequenceState | undefined {
  if (value === '\u001b') return 'escape';
  if (value === '\u009b') return 'csi';
  if (C1_CONTROL_STRING_STARTS.has(value)) return 'control_string';
  return undefined;
}

function isUnsafeControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return UNSAFE_CONTROL_RANGES.some(([start, end]) => code >= start && code <= end);
}

function sanitizeTerminalChunk(session: AgentLoginSession, chunk: string): string {
  let sanitized = '';
  for (const value of chunk) {
    const state = session.escapeState;
    if (state !== 'text') {
      session.escapeState = ESCAPE_TRANSITIONS[state](value);
      continue;
    }
    const escapeState = startEscapeSequence(value);
    if (escapeState) {
      session.escapeState = escapeState;
      continue;
    }
    if (value === '\r') {
      sanitized += '\n';
      session.outputEndedWithCarriageReturn = true;
      continue;
    }
    if (value === '\n' && session.outputEndedWithCarriageReturn) {
      session.outputEndedWithCarriageReturn = false;
      continue;
    }
    session.outputEndedWithCarriageReturn = false;
    if (!isUnsafeControlCharacter(value)) sanitized += value;
  }
  return sanitized;
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

  constructor(deps: AgentLoginSessionManagerDeps = {}) {
    this.runDocker = deps.runDocker ?? defaultRunDocker;
    this.spawnDocker = deps.spawnDocker ?? defaultSpawnDocker;
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
    this.sessionTimeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionRetentionMs = deps.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    this.scope = normalizeScope(deps.scope ?? process.env.PROPR_STACK ?? 'propr');
  }

  /**
   * Remove login containers left behind by an API crash. The stack-scoped
   * label avoids interrupting an active login owned by another ProPR stack on
   * the same Docker daemon.
   */
  async cleanupOrphanedContainers(): Promise<number> {
    const { stdout } = await this.runDocker([
      'ps',
      '-aq',
      '--filter', 'label=propr.agent-login=true',
      '--filter', `label=propr.agent-login.scope=${this.scope}`,
    ]);
    const containerIds = stdout
      .split(/\s+/)
      .map(value => value.trim())
      .filter(value => /^[a-fA-F0-9]{12,64}$/.test(value));
    if (containerIds.length === 0) return 0;
    await this.runDocker(['rm', '-f', ...containerIds]);
    return containerIds.length;
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
      try {
        await this.runDocker(['image', 'inspect', image]);
      } catch {
        this.appendOutput(session, `Agent image ${image} is not available locally; pulling it now…\n`);
        try {
          await this.runDocker(['pull', image]);
        } catch (pullError) {
          throw new AgentLoginInputError(
            `Agent image "${image}" is unavailable and could not be pulled: ${(pullError as Error).message}`,
          );
        }
      }
      await this.runDocker(createArgs);
      this.attach(session);
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
