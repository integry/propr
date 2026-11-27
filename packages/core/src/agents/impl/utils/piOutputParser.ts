/**
 * Parser for `pi -p --mode json` output: a session header followed by
 * session events, one JSON object per LF-terminated line (see Pi's
 * docs/json.md). Produces the run outcome ProPR records and a Claude-shaped
 * conversation log for the persisted execution events.
 */
import type { TokenUsage } from '../../types.js';

type JsonRecord = Record<string, unknown>;

interface PiUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    cost?: { total?: number; totalFromProvider?: boolean };
}

interface PiContentBlock {
    type?: string;
    text?: string;
    thinking?: string;
    redacted?: boolean;
    id?: string;
    name?: string;
    arguments?: unknown;
}

interface PiMessage {
    role?: string;
    content?: string | PiContentBlock[];
    provider?: string;
    model?: string;
    responseModel?: string;
    responseId?: string;
    usage?: PiUsage;
    stopReason?: string;
    errorMessage?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
}

interface PiEvent {
    type?: string;
    id?: string;
    timestamp?: string;
    message?: PiMessage;
    aborted?: boolean;
    toolCallId?: string;
    toolName?: string;
    result?: { content?: PiContentBlock[] | string; isError?: boolean };
    isError?: boolean;
    success?: boolean;
    finalError?: string;
    errorMessage?: string;
}

export interface PiConversationContentItem {
    type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
}

export interface PiConversationLogEntry {
    type: 'assistant' | 'user';
    timestamp: string;
    /** Set on tool results, so the persisted event carries the failure. */
    isError?: boolean;
    message: {
        id?: string;
        role: 'assistant' | 'user';
        model?: string;
        content: PiConversationContentItem[];
        usage?: TokenUsage;
    };
}

export interface ParsedPiOutput {
    sessionId?: string;
    /** `provider/model` of the last assistant response. */
    providerModel?: string;
    /** Text of the last assistant message. */
    summary?: string;
    /** `stopReason` of the last assistant message. */
    stopReason?: string;
    /** `agent_settled.aborted`; undefined when Pi never settled. */
    aborted?: boolean;
    settled: boolean;
    error?: string;
    /** Summed over every assistant response: Pi reports usage per response. */
    tokenUsage?: TokenUsage;
    /** Provider-reported cost in USD; set only when every response carried one. */
    costUsd?: number;
    assistantMessages: number;
    conversationLog: PiConversationLogEntry[];
}

const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits on LF only: Unicode line separators inside JSON strings are not record boundaries. */
export function parsePiJsonLines(output: string): PiEvent[] {
    const events: PiEvent[] = [];
    for (const rawLine of output.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const value: unknown = JSON.parse(trimmed);
            if (isRecord(value)) events.push(value as PiEvent);
        } catch {
            // A partial or non-JSON line (diagnostics belong on stderr).
        }
    }
    return events;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function toTokenUsage(usage: PiUsage | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const result: TokenUsage = {
        input_tokens: count(usage.input),
        output_tokens: count(usage.output),
        cache_read_input_tokens: count(usage.cacheRead),
        cache_creation_input_tokens: count(usage.cacheWrite),
    };
    if (count(usage.reasoning) > 0) result.reasoning_output_tokens = count(usage.reasoning);
    return result;
}

function blockText(content: PiMessage['content'] | PiContentBlock[] | undefined): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .join('');
}

function timestampOf(message: PiMessage | undefined, fallback: string): string {
    const ms = message?.timestamp;
    return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function assistantContent(content: PiMessage['content']): PiConversationContentItem[] {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) return [];
    const items: PiConversationContentItem[] = [];
    for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) items.push({ type: 'text', text: block.text });
        else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) items.push({ type: 'thinking', thinking: block.thinking });
        else if (block.type === 'toolCall') {
            items.push({ type: 'tool_use', id: typeof block.id === 'string' ? block.id : undefined, name: typeof block.name === 'string' ? block.name : undefined, input: block.arguments ?? {} });
        }
    }
    return items;
}

function toolResultEntry(toolCallId: string, text: string, isError: boolean, timestamp: string): PiConversationLogEntry {
    return {
        type: 'user',
        timestamp,
        isError,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content: text, is_error: isError }] },
    };
}

