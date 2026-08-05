import logger from '../../../utils/logger.js';

// Antigravity JSONL event types
export interface AntigravityInitEvent { type: 'init'; timestamp?: string; session_id: string; model: string }
export interface AntigravityMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp?: string; delta?: boolean }
export interface AntigravityToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp?: string }
export interface AntigravityToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp?: string }
export interface AntigravityResultEvent { type: 'result'; status: 'success' | 'error'; stats?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number; duration_ms?: number; tool_calls?: number }; timestamp?: string }
export type AntigravityEvent = AntigravityInitEvent | AntigravityMessageEvent | AntigravityToolUseEvent | AntigravityToolResultEvent | AntigravityResultEvent | { type: 'error'; message: string; timestamp?: string }
export interface AntigravityTranscriptEvent { step_index?: number; source: string; type: string; status?: string; created_at?: string; content?: string }
export type AntigravityOutputEvent = AntigravityEvent | AntigravityTranscriptEvent;

export interface AntigravityParsedOutput {
    sessionId: string | undefined;
    modelUsed: string | undefined;
    summary: string | undefined;
    conversationLog: AntigravityOutputEvent[];
    tokenUsage: { input_tokens?: number; output_tokens?: number };
}

export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
    'antigravity-gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
    'antigravity-gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
    'antigravity-gemini-3.6-flash-low': 'Gemini 3.6 Flash (Low)',
    'antigravity-gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'antigravity-gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'antigravity-gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'antigravity-gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'antigravity-gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'antigravity-claude-sonnet-4.6-thinking': 'Claude Sonnet 4.6 (Thinking)',
    'antigravity-claude-opus-4.6-thinking': 'Claude Opus 4.6 (Thinking)',
    'antigravity-gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

// ANSI escape code regex for stripping terminal formatting from TUI output
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

function stripAnsiCodes(text: string): string { return text.replace(ANSI_REGEX, ''); }

function extractAntigravityResult(cleanedOutput: string): string | undefined {
    const resultLines: string[] = [];
    let inResponse = false;
    for (const line of cleanedOutput.split('\n')) {
        const t = line.trim();
        if (!inResponse && !t) continue;
        if (t.startsWith('>') || t === '/quit' || t.startsWith('Antigravity') || t.includes('Press') || t.includes('Ctrl+')) continue;
        inResponse = true;
        resultLines.push(line);
    }
    const result = resultLines.join('\n').trim();
    return result || undefined;
}

const ANTIGRAVITY_TRANSCRIPT_SOURCES = new Set(['MODEL', 'USER_EXPLICIT']);

function isTranscriptEvent(event: unknown): event is AntigravityTranscriptEvent {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const candidate = event as Partial<AntigravityTranscriptEvent>;
    return typeof candidate.source === 'string'
        && ANTIGRAVITY_TRANSCRIPT_SOURCES.has(candidate.source.trim().toUpperCase())
        && typeof candidate.type === 'string'
        && candidate.type.trim().length > 0
        && !['init', 'message', 'tool_use', 'tool_result', 'result', 'error'].includes(candidate.type.toLowerCase())
        && (Number.isInteger(candidate.step_index)
            || typeof candidate.status === 'string'
            || typeof candidate.created_at === 'string'
            || typeof candidate.content === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasProtocolStatus(candidate: Record<string, unknown>): boolean {
    return candidate.status === 'success' || candidate.status === 'error';
}

function hasProtocolTimestamp(candidate: Record<string, unknown>): boolean {
    return typeof candidate.timestamp === 'string' && candidate.timestamp.trim().length > 0;
}

const ANTIGRAVITY_EVENT_VALIDATORS: Record<string, (candidate: Record<string, unknown>, contextual: boolean) => boolean> = {
    init: candidate => typeof candidate.session_id === 'string' && typeof candidate.model === 'string',
    message: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual)
        && (candidate.role === 'user' || candidate.role === 'assistant')
        && typeof candidate.content === 'string',
    tool_use: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual)
        && typeof candidate.tool_name === 'string' && typeof candidate.tool_id === 'string' && isRecord(candidate.parameters),
    tool_result: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual)
        && typeof candidate.tool_id === 'string' && hasProtocolStatus(candidate) && typeof candidate.output === 'string',
    result: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual)
        && hasProtocolStatus(candidate) && (candidate.stats === undefined || isRecord(candidate.stats)),
    error: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && typeof candidate.message === 'string',
};

