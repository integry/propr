import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type {
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
} from './codexAppServerGoalBindings.generated.js';

export interface CodexNotification { method: string; params?: Record<string, unknown> }
export type CodexRequestId = string | number;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RequestMap {
  'thread/start': {
    params: { model?: string; cwd: string; runtimeWorkspaceRoots: string[]; approvalPolicy: 'never'; sandbox: 'danger-full-access'; ephemeral: false; historyMode: 'paginated' };
    result: { thread: { id: string }; model: string; reasoningEffort: string | null };
  };
  'thread/resume': {
    params: { threadId: string; cwd: string; runtimeWorkspaceRoots: string[]; excludeTurns: true };
    result: { thread: { id: string }; model: string; reasoningEffort: string | null };
  };
  'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse };
  'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse };
  'thread/goal/clear': { params: ThreadGoalClearParams; result: ThreadGoalClearResponse };
  'thread/settings/update': {
    params: { threadId: string; model?: string; effort?: string };
    result: Record<string, never>;
  };
  'turn/start': {
    params: { threadId: string; clientUserMessageId: string; input: Array<{ type: 'text'; text: string; text_elements: [] }> };
    result: { turn: { id: string } };
  };
  'turn/steer': {
    params: { threadId: string; expectedTurnId: string; clientUserMessageId: string; input: Array<{ type: 'text'; text: string; text_elements: [] }> };
    result: { turnId: string };
  };
  'turn/interrupt': { params: { threadId: string; turnId: string }; result: Record<string, never> };
}

interface Transport {
  send(value: unknown): Promise<void>;
  onMessage(listener: (value: unknown) => void): () => void;
  close(): Promise<void>;
}

export class CodexAppServerStdioTransport implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(value: unknown) => void>();
  private readonly lines: readline.Interface;

  constructor(containerId: string) {
    this.child = spawn('docker', [
      'exec', '-i', '--user', '1000:1000', '-e', 'HOME=/home/node',
      '-w', '/home/node/workspace', containerId, 'codex', 'app-server', '--enable', 'goals',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try {
        const value: unknown = JSON.parse(line);
        for (const listener of this.listeners) listener(value);
      } catch { /* protocol stdout is JSONL; ignore non-protocol diagnostics */ }
    });
  }

  send(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
    });
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await Promise.race([
      new Promise<void>(resolve => this.child.once('close', () => resolve())),
      new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.child.kill('SIGTERM'); resolve(); }, 2_000);
        timer.unref?.();
      }),
    ]);
  }
}

export class CodexAppServerClient {
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<CodexRequestId, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly listeners = new Set<(value: CodexNotification) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly transport: Transport) {
    this.unsubscribe = transport.onMessage(value => this.receive(value));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rawRequest('initialize', {
      clientInfo: { name: 'propr', title: 'ProPR native goal runtime', version: '0.8.15' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.transport.send({ method: 'initialized' });
    this.initialized = true;
  }

  request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    if (!this.initialized) return Promise.reject(new Error('Codex App Server client is not initialized'));
    return this.rawRequest(method, params) as Promise<RequestMap[M]['result']>;
  }

  onNotification(listener: (value: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const request of this.pending.values()) request.reject(new Error('Codex App Server closed'));
    this.pending.clear();
    await this.transport.close();
  }

  private rawRequest(method: string, params: Json | Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport.send({ method, id, params }).catch(error => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { id?: CodexRequestId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex App Server error'));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners) listener({ method: message.method, params: message.params });
  }
}
