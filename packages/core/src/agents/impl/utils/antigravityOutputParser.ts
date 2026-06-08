import logger from '../../../utils/logger.js';

// Antigravity JSONL event types
export interface AntigravityInitEvent { type: 'init'; timestamp: string; session_id: string; model: string }
export interface AntigravityMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp: string; delta?: boolean }
export interface AntigravityToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp: string }
export interface AntigravityToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp: string }
export interface AntigravityResultEvent { type: 'result'; status: 'success' | 'error'; stats: { total_tokens?: number; input_tokens?: number; output_tokens?: number; duration_ms?: number; tool_calls?: number }; timestamp: string }
export type AntigravityEvent = AntigravityInitEvent | AntigravityMessageEvent | AntigravityToolUseEvent | AntigravityToolResultEvent | AntigravityResultEvent | { type: 'error'; message: string; timestamp: string }
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

function isTranscriptEvent(event: unknown): event is AntigravityTranscriptEvent {
    const candidate = event as Partial<AntigravityTranscriptEvent>;
    return typeof candidate.source === 'string'
        && typeof candidate.type === 'string'
        && !['init', 'message', 'tool_use', 'tool_result', 'result', 'error'].includes(candidate.type);
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
        state.tokenUsage = { input_tokens: resultEvent.stats.input_tokens, output_tokens: resultEvent.stats.output_tokens };
    }
    if (event.type !== 'message' && state.currentAssistantMessage) {
        state.lastCompleteAssistantMessage = state.currentAssistantMessage;
        state.currentAssistantMessage = '';
    }
}

/** Parses Antigravity output. JSONL is supported when present; otherwise plain text is used as the summary. */
export function parseAntigravityJsonl(output: string): AntigravityParsedOutput {
    const events: AntigravityOutputEvent[] = [];
    const state = { sessionId: undefined as string | undefined, modelUsed: undefined as string | undefined, tokenUsage: {} as { input_tokens?: number; output_tokens?: number }, currentAssistantMessage: '', lastCompleteAssistantMessage: '' };
    let sawJsonEvent = false;
    for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line) as AntigravityOutputEvent;
            events.push(event);
            sawJsonEvent = true;
            if (isTranscriptEvent(event)) {
                if (event.source === 'MODEL' && typeof event.content === 'string' && event.content.trim()) {
                    state.lastCompleteAssistantMessage = event.content;
                }
            } else { processEvent(event as AntigravityEvent, state); }
        }
        catch { logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Antigravity output'); }
    }
    if (state.currentAssistantMessage) state.lastCompleteAssistantMessage = state.currentAssistantMessage;
    const plainTextSummary = sawJsonEvent ? undefined : extractAntigravityResult(stripAnsiCodes(output));
    return { sessionId: state.sessionId, modelUsed: state.modelUsed, summary: state.lastCompleteAssistantMessage || plainTextSummary || undefined, conversationLog: events, tokenUsage: state.tokenUsage };
}

/** Flushes pending message to result array. */
function flushPendingMessage(result: AntigravityOutputEvent[], pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null): null {
    if (pending) result.push({ type: 'message', role: pending.role, content: pending.content, timestamp: pending.timestamp } as AntigravityMessageEvent);
    return null;
}

/** Aggregates consecutive delta messages into single messages. */
export function aggregateDeltaMessages(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
    const result: AntigravityOutputEvent[] = [];
    let pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null = null;
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
        const role = event.source === 'MODEL' ? 'assistant' : event.source === 'USER_EXPLICIT' ? 'user' : 'system';
        return { type: role, timestamp: event.created_at, message: { content: [{ type: 'text', text: event.content || '' }] }, antigravity: { source: event.source, type: event.type, status: event.status, step_index: event.step_index } };
    }
    if (event.type === 'message') { const e = event as AntigravityMessageEvent; return { type: e.role === 'assistant' ? 'assistant' : 'user', timestamp: e.timestamp, message: { content: [{ type: 'text', text: e.content }] } }; }
    if (event.type === 'tool_use') { const e = event as AntigravityToolUseEvent; return { type: 'assistant', timestamp: e.timestamp, message: { content: [{ type: 'tool_use', name: e.tool_name, id: e.tool_id, input: e.parameters }] } }; }
    if (event.type === 'tool_result') { const e = event as AntigravityToolResultEvent; return { type: 'user', timestamp: e.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, content: e.output, is_error: e.status === 'error' }] } }; }
    if (event.type === 'result') { const e = event as AntigravityResultEvent; return { type: 'result', timestamp: e.timestamp, message: { usage: { input_tokens: e.stats.input_tokens, output_tokens: e.stats.output_tokens } } }; }
    return event;
}