function isAntigravityEvent(event: unknown, contextual = false): event is AntigravityEvent {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    return ANTIGRAVITY_EVENT_VALIDATORS[event.type]?.(event, contextual) ?? false;
}

function isAntigravityOutputEvent(event: unknown, contextual = false): event is AntigravityOutputEvent {
    return isTranscriptEvent(event) || isAntigravityEvent(event, contextual);
}

function isAntigravityFramingEvent(event: unknown): boolean {
    if (isTranscriptEvent(event)) return true;
    if (!isRecord(event)) return false;
    if (event.type === 'init') return ANTIGRAVITY_EVENT_VALIDATORS.init(event, false);
    return (event.type === 'message' || event.type === 'error')
        && isAntigravityEvent(event, false);
}

function normalizeTokenUsage(stats: AntigravityResultEvent['stats'] | undefined): { input_tokens?: number; output_tokens?: number } {
    if (!stats) return {};
    return {
        input_tokens: stats.input_tokens ?? stats.inputTokens,
        output_tokens: stats.output_tokens ?? stats.outputTokens
    };
}

function processEvent(event: AntigravityEvent, state: { sessionId: string | undefined; modelUsed: string | undefined; tokenUsage: { input_tokens?: number; output_tokens?: number }; currentAssistantMessage: string; lastCompleteAssistantMessage: string }): void {
    if (event.type === 'init') {
        state.sessionId = (event as AntigravityInitEvent).session_id;
        state.modelUsed = (event as AntigravityInitEvent).model;
        return;
    }
    if (event.type === 'message' && (event as AntigravityMessageEvent).role === 'assistant') {
        const msgEvent = event as AntigravityMessageEvent;
        if (msgEvent.delta) { state.currentAssistantMessage += msgEvent.content; }
        else { state.lastCompleteAssistantMessage = msgEvent.content; state.currentAssistantMessage = ''; }
        return;
    }
    if (event.type === 'result') {
        const resultEvent = event as AntigravityResultEvent;
        state.tokenUsage = normalizeTokenUsage(resultEvent.stats);
    }
    if (event.type !== 'message' && state.currentAssistantMessage) {
        state.lastCompleteAssistantMessage = state.currentAssistantMessage;
        state.currentAssistantMessage = '';
    }
}

export function isAntigravityAnalysisEvent(event: AntigravityOutputEvent): boolean {
    if (isTranscriptEvent(event)) {
        return event.source.toUpperCase() === 'MODEL'
            && event.type.toUpperCase() === 'PLANNER_RESPONSE'
            && typeof event.content === 'string'
            && event.content.trim().length > 0;
    }
    return event.type === 'message'
        && (event as AntigravityMessageEvent).role === 'assistant'
        && typeof (event as AntigravityMessageEvent).content === 'string'
        && (event as AntigravityMessageEvent).content.trim().length > 0;
}

export function filterAntigravityAnalysisEvents(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
    return events.filter(isAntigravityAnalysisEvent);
}

