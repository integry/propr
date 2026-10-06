import type { Writable } from 'node:stream';
import logger from '../../utils/logger.js';
import {
    DEFAULT_POLL_INTERVAL_MS,
    type LiveInputChannel,
    type LiveInputContext,
    type LiveInputMessage,
    type LiveInputSession,
    type LiveInputSource,
} from '../../claude/docker/dockerLiveInput.js';
import { asRecord, type RpcMessage } from './codexAppServerConnection.js';

/**
 * An ordinary Codex task run served by Codex App Server, the protocol native
 * goals use, so operator input steers the active turn (`turn/steer`) live.
 *
 * The session drives the JSON-RPC handshake on the container's stdio and
 * translates App Server notifications into the `codex exec --json` records
 * the rest of a task run reads (result parsing, live log, usage, watchdog).
 * Stdin is closed once the task's single turn completes, which ends the
 * App Server.
 */
export interface CodexAppServerTaskOptions {
    prompt: string;
    model?: string;
    /** Operator steering for the run; without it the turn is never steered. */
    source?: LiveInputSource;
    pollIntervalMs?: number;
}

interface PendingRequest {
    onResult(result: Record<string, unknown>): void;
    onError(message: string): void;
}

interface CodexUsage {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function joinedText(value: unknown): string {
    return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join('\n') : '';
}

function fileChangeKind(kind: unknown): string {
    if (typeof kind === 'string') return kind;
    return text(asRecord(kind).type) ?? 'update';
}

/** One App Server thread item as the `codex exec --json` item it corresponds to, or null when exec reports none. */
export function toCodexExecItem(item: Record<string, unknown>): Record<string, unknown> | null {
    const id = text(item.id);
    const status = text(item.status);
    switch (item.type) {
        case 'agentMessage':
            return { id, type: 'agent_message', text: text(item.text) ?? '' };
        case 'reasoning':
            return { id, type: 'reasoning', text: joinedText(item.summary) || joinedText(item.content) };
        case 'commandExecution':
            return {
                id, type: 'command_execution', command: text(item.command) ?? '',
                aggregated_output: text(item.aggregatedOutput) ?? '',
                ...(typeof item.exitCode === 'number' ? { exit_code: item.exitCode } : {}),
                ...(status ? { status } : {}),
            };
        case 'fileChange':
            return {
                id, type: 'file_change', ...(status ? { status } : {}),
                changes: (Array.isArray(item.changes) ? item.changes : []).map(change => {
                    const record = asRecord(change);
                    return { path: text(record.path) ?? '', kind: fileChangeKind(record.kind) };
                }),
            };
        case 'mcpToolCall':
            return { id, type: 'mcp_tool_call', server: text(item.server), tool: text(item.tool), ...(status ? { status } : {}) };
        case 'webSearch':
            return { id, type: 'web_search', query: text(item.query) ?? '' };
        default:
            return null;
    }
}

function usageOf(params: Record<string, unknown>): CodexUsage | null {
    const usage = asRecord(params.tokenUsage);
    const total = asRecord(usage.total ?? usage);
    const value = (key: string, alternate: string): number => {
        const number = Number(total[key] ?? total[alternate] ?? 0);
        return Number.isFinite(number) && number > 0 ? number : 0;
    };
    const result = {
        input_tokens: value('inputTokens', 'input_tokens'),
        cached_input_tokens: value('cachedInputTokens', 'cached_input_tokens'),
        output_tokens: value('outputTokens', 'output_tokens'),
        reasoning_output_tokens: value('reasoningOutputTokens', 'reasoning_output_tokens'),
    };
    return Object.values(result).some(Boolean) ? result : null;
}

const record = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

/** Progress notifications as the `codex exec --json` records reporting the same progress ('' for none). */
function translateProgress(message: RpcMessage): string {
    const params = message.params ?? {};
    switch (message.method) {
        case 'item/started':
        case 'item/completed': {
            const item = toCodexExecItem(asRecord(params.item));
            return item ? record({ type: message.method === 'item/started' ? 'item.started' : 'item.completed', item }) : '';
        }
        case 'turn/plan/updated': {
            const items = (Array.isArray(params.plan) ? params.plan : []).map(step => {
                const entry = asRecord(step);
                return { text: text(entry.step) ?? '', completed: entry.status === 'completed' };
            });
            return record({ type: 'item.updated', item: { type: 'todo_list', items } });
        }
        case 'error': {
            const detail = text(asRecord(params.error).message) ?? 'Codex App Server error';
            // Retried transport errors are progress, as in `codex exec`.
            return record({ type: 'error', message: params.willRetry === true ? `Reconnecting... ${detail}` : detail });
        }
        default:
            return '';
    }
}

export class CodexAppServerTaskSession implements LiveInputSession {
    private turnStatus: string | null = null;

