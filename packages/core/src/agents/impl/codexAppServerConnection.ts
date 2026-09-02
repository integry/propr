import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import type { AgentExecutionResult, TokenUsage } from '../types.js';
import {
    boundedProviderDiagnostic,
    boundedProviderOutput,
    MAX_PROVIDER_OUTPUT_BYTES,
} from './utils/boundedProviderOutput.js';

const MAX_LIVE_OUTPUT_BYTES = MAX_PROVIDER_OUTPUT_BYTES;
const MAX_SUMMARY_PARTS = 100;
const APPEND_BOUNDED_OUTPUT_SCRIPT = `
local combined = (redis.call('get', KEYS[1]) or '') .. ARGV[1]
local maximum = tonumber(ARGV[2])
if string.len(combined) > maximum then
    combined = string.sub(combined, string.len(combined) - maximum + 1)
    local boundary = string.find(combined, '\\n')
    if boundary then combined = string.sub(combined, boundary + 1) end
end
redis.call('setex', KEYS[1], tonumber(ARGV[3]), combined)
return string.len(combined)
`;

export function boundedCodexJsonlTail(value: string, maximum = MAX_LIVE_OUTPUT_BYTES): string {
    return boundedProviderOutput(value, maximum);
}

interface RpcError { code?: number; message?: string }
export interface RpcMessage {
    id?: number;
    method?: string;
    result?: Record<string, unknown>;
    error?: RpcError;
    params?: Record<string, unknown>;
}

interface PendingRequest {
    method: string;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function extractTokenUsage(params: Record<string, unknown>): TokenUsage | undefined {
    const usage = asRecord(params.tokenUsage ?? params.usage ?? params.total);
    const total = asRecord(usage.total ?? usage);
    const input = Number(total.inputTokens ?? total.input_tokens ?? 0);
    const output = Number(total.outputTokens ?? total.output_tokens ?? 0);
    const cached = Number(total.cachedInputTokens ?? total.cache_read_input_tokens ?? 0);
    if (!input && !output && !cached) return undefined;
    return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached };
}

export class AppServerConnection {
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private turnWaiters = new Map<string, (message: RpcMessage) => void>();
    private completedTurns = new Map<string, RpcMessage>();
    private startedTurns: Array<{ threadId: string; turnId: string }> = [];
    private redis: Redis;
    private output = '';
    private stderr = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingOutput = '';
    private flushPromise: Promise<void> = Promise.resolve();
    private closedError: Error | null = null;
    summaryParts: string[] = [];
    tokenUsage?: TokenUsage;
    effectiveModel?: string;