/** Parses Antigravity output. JSONL is supported when present; otherwise plain text is used as the summary. */
export function parseAntigravityJsonl(output: string): AntigravityParsedOutput {
    const events: AntigravityOutputEvent[] = [];
    const state = { sessionId: undefined as string | undefined, modelUsed: undefined as string | undefined, tokenUsage: {} as { input_tokens?: number; output_tokens?: number }, currentAssistantMessage: '', lastCompleteAssistantMessage: '' };
    const parsedLines: Array<{ line: string; value?: unknown }> = [];
    for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
            parsedLines.push({ line, value: JSON.parse(line) as unknown });
        }
        catch {
            parsedLines.push({ line });
            logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Antigravity output');
        }
    }
    const hasProtocolContext = parsedLines.some(({ value }) => isAntigravityFramingEvent(value));
    const plainLines: string[] = [];
    for (const { line, value } of parsedLines) {
        if (!isAntigravityOutputEvent(value, hasProtocolContext)) {
            plainLines.push(line);
            continue;
        }
        events.push(value);
        if (isTranscriptEvent(value)) {
            if (value.source.toUpperCase() === 'MODEL' && typeof value.content === 'string' && value.content.trim()) {
                state.lastCompleteAssistantMessage = value.content;
            }
        } else {
            processEvent(value, state);
        }
    }
    if (state.currentAssistantMessage) state.lastCompleteAssistantMessage = state.currentAssistantMessage;
    const plainTextSummary = extractAntigravityResult(stripAnsiCodes(plainLines.join('\n')));
    return { sessionId: state.sessionId, modelUsed: state.modelUsed, summary: state.lastCompleteAssistantMessage || plainTextSummary || undefined, conversationLog: events, tokenUsage: state.tokenUsage };
}

/** Flushes pending message to result array. */
function flushPendingMessage(result: AntigravityOutputEvent[], pending: { content: string; timestamp?: string; role: 'user' | 'assistant' } | null): null {
    if (pending) result.push({ type: 'message', role: pending.role, content: pending.content, timestamp: pending.timestamp } as AntigravityMessageEvent);
    return null;
}

/** Aggregates consecutive delta messages into single messages. */
export function aggregateDeltaMessages(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
    const result: AntigravityOutputEvent[] = [];
    let pending: { content: string; timestamp?: string; role: 'user' | 'assistant' } | null = null;
    for (const event of events) {
        if (isTranscriptEvent(event)) { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        if (event.type !== 'message') { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        const msgEvent = event as AntigravityMessageEvent;
        if (msgEvent.role !== 'assistant') { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        if (msgEvent.delta) {
            if (pending && pending.role === 'assistant') { pending.content += msgEvent.content; }
            else { pending = flushPendingMessage(result, pending); pending = { content: msgEvent.content, timestamp: msgEvent.timestamp, role: 'assistant' }; }
        } else { pending = flushPendingMessage(result, pending); result.push(event); }
    }
    flushPendingMessage(result, pending);
    return result;
}

/** Converts an Antigravity event to Claude conversation format. */
export function convertEventToClaudeFormat(event: AntigravityOutputEvent): unknown {
    if (isTranscriptEvent(event)) {
        const source = event.source.toUpperCase();
        const role = source === 'MODEL' ? 'assistant' : source === 'USER_EXPLICIT' ? 'user' : 'system';
        return { type: role, timestamp: event.created_at, message: { content: [{ type: 'text', text: event.content || '' }] }, antigravity: { source: event.source, type: event.type, status: event.status, step_index: event.step_index } };
    }
    if (event.type === 'message') { const e = event as AntigravityMessageEvent; return { type: e.role === 'assistant' ? 'assistant' : 'user', timestamp: e.timestamp, message: { content: [{ type: 'text', text: e.content }] } }; }
    if (event.type === 'tool_use') { const e = event as AntigravityToolUseEvent; return { type: 'assistant', timestamp: e.timestamp, message: { content: [{ type: 'tool_use', name: e.tool_name, id: e.tool_id, input: e.parameters }] } }; }
    if (event.type === 'tool_result') { const e = event as AntigravityToolResultEvent; return { type: 'user', timestamp: e.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, content: e.output, is_error: e.status === 'error' }] } }; }
    if (event.type === 'result') { const e = event as AntigravityResultEvent; return { type: 'result', timestamp: e.timestamp, message: { usage: normalizeTokenUsage(e.stats) } }; }
    return event;
}