    constructor(private readonly options: CodexAppServerTaskOptions) {}

    /** Whether the task's turn completed successfully (set once the App Server reported it). */
    get completed(): boolean {
        return this.turnStatus === 'completed';
    }

    start(stdin: Writable | null | undefined, context: LiveInputContext): LiveInputChannel {
        const { options } = this;
        const pending = new Map<number, PendingRequest>();
        const acknowledgements = new Set<Promise<void>>();
        let nextId = 1;
        let closed = false;
        let threadId: string | null = null;
        let turnId: string | null = null;
        let turnEnded = false;
        let usage: CodexUsage | null = null;
        let lineBuffer = '';
        // Records produced outside of a translated line (request failures).
        let emitted = '';
        let polling: Promise<void> = Promise.resolve();
        let timer: ReturnType<typeof setInterval> | undefined;

        const writable = (): boolean => !closed && !!stdin?.writable && !stdin.writableEnded;
        const close = (): void => {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            if (closed) return;
            closed = true;
            try { stdin?.end(); } catch { /* the process already closed its input */ }
        };
        // The run already reports why its turn never ran, so it ends here.
        const fail = (message: string): void => {
            turnEnded = true;
            emitted += record({ type: 'error', message });
            close();
        };
        const request = (method: string, params: Record<string, unknown>, handler: PendingRequest): boolean => {
            if (!writable()) return false;
            const id = nextId++;
            pending.set(id, handler);
            stdin!.write(record({ method, id, params }));
            return true;
        };
        const settle = (promise: Promise<void>): void => {
            acknowledgements.add(promise);
            void promise.finally(() => acknowledgements.delete(promise));
        };
        const release = (messages: LiveInputMessage[]): void => {
            if (!messages.length || !options.source) return;
            settle(options.source.release(messages.map(message => message.id)).catch(error => {
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to release operator input Codex did not accept');
            }));
        };

        stdin?.on('error', error => {
            logger.warn({ taskId: context.taskId, error: error.message }, 'Codex App Server input closed with an error');
            close();
        });

        const startTurn = (result: Record<string, unknown>): void => {
            const thread = asRecord(result.thread);
            if (typeof thread.id !== 'string') return fail('Codex App Server did not return thread.id');
            threadId = thread.id;
            const model = text(thread.model) ?? text(result.model);
            request('turn/start', {
                threadId,
                input: [{ type: 'text', text: options.prompt, text_elements: [] }],
            }, {
                onResult: started => {
                    turnId ??= text(asRecord(started.turn).id) ?? null;
                    // `codex exec --json` reports its thread first; the session id comes from it.
                    emitted += record({ type: 'thread.started', thread_id: thread.id, ...(model ? { model } : {}) });
                },
                onError: message => fail(`Codex App Server could not start the task turn: ${message}`),
            });
        };

        request('initialize', { clientInfo: { name: 'propr', title: 'ProPR', version: '1' } }, {
            onResult: () => {
                if (!writable()) return;
                stdin!.write(record({ method: 'initialized', params: {} }));
                request('thread/start', {
                    ...(options.model ? { model: options.model } : {}),
                    cwd: '/home/node/workspace', approvalPolicy: 'never', sandbox: 'danger-full-access',
                    serviceName: 'propr', ephemeral: true,
                }, {
                    onResult: startTurn,
                    onError: message => fail(`Codex App Server could not start the task thread: ${message}`),
                });
            },
            onError: message => fail(`Codex App Server failed to initialize: ${message}`),
        });

        const steer = async (): Promise<void> => {
            // Claim only while the active turn can still take input: a claimed
            // message is settled, so claiming after the turn ended would lose it.
            if (!options.source || !writable() || !threadId || !turnId || turnEnded) return;
            let messages: LiveInputMessage[];
            try {
                messages = await options.source.claim();
            } catch (error) {
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to load operator input for running agent');
                return;
            }
            const unsent: LiveInputMessage[] = [];
            for (const message of messages) {
                const sent = !turnEnded && request('turn/steer', {
                    threadId,
                    clientUserMessageId: message.id,
                    input: [{ type: 'text', text: message.text, text_elements: [] }],
                    expectedTurnId: turnId,
                }, {
                    // Only the App Server's acceptance proves the turn received the input.
                    onResult: () => settle(options.source!.acknowledge(message.id).catch(error => {
                        logger.warn({ taskId: context.taskId, steerId: message.id, error: (error as Error).message }, 'Failed to acknowledge operator input');
                    })),
                    // A rejected steer reached no agent, so releasing it cannot duplicate input.
                    onError: error => {
                        logger.warn({ taskId: context.taskId, steerId: message.id, error }, 'Codex App Server rejected operator input');
                        release([message]);
                    },
                });
                if (sent) context.onDelivered?.(message);
                else unsent.push(message);
            }
            release(unsent);
        };
        if (options.source) {
            timer = setInterval(() => {
                // Never overlap claims: each poll waits for the previous one.
                polling = polling.then(steer);
            }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
            timer.unref?.();
        }

        const respondUnsupported = (message: RpcMessage): void => {
            // Task runs never approve or answer provider prompts, as `codex exec` does not.
            if (!writable()) return;
            stdin!.write(record({ id: message.id, error: { code: -32601, message: 'ProPR task runs do not answer provider requests' } }));
        };

        const endTurn = (status: string, error?: string): string => {
            turnEnded = true;
            this.turnStatus = status;
            close();
            if (status === 'completed') return record({ type: 'turn.completed', ...(usage ? { usage } : {}) });
            return record({ type: 'error', message: error || `Codex turn ${status}` })
                + record({ type: 'turn.failed', error: { message: error || `Codex turn ${status}` }, ...(usage ? { usage } : {}) });
        };

        const translateNotification = (message: RpcMessage): string => {
            const params = message.params ?? {};
            switch (message.method) {
                case 'turn/started': {
                    turnId ??= text(asRecord(params.turn).id) ?? null;
                    return record({ type: 'turn.started' });
                }
                case 'thread/tokenUsage/updated':
                    usage = usageOf(params) ?? usage;
                    return '';
                case 'turn/completed': {
                    const turn = asRecord(params.turn);
                    if (turnId && text(turn.id) && turn.id !== turnId) return '';
                    return endTurn(text(turn.status) ?? 'failed', text(asRecord(turn.error).message));
                }
                default:
                    return translateProgress(message);
            }
        };

        const translateLine = (line: string): string => {
            let message: RpcMessage;
            try { message = JSON.parse(line) as RpcMessage; } catch { return line.trim() ? `${line}\n` : ''; }
            if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
                respondUnsupported(message);
                return '';
            }
            if (typeof message.id === 'number' && pending.has(message.id)) {
                const handler = pending.get(message.id)!;
                pending.delete(message.id);
                if (message.error) handler.onError(message.error.message || 'request failed');
                else handler.onResult(message.result ?? {});
                return '';
            }
            return translateNotification(message);
        };

        return {
            observeLine: () => undefined,
            // The App Server answers its handshake before the prompt is sent:
            // only a started turn shows the agent received it.
            promptReceived: () => turnId !== null,
            translateOutput: (chunk, flush) => {
                lineBuffer += chunk;
                const lines = lineBuffer.split('\n');
                lineBuffer = flush ? '' : lines.pop() ?? '';
                let output = '';
                for (const line of lines) {
                    output += emitted;
                    emitted = '';
                    output += translateLine(line);
                }
                output += emitted;
                emitted = '';
                if (flush && !turnEnded) {
                    turnEnded = true;
                    output += record({ type: 'error', message: 'Codex App Server exited before the task turn completed' });
                }
                return output;
            },
            close,
            settled: async () => {
                await polling;
                await Promise.allSettled([...acknowledgements]);
            },
        };
    }
}