function addUsage(total: TokenUsage, usage: TokenUsage): void {
    total.input_tokens = (total.input_tokens ?? 0) + (usage.input_tokens ?? 0);
    total.output_tokens = (total.output_tokens ?? 0) + (usage.output_tokens ?? 0);
    total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    total.cache_creation_input_tokens = (total.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (usage.reasoning_output_tokens) total.reasoning_output_tokens = (total.reasoning_output_tokens ?? 0) + usage.reasoning_output_tokens;
}

class PiOutputAccumulator {
    readonly result: ParsedPiOutput = { settled: false, assistantMessages: 0, conversationLog: [] };
    private readonly usage: TokenUsage = {};
    private cost = 0;
    private costComplete = true;
    private readonly toolResults = new Set<string>();
    private lastTimestamp = new Date(0).toISOString();
    private retryError?: string;

    add(event: PiEvent): void {
        switch (event.type) {
            case 'session':
                if (!this.result.sessionId && typeof event.id === 'string') this.result.sessionId = event.id;
                if (typeof event.timestamp === 'string') this.lastTimestamp = event.timestamp;
                return;
            case 'message_end':
                if (isRecord(event.message)) this.addMessage(event.message);
                return;
            case 'tool_execution_end':
                if (typeof event.toolCallId === 'string') {
                    const isError = event.isError === true || event.result?.isError === true;
                    this.addToolResult(event.toolCallId, blockText(event.result?.content), isError, this.lastTimestamp);
                }
                return;
            case 'agent_settled':
                this.result.settled = true;
                this.result.aborted = event.aborted === true;
                return;
            case 'auto_retry_end':
                this.retryError = event.success === false ? (event.finalError || 'Pi retries were exhausted') : undefined;
                return;
            default:
        }
    }

    private addMessage(message: PiMessage): void {
        const timestamp = timestampOf(message, this.lastTimestamp);
        this.lastTimestamp = timestamp;
        if (message.role === 'user') {
            const text = blockText(message.content);
            this.result.conversationLog.push({ type: 'user', timestamp, message: { role: 'user', content: text ? [{ type: 'text', text }] : [] } });
        } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
            this.addToolResult(message.toolCallId, blockText(message.content), message.isError === true, timestamp);
        } else if (message.role === 'assistant') {
            this.addAssistant(message, timestamp);
        }
    }

    private addAssistant(message: PiMessage, timestamp: string): void {
        this.result.assistantMessages += 1;
        const usage = toTokenUsage(message.usage);
        if (usage) addUsage(this.usage, usage);
        const cost = message.usage?.cost;
        if (cost?.totalFromProvider === true && typeof cost.total === 'number' && Number.isFinite(cost.total)) this.cost += cost.total;
        else this.costComplete = false;
        const model = message.provider && message.model ? `${message.provider}/${message.model}` : message.model;
        if (model) this.result.providerModel = model;
        this.result.stopReason = message.stopReason;
        this.result.summary = blockText(message.content).trim() || undefined;
        if (FAILED_STOP_REASONS.has(message.stopReason ?? '')) {
            this.result.error = message.errorMessage || `Pi stopped with reason "${message.stopReason}"`;
        } else {
            this.result.error = undefined;
        }
        this.result.conversationLog.push({
            type: 'assistant',
            timestamp,
            message: {
                ...(message.responseId && { id: message.responseId }),
                role: 'assistant',
                ...(model && { model }),
                content: assistantContent(message.content),
                ...(usage && { usage }),
            },
        });
    }

    /** Pi reports a call's result as a tool_execution_end and as a toolResult message; one entry per call. */
    private addToolResult(toolCallId: string, text: string, isError: boolean, timestamp: string): void {
        if (this.toolResults.has(toolCallId)) return;
        this.toolResults.add(toolCallId);
        this.result.conversationLog.push(toolResultEntry(toolCallId, text, isError, timestamp));
    }

    finish(): ParsedPiOutput {
        if (this.result.assistantMessages > 0) {
            this.result.tokenUsage = this.usage;
            if (this.costComplete) this.result.costUsd = this.cost;
        }
        if (!this.result.error && this.retryError) this.result.error = this.retryError;
        if (!this.result.error && this.result.aborted) this.result.error = 'Pi run was aborted';
        return this.result;
    }
}

export function parsePiOutput(output: string): ParsedPiOutput {
    const accumulator = new PiOutputAccumulator();
    for (const event of parsePiJsonLines(output)) accumulator.add(event);
    return accumulator.finish();
}

export function parsePiConversationLog(output: string): PiConversationLogEntry[] {
    return parsePiOutput(output).conversationLog;
}

/**
 * A Pi run succeeded when the process exited 0, Pi settled without aborting,
 * and the last assistant response did not stop on an error or abort.
 */
export function isSuccessfulPiResult(exitCode: number | null | undefined, parsed: ParsedPiOutput): boolean {
    return exitCode === 0
        && parsed.settled
        && parsed.aborted === false
        && parsed.assistantMessages > 0
        && !FAILED_STOP_REASONS.has(parsed.stopReason ?? '');
}

export function buildPiFailureMessage(result: { exitCode?: number | null; stderr?: string; timedOut?: boolean }, parsed: ParsedPiOutput): string {
    if (result.timedOut) return 'Pi execution timed out';
    if (parsed.error) return parsed.error;
    if (!parsed.settled) {
        const stderr = result.stderr?.trim();
        return stderr ? `Pi exited before settling: ${stderr.slice(-2000)}` : `Pi exited with code ${result.exitCode ?? 'unknown'} before settling`;
    }
    if (parsed.assistantMessages === 0) return 'Pi produced no assistant response';
    return `Pi exited with code ${result.exitCode ?? 'unknown'}`;
}
