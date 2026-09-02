import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type {
    CodexAppServerMethod,
    CodexAppServerNotification,
    CodexAppServerRequestMap,
    CodexAppServerServerRequest,
    CodexInitializeParams,
    CodexRequestId,
} from './codexAppServerProtocol.js';

type MessageListener = (message: unknown) => void;

export interface CodexAppServerTransport {
    send(message: unknown): Promise<void>;
    onMessage(listener: MessageListener): () => void;
    onClose?(listener: (error?: Error) => void): () => void;
    close(): Promise<void>;
}

export class CodexAppServerRpcError extends Error {
    constructor(message: string, readonly code?: number, readonly data?: unknown) {
        super(message);
        this.name = 'CodexAppServerRpcError';
    }
}

/** Newline-delimited stdio transport used by `codex app-server`. */
export class CodexAppServerStdioTransport implements CodexAppServerTransport {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly listeners = new Set<MessageListener>();
    private readonly closeListeners = new Set<(error?: Error) => void>();
    private readonly lines: readline.Interface;
    private closed = false;

    constructor(options: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
        this.child = spawn(options.command ?? 'codex', options.args ?? ['app-server', '--enable', 'goals'], {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.lines = readline.createInterface({ input: this.child.stdout });
        // App-server diagnostics are not protocol events; drain them so a full
        // stderr pipe cannot stall the JSONL transport.
        this.child.stderr.resume();
        this.child.once('error', error => this.signalClosed(error));
        this.child.once('close', code => this.signalClosed(
            this.closed || code === 0 ? undefined : new Error(`Codex app-server exited with code ${code ?? 'unknown'}`),
        ));
        this.lines.on('line', line => {
            try {
                const message: unknown = JSON.parse(line);
                for (const listener of this.listeners) listener(message);
            } catch { /* App-server stdout is protocol-only; malformed output is ignored and cannot become an event. */ }
        });
    }

    async send(message: unknown): Promise<void> {
        if (this.closed || !this.child.stdin.writable) throw new Error('Codex app-server transport is closed');
        await new Promise<void>((resolve, reject) => {
            this.child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
        });
    }

    onMessage(listener: MessageListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.lines.close();
        this.child.stdin.end();
        if (this.child.exitCode !== null) return;
        await Promise.race([
            new Promise<void>(resolve => this.child.once('close', () => resolve())),
            new Promise<void>(resolve => setTimeout(() => {
                this.child.kill('SIGTERM');
                resolve();
            }, 2_000)),
        ]);
    }

    private signalClosed(error?: Error): void {
        for (const listener of this.closeListeners) listener(error);
        this.closeListeners.clear();
    }
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: unknown): void;
}

export class CodexAppServerClient {
    private nextRequestId = 1;
    private readonly pending = new Map<CodexRequestId, PendingRequest>();
    private readonly notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
    private readonly serverRequestListeners = new Set<(request: CodexAppServerServerRequest) => void>();
    private readonly unsubscribe: () => void;
    private readonly unsubscribeClose: () => void;
    private initialized = false;

    constructor(private readonly transport: CodexAppServerTransport) {
        this.unsubscribe = transport.onMessage(message => this.receive(message));
        this.unsubscribeClose = transport.onClose?.(error => this.failPending(
            error ?? new Error('Codex app-server transport closed'),
        )) ?? (() => undefined);
    }

    async initialize(clientVersion = '0.8.15'): Promise<void> {
        if (this.initialized) return;
        const params: CodexInitializeParams = {
            clientInfo: { name: 'propr', title: 'ProPR native goal runtime', version: clientVersion },
            capabilities: { experimentalApi: true, requestAttestation: false },
        };
        await this.rawRequest('initialize', params);
        await this.transport.send({ method: 'initialized' });
        this.initialized = true;
    }

    request<M extends CodexAppServerMethod>(
        method: M,
        params: CodexAppServerRequestMap[M]['params'],
    ): Promise<CodexAppServerRequestMap[M]['result']> {
        if (!this.initialized) return Promise.reject(new Error('Codex app-server client is not initialized'));
        return this.rawRequest(method, params) as Promise<CodexAppServerRequestMap[M]['result']>;
    }

    onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
    }

    onServerRequest(listener: (request: CodexAppServerServerRequest) => void): () => void {
        this.serverRequestListeners.add(listener);
        return () => this.serverRequestListeners.delete(listener);
    }

    async respond(id: CodexRequestId, result: unknown): Promise<void> {
        await this.transport.send({ id, result });
    }

    async close(): Promise<void> {
        this.unsubscribe();
        this.unsubscribeClose();
        this.failPending(new Error('Codex app-server client closed'));
        await this.transport.close();
    }

    private rawRequest(method: string, params: unknown): Promise<unknown> {
        const id = this.nextRequestId++;
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
        const message = value as { id?: CodexRequestId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
        if (message.id !== undefined && !message.method) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new CodexAppServerRpcError(message.error.message ?? 'Codex app-server error', message.error.code, message.error.data));
            else pending.resolve(message.result);
            return;
        }
        if (!message.method) return;
        if (message.id !== undefined) {
            const request = { method: message.method, id: message.id, params: message.params };
            for (const listener of this.serverRequestListeners) listener(request);
            return;
        }
        const notification = { method: message.method, params: message.params };
        for (const listener of this.notificationListeners) listener(notification);
    }

    private failPending(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}