    constructor(
        private child: ReturnType<typeof spawn>,
        private taskId: string | undefined,
        private persistOutput?: (records: string[]) => Promise<void>,
    ) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
        child.stderr?.on('data', chunk => {
            this.stderr = boundedProviderDiagnostic(this.stderr + chunk.toString());
        });
        const lines = readline.createInterface({ input: child.stdout! });
        lines.on('line', line => this.onLine(line));
        child.once('close', code => this.closePending(new Error(`Codex App Server exited before the active turn completed (exit ${code ?? 'unknown'})`)));
        child.once('error', error => this.closePending(error));
    }

    get rawOutput(): string { return this.output; }
    get conversationLog(): AgentExecutionResult['conversationLog'] {
        return this.output.split('\n').flatMap(line => {
            try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        }) as AgentExecutionResult['conversationLog'];
    }
    get stderrOutput(): string { return this.stderr; }
    get closeError(): Error | null { return this.closedError; }

    private onLine(line: string): void {
        this.appendOutput(`${line}\n`);
        this.scheduleFlush();
        let message: RpcMessage;
        try { message = JSON.parse(line) as RpcMessage; } catch { return; }
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id)!;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`Codex ${message.error.message || 'request failed'} (${message.error.code ?? 'unknown'})`));
            else {
                this.appendGoalSnapshot(pending.method, message.result ?? {});
                pending.resolve(message.result ?? {});
            }
            return;
        }
        this.observeNotification(message);
    }

    private observeNotification(message: RpcMessage): void {
        const params = message.params ?? {};
        if (message.method === 'turn/started') {
            const turn = asRecord(params.turn);
            if (typeof params.threadId === 'string' && typeof turn.id === 'string') {
                this.startedTurns.push({ threadId: params.threadId, turnId: turn.id });
            }
        }
        if (message.method === 'turn/completed') {
            const turn = asRecord(params.turn);
            if (typeof turn.model === 'string') this.effectiveModel = turn.model;
            if (typeof turn.id === 'string') {
                const waiter = this.turnWaiters.get(turn.id);
                if (waiter) {
                    this.turnWaiters.delete(turn.id);
                    waiter(message);
                } else {
                    this.completedTurns.set(turn.id, message);
                }
            }
        }
        if (message.method === 'item/completed') {
            const item = asRecord(params.item);
            if (typeof item.model === 'string') this.effectiveModel = item.model;
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
                this.summaryParts.push(item.text);
                if (this.summaryParts.length > MAX_SUMMARY_PARTS) this.summaryParts.shift();
            }
        }
        if (message.method === 'thread/tokenUsage/updated') this.tokenUsage = extractTokenUsage(params) ?? this.tokenUsage;
        if (message.method === 'model/rerouted' && typeof params.toModel === 'string') this.effectiveModel = params.toModel;
    }

    private appendGoalSnapshot(method: string, result: Record<string, unknown>): void {
        if (!['thread/goal/set', 'thread/goal/get'].includes(method) || !result.goal) return;
        const line = JSON.stringify({ method: 'thread/goal/updated', params: { goal: result.goal }, source: 'rpc_snapshot' });
        this.appendOutput(`${line}\n`);
        this.scheduleFlush();
    }

    private boundedTail(value: string): string {
        return boundedCodexJsonlTail(value);
    }

    private appendOutput(value: string): void {
        this.output = this.boundedTail(this.output + value);
        this.pendingOutput = this.boundedTail(this.pendingOutput + value);
    }

    private flushOutput(): Promise<void> {
        if (!this.taskId || !this.pendingOutput) return this.flushPromise;
        const chunk = this.pendingOutput;
        this.pendingOutput = '';
        this.flushPromise = this.flushPromise.then(async () => {
            await Promise.all([
                this.redis.eval(
                    APPEND_BOUNDED_OUTPUT_SCRIPT,
                    1,
                    `agent:output:${this.taskId}`,
                    chunk,
                    String(MAX_LIVE_OUTPUT_BYTES),
                    '3600',
                ),
                this.persistOutput?.(chunk.split('\n').filter(Boolean)),
            ]);
        }).catch(error => {
            logger.debug({ error: (error as Error).message }, 'Failed to persist Codex App Server output');
        });
        return this.flushPromise;
    }

    private scheduleFlush(): void {
        if (!this.taskId || this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushOutput();
        }, 200);
    }

    private closePending(error: Error): void {
        this.closedError = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        for (const resolve of this.turnWaiters.values()) resolve({ error: { message: error.message } });
        this.turnWaiters.clear();
    }

    notify(method: string, params: Record<string, unknown> = {}): void {
        if (!this.child.stdin?.writable) throw this.closedError ?? new Error('Codex App Server stdin is closed');
        this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }

    request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
        if (!this.child.stdin?.writable) return Promise.reject(this.closedError ?? new Error('Codex App Server stdin is closed'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex App Server ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            this.child.stdin!.write(`${JSON.stringify({ method, id, params })}\n`);
        });
    }

    waitForTurn(turnId: string): Promise<RpcMessage> {
        if (this.closedError) return Promise.reject(this.closedError);
        const completed = this.completedTurns.get(turnId);
        if (completed) {
            this.completedTurns.delete(turnId);
            return Promise.resolve(completed);
        }
        return new Promise(resolve => this.turnWaiters.set(turnId, resolve));
    }

    takeStartedTurn(threadId: string): string | null {
        const index = this.startedTurns.findIndex(turn => turn.threadId === threadId);
        if (index < 0) return null;
        return this.startedTurns.splice(index, 1)[0].turnId;
    }

    discardStartedTurn(turnId: string): void {
        this.startedTurns = this.startedTurns.filter(turn => turn.turnId !== turnId);
    }

    async close(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        await this.flushOutput();
        await this.redis.quit().catch(() => undefined);
        this.child.stdin?.end();
        const force = setTimeout(() => this.child.kill('SIGTERM'), 500);
        await new Promise<void>(resolve => {
            if (this.child.exitCode !== null) resolve();
            else this.child.once('close', () => resolve());
        });
        clearTimeout(force);
    }
}
