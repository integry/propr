import type { TokenUsage } from '../../types.js';
import logger from '../../../utils/logger.js';
import { ANTIGRAVITY_MODEL_LABELS, toAntigravityCliModelId } from '../antigravityModelIds.js';

export { ANTIGRAVITY_MODEL_LABELS };

// Legacy Antigravity JSONL event types.
export interface AntigravityInitEvent { type: 'init'; timestamp?: string; session_id: string; model: string }
export interface AntigravityMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp?: string; delta?: boolean }
export interface AntigravityToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp?: string }
export interface AntigravityToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp?: string }
export interface AntigravityResultEvent { type: 'result'; status: 'success' | 'error'; stats?: AntigravityLegacyUsage; timestamp?: string }
export type AntigravityEvent = AntigravityInitEvent | AntigravityMessageEvent | AntigravityToolUseEvent | AntigravityToolResultEvent | AntigravityResultEvent | { type: 'error'; message: string; timestamp?: string };

export interface AntigravityLegacyUsage {
    total_tokens?: number; input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number;
    duration_ms?: number; tool_calls?: number;
}

// Antigravity CLI 1.1.12+ --output-format stream-json envelope types.
export interface AntigravityStreamUsage {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
}
export interface AntigravityStreamInitEvent {
    event: 'init';
    conversation_id: string;
    init: { model: string; cwd?: string; tools?: unknown[] };
}
export interface AntigravityStreamStepUpdateEvent {
    event: 'step_update';
    step_update: {
        conversation_id: string;
        step_index: number;
        state: string;
        step_type: string;
        text_delta?: string;
        usage?: AntigravityStreamUsage;
    };
}
export interface AntigravityStreamResultEvent {
    event: 'result';
    result: {
        conversation_id: string;
        status: 'SUCCESS' | 'ERROR' | 'success' | 'error';
        response?: string;
        duration_seconds?: number;
        num_turns?: number;
        usage?: AntigravityStreamUsage;
    };
}
export type AntigravityStreamEvent = AntigravityStreamInitEvent | AntigravityStreamStepUpdateEvent | AntigravityStreamResultEvent;

export interface AntigravityTranscriptEvent { step_index?: number; source: string; type: string; status?: string; created_at?: string; content?: string }
export type AntigravityOutputEvent = AntigravityEvent | AntigravityStreamEvent | AntigravityTranscriptEvent;
export type AntigravityTerminalStatus = 'success' | 'error';

export interface AntigravityParsedOutput {
    sessionId: string | undefined;
    conversationId: string | undefined;
    modelUsed: string | undefined;
    summary: string | undefined;
    conversationLog: AntigravityOutputEvent[];
    tokenUsage: TokenUsage;
    terminalStatus: AntigravityTerminalStatus | undefined;
    protocolError: string | undefined;
    hasStreamEnvelopes: boolean;
}

const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');
const ANTIGRAVITY_TRANSCRIPT_SOURCES = new Set(['MODEL', 'USER_EXPLICIT']);
const LEGACY_EVENT_TYPES = ['init', 'message', 'tool_use', 'tool_result', 'result', 'error'];
const LEGACY_RESULT_STAT_KEYS = ['total_tokens', 'input_tokens', 'output_tokens', 'inputTokens', 'outputTokens', 'duration_ms', 'tool_calls'] as const;
const STREAM_USAGE_KEYS = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'] as const;

function stripAnsiCodes(text: string): string { return text.replace(ANSI_REGEX, ''); }
function normalizeTranscriptIdentifier(value: string): string { return value.trim().toUpperCase(); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isFiniteNonNegativeNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

/** Converts CLI canonical IDs and display names back to ProPR's namespaced model ID. */
export function normalizeAntigravityModelId(modelId: string): string { const unscoped = modelId.startsWith('antigravity:') ? modelId.slice('antigravity:'.length) : modelId; return Object.entries(ANTIGRAVITY_MODEL_LABELS).find(([proprId, displayName]) => unscoped === proprId || unscoped === displayName || unscoped === toAntigravityCliModelId(proprId))?.[0] ?? unscoped; }

function extractAntigravityResult(lines: Array<{ line: string; isJson: boolean }>): string | undefined {
    const resultLines: string[] = [];
    let inResponse = false;
    for (const { line: rawLine, isJson } of lines) {
        const line = stripAnsiCodes(rawLine);
        const trimmed = line.trim();
        if (!inResponse && !trimmed) continue;
        if (trimmed.startsWith('>') || trimmed === '/quit' || trimmed.startsWith('Antigravity') || (!isJson && (trimmed.includes('Press') || trimmed.includes('Ctrl+')))) continue;
        inResponse = true;
        resultLines.push(line);
    }
    const result = resultLines.join('\n').trim();
    return result || undefined;
}
function extractLegacyFallback(lines: Array<{ line: string; isJson: boolean }>, hasStreamEnvelopes: boolean): string | undefined { return hasStreamEnvelopes ? undefined : extractAntigravityResult(lines); }

function isTranscriptEvent(event: unknown): event is AntigravityTranscriptEvent {
    if (!isRecord(event)) return false;
    return typeof event.source === 'string'
        && ANTIGRAVITY_TRANSCRIPT_SOURCES.has(normalizeTranscriptIdentifier(event.source))
        && typeof event.type === 'string'
        && event.type.trim().length > 0
        && !LEGACY_EVENT_TYPES.includes(event.type.trim().toLowerCase())
        && (event.step_index === undefined || Number.isInteger(event.step_index))
        && (event.status === undefined || typeof event.status === 'string')
        && (event.created_at === undefined || typeof event.created_at === 'string')
        && (event.content === undefined || typeof event.content === 'string')
        && ['step_index', 'status', 'created_at', 'content'].some(key => event[key] !== undefined);
}

function hasProtocolStatus(candidate: Record<string, unknown>): boolean { return candidate.status === 'success' || candidate.status === 'error'; }
function hasProtocolTimestamp(candidate: Record<string, unknown>): boolean { return typeof candidate.timestamp === 'string' && candidate.timestamp.trim().length > 0; }
function hasValidOptionalTimestamp(candidate: Record<string, unknown>): boolean { return candidate.timestamp === undefined || typeof candidate.timestamp === 'string'; }

function hasValidUsage(usage: unknown, keys: readonly string[]): boolean {
    return usage === undefined || (isRecord(usage) && keys.every(key => usage[key] === undefined || isFiniteNonNegativeNumber(usage[key])));
}

const LEGACY_EVENT_VALIDATORS: Record<string, (candidate: Record<string, unknown>, contextual: boolean) => boolean> = {
    init: candidate => hasValidOptionalTimestamp(candidate) && typeof candidate.session_id === 'string' && typeof candidate.model === 'string',
    message: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && hasValidOptionalTimestamp(candidate)
        && (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string'
        && (candidate.delta === undefined || typeof candidate.delta === 'boolean'),
    tool_use: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && hasValidOptionalTimestamp(candidate)
        && typeof candidate.tool_name === 'string' && typeof candidate.tool_id === 'string' && isRecord(candidate.parameters),
    tool_result: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && hasValidOptionalTimestamp(candidate)
        && typeof candidate.tool_id === 'string' && hasProtocolStatus(candidate) && typeof candidate.output === 'string',
    result: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && hasValidOptionalTimestamp(candidate)
        && hasProtocolStatus(candidate) && hasValidUsage(candidate.stats, LEGACY_RESULT_STAT_KEYS),
    error: (candidate, contextual) => (hasProtocolTimestamp(candidate) || contextual) && hasValidOptionalTimestamp(candidate)
        && typeof candidate.message === 'string',
};

function isAntigravityEvent(event: unknown, contextual = false): event is AntigravityEvent {
    if (!isRecord(event) || typeof event.type !== 'string' || !Object.hasOwn(LEGACY_EVENT_VALIDATORS, event.type)) return false;
    return LEGACY_EVENT_VALIDATORS[event.type](event, contextual);
}

function isStreamStatus(value: unknown): value is AntigravityStreamResultEvent['result']['status'] {
    return typeof value === 'string' && (value.toUpperCase() === 'SUCCESS' || value.toUpperCase() === 'ERROR');
}

function isStreamInitEvent(event: Record<string, unknown>): boolean {
    if (typeof event.conversation_id !== 'string' || !isRecord(event.init) || typeof event.init.model !== 'string') return false;
    return (event.init.cwd === undefined || typeof event.init.cwd === 'string')
        && (event.init.tools === undefined || Array.isArray(event.init.tools));
}

function isStreamStepUpdateEvent(event: Record<string, unknown>): boolean {
    if (!isRecord(event.step_update)) return false;
    const update = event.step_update;
    return typeof update.conversation_id === 'string' && Number.isInteger(update.step_index)
        && typeof update.state === 'string' && update.state.trim().length > 0
        && typeof update.step_type === 'string' && update.step_type.trim().length > 0
        && (update.text_delta === undefined || typeof update.text_delta === 'string')
        && hasValidUsage(update.usage, STREAM_USAGE_KEYS);
}

function isStreamResultEvent(event: Record<string, unknown>): boolean {
    if (!isRecord(event.result)) return false;
    const result = event.result;
    return typeof result.conversation_id === 'string' && isStreamStatus(result.status)
        && (result.response === undefined || typeof result.response === 'string')
        && (result.duration_seconds === undefined || isFiniteNonNegativeNumber(result.duration_seconds))
        && (result.num_turns === undefined || (Number.isInteger(result.num_turns) && (result.num_turns as number) >= 0))
        && hasValidUsage(result.usage, STREAM_USAGE_KEYS);
}

const STREAM_EVENT_VALIDATORS: Record<string, (candidate: Record<string, unknown>) => boolean> = {
    init: isStreamInitEvent,
    step_update: isStreamStepUpdateEvent,
    result: isStreamResultEvent,
};

function isAntigravityStreamEvent(event: unknown): event is AntigravityStreamEvent {
    return isRecord(event) && typeof event.event === 'string' && Object.hasOwn(STREAM_EVENT_VALIDATORS, event.event)
        && STREAM_EVENT_VALIDATORS[event.event](event);
}

function isAntigravityOutputEvent(event: unknown, contextual = false): event is AntigravityOutputEvent {
    return isTranscriptEvent(event) || isAntigravityStreamEvent(event) || isAntigravityEvent(event, contextual);
}

function isAntigravityFramingEvent(event: unknown): boolean {
    if (isTranscriptEvent(event) || isAntigravityStreamEvent(event)) return true;
    if (!isRecord(event)) return false;
    if (event.type === 'init') return LEGACY_EVENT_VALIDATORS.init(event, false);
    return (event.type === 'message' || event.type === 'error') && isAntigravityEvent(event, false);
}

function normalizeLegacyTokenUsage(stats: AntigravityLegacyUsage | undefined): TokenUsage {
    if (!stats) return {};
    return compactTokenUsage({ input_tokens: stats.input_tokens ?? stats.inputTokens, output_tokens: stats.output_tokens ?? stats.outputTokens });
}

function normalizeStreamTokenUsage(usage: AntigravityStreamUsage | undefined): TokenUsage {
    if (!usage) return {};
    return compactTokenUsage({
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_tokens,
        reasoning_output_tokens: usage.thinking_tokens,
    });
}

function compactTokenUsage(usage: TokenUsage): TokenUsage {
    return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as TokenUsage;
}

function mergeTokenUsageByMax(target: TokenUsage, usage: TokenUsage): void {
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'reasoning_output_tokens'] as const) {
        const value = usage[key];
        if (value !== undefined) target[key] = Math.max(target[key] ?? 0, value);
    }
}

interface ParseState {
    sessionId?: string; conversationId?: string; streamConversationId?: string; modelUsed?: string;
    tokenUsage: TokenUsage; currentAssistantMessage: string; lastCompleteAssistantMessage: string;
    legacyTerminalStatus?: AntigravityTerminalStatus; streamTerminalStatus?: AntigravityTerminalStatus; protocolError?: string;
}

function correlateStreamEnvelope(state: ParseState, envelope: AntigravityStreamEvent['event'], conversationId: string): boolean {
    if (!conversationId.trim()) { state.protocolError ??= `Antigravity ${envelope} envelope has no conversation_id`; return false; }
    if (!state.streamConversationId) {
        if (envelope !== 'init') { state.protocolError ??= `Antigravity ${envelope} envelope arrived before an initiating conversation_id`; return false; }
        state.streamConversationId = conversationId; state.conversationId = conversationId; state.sessionId = conversationId; return true;
    }
    if (conversationId !== state.streamConversationId) { state.protocolError ??= `Antigravity ${envelope} envelope expected conversation_id "${state.streamConversationId}", got "${conversationId}"`; return false; }
    return true;
}

function processLegacyEvent(event: AntigravityEvent, state: ParseState): void {
    if (state.streamConversationId) return;
    if (event.type === 'init') { state.sessionId = event.session_id; state.modelUsed = normalizeAntigravityModelId(event.model); return; }
    if (event.type === 'message' && event.role === 'assistant') {
        if (event.delta) state.currentAssistantMessage += event.content;
        else { state.lastCompleteAssistantMessage = event.content; state.currentAssistantMessage = ''; }
        return;
    }
    if (event.type === 'result') { state.legacyTerminalStatus = event.status; state.tokenUsage = normalizeLegacyTokenUsage(event.stats); }
    if (event.type !== 'message' && state.currentAssistantMessage) { state.lastCompleteAssistantMessage = state.currentAssistantMessage; state.currentAssistantMessage = ''; }
}

function processStreamEvent(event: AntigravityStreamEvent, state: ParseState, events: AntigravityOutputEvent[]): void {
    if (state.streamTerminalStatus) { state.protocolError ??= `Antigravity ${event.event} envelope arrived after terminal result`; return; }
    if (event.event === 'init') {
        const model = normalizeAntigravityModelId(event.init.model);
        if (state.streamConversationId !== undefined) {
            if (event.conversation_id !== state.streamConversationId) correlateStreamEnvelope(state, event.event, event.conversation_id);
            else state.protocolError ??= model === state.modelUsed ? `Repeated Antigravity stream init for conversation_id "${event.conversation_id}"` : `Conflicting Antigravity stream init model: ${state.modelUsed} then ${model}`;
            return; }
        events.push(event); if (!correlateStreamEnvelope(state, event.event, event.conversation_id)) return;
        state.modelUsed = model; state.tokenUsage = {};
        state.currentAssistantMessage = ''; state.lastCompleteAssistantMessage = '';
        return;
    }
    if (event.event === 'step_update') {
        events.push(event); if (!correlateStreamEnvelope(state, event.event, event.step_update.conversation_id)) return;
        mergeTokenUsageByMax(state.tokenUsage, normalizeStreamTokenUsage(event.step_update.usage));
        if (normalizeTranscriptIdentifier(event.step_update.step_type) === 'AGENT_RESPONSE' && event.step_update.text_delta) {
            state.currentAssistantMessage += event.step_update.text_delta;
        }
        return;
    }
    events.push(event); if (!correlateStreamEnvelope(state, event.event, event.result.conversation_id)) return;
    const terminalStatus = event.result.status.toUpperCase() === 'SUCCESS' ? 'success' : 'error';
    state.streamTerminalStatus = terminalStatus;
    // result.usage is the terminal cumulative snapshot; its reported fields win
    // over interim step snapshots while omitted fields retain their step value.
    state.tokenUsage = { ...state.tokenUsage, ...normalizeStreamTokenUsage(event.result.usage) };
    // The terminal response is authoritative and commonly repeats all streamed deltas.
    if (event.result.response !== undefined) {
        state.lastCompleteAssistantMessage = event.result.response;
        state.currentAssistantMessage = '';
    }
}

/** Returns the assistant text carried by an analysis event across supported Antigravity protocols. */
export function getAntigravityAnalysisText(event: AntigravityOutputEvent): string | undefined {
    if (isTranscriptEvent(event)) return normalizeTranscriptIdentifier(event.source) === 'MODEL'
        && normalizeTranscriptIdentifier(event.type) === 'PLANNER_RESPONSE' ? event.content : undefined;
    if (isAntigravityStreamEvent(event)) {
        if (event.event === 'step_update') return normalizeTranscriptIdentifier(event.step_update.step_type) === 'AGENT_RESPONSE'
            ? event.step_update.text_delta : undefined;
        return event.event === 'result' ? event.result.response : undefined;
    }
    return event.type === 'message' && event.role === 'assistant' ? event.content : undefined;
}

export function isAntigravityAnalysisEvent(event: AntigravityOutputEvent): boolean {
    return Boolean(getAntigravityAnalysisText(event)?.trim());
}

export function filterAntigravityAnalysisEvents(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
    const streamedResponses = new Map<string, string>(); for (const event of events) { if (isAntigravityStreamEvent(event) && event.event === 'step_update' && normalizeTranscriptIdentifier(event.step_update.step_type) === 'AGENT_RESPONSE') { const update = event.step_update; if (update.text_delta !== undefined) streamedResponses.set(update.conversation_id, (streamedResponses.get(update.conversation_id) ?? '') + update.text_delta); } }
    const terminalSupersedesStream = (conversationId: string): boolean => events.some(event => isAntigravityStreamEvent(event) && event.event === 'result' && event.result.conversation_id === conversationId && (event.result.status.toUpperCase() === 'ERROR' || (event.result.response !== undefined && event.result.response !== streamedResponses.get(conversationId))));
    return events.filter(event => {
        if (!isAntigravityStreamEvent(event)) return isAntigravityAnalysisEvent(event);
        if (event.event === 'step_update') return isAntigravityAnalysisEvent(event) && !terminalSupersedesStream(event.step_update.conversation_id);
        if (event.event !== 'result') return false; if (event.result.status.toUpperCase() === 'ERROR') return true;
        // Suppress only a successful terminal response that exactly duplicates
        // the aggregate streamed response for this conversation.
        if (!isAntigravityAnalysisEvent(event)) return false; return event.result.response !== streamedResponses.get(event.result.conversation_id);
    });
}

function splitAntigravityOutput(output: string): string[] { try { const document = JSON.parse(output) as unknown; if (Array.isArray(document) && document.some(value => isRecord(value) && typeof value.event === 'string' && Object.hasOwn(STREAM_EVENT_VALIDATORS, value.event))) return document.map(value => JSON.stringify(value) ?? 'null'); } catch { /* JSONL/plain text use line parsing. */ } return output.split('\n'); }

/** Parses legacy, transcript, and Antigravity 1.1.12+ JSONL; plain text remains a supported fallback. */
export function parseAntigravityJsonl(output: string): AntigravityParsedOutput {
    const events: AntigravityOutputEvent[] = [];
    let hasStreamEnvelopes = false;
    const state: ParseState = { tokenUsage: {}, currentAssistantMessage: '', lastCompleteAssistantMessage: '' };
    const parsedLines: Array<{ line: string; value?: unknown }> = [];
    for (const line of splitAntigravityOutput(output)) {
        if (!line.trim()) { parsedLines.push({ line }); continue; }
        try { parsedLines.push({ line, value: JSON.parse(line) as unknown }); }
        catch {
            parsedLines.push({ line });
            logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Antigravity output');
        }
    }
    const hasProtocolContext = parsedLines.some(({ value }) => isAntigravityFramingEvent(value));
    const plainLines: Array<{ line: string; isJson: boolean }> = [];
    for (const { line, value } of parsedLines) {
        if (isRecord(value) && typeof value.event === 'string' && Object.hasOwn(STREAM_EVENT_VALIDATORS, value.event)) {
            hasStreamEnvelopes = true;
            if (!STREAM_EVENT_VALIDATORS[value.event](value)) {
                state.protocolError ??= `Malformed Antigravity stream envelope: ${value.event}`;
                continue;
            }
        }
        if (!isAntigravityOutputEvent(value, hasProtocolContext)) {
            plainLines.push({ line, isJson: value !== undefined });
            continue;
        }
        if (isAntigravityStreamEvent(value)) processStreamEvent(value, state, events);
        else { events.push(value); if (isTranscriptEvent(value)) {
            if (!state.streamConversationId && normalizeTranscriptIdentifier(value.source) === 'MODEL'
                && typeof value.content === 'string' && value.content.trim()) state.lastCompleteAssistantMessage = value.content;
        } else processLegacyEvent(value, state); }
    }
    if (state.currentAssistantMessage) state.lastCompleteAssistantMessage = state.currentAssistantMessage;
    const plainTextSummary = extractLegacyFallback(plainLines, hasStreamEnvelopes);
    return {
        sessionId: state.sessionId,
        conversationId: state.conversationId,
        modelUsed: state.modelUsed,
        summary: state.lastCompleteAssistantMessage || plainTextSummary,
        conversationLog: events,
        tokenUsage: state.tokenUsage,
        terminalStatus: hasStreamEnvelopes ? state.streamTerminalStatus : state.legacyTerminalStatus,
        protocolError: state.protocolError,
        hasStreamEnvelopes,
    };
}

function flushPendingMessage(result: AntigravityOutputEvent[], pending: { content: string; timestamp?: string; role: 'user' | 'assistant' } | null): null {
    if (pending) result.push({ type: 'message', role: pending.role, content: pending.content, timestamp: pending.timestamp });
    return null;
}

function flushPendingStreamMessage(result: AntigravityOutputEvent[], pending: AntigravityStreamStepUpdateEvent | null): null { if (pending) result.push(pending); return null; }

/** Aggregates consecutive legacy and stream delta messages into single assistant messages. */
export function aggregateDeltaMessages(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
    const result: AntigravityOutputEvent[] = [];
    let pending: { content: string; timestamp?: string; role: 'user' | 'assistant' } | null = null;
    let pendingStream: AntigravityStreamStepUpdateEvent | null = null;
    for (const event of events) {
        if (isAntigravityStreamEvent(event)) {
            pending = flushPendingMessage(result, pending);
            if (event.event === 'step_update' && normalizeTranscriptIdentifier(event.step_update.step_type) === 'AGENT_RESPONSE'
                && typeof event.step_update.text_delta === 'string') {
                const update = event.step_update;
                if (pendingStream && pendingStream.step_update.conversation_id === update.conversation_id
                    && pendingStream.step_update.step_index === update.step_index) {
                    pendingStream.step_update.text_delta = (pendingStream.step_update.text_delta ?? '') + update.text_delta;
                    pendingStream.step_update.state = update.state; pendingStream.step_update.usage = update.usage ?? pendingStream.step_update.usage;
                } else {
                    pendingStream = flushPendingStreamMessage(result, pendingStream);
                    pendingStream = { ...event, step_update: { ...update } };
                }
            } else {
                pendingStream = flushPendingStreamMessage(result, pendingStream); result.push(event);
            }
            continue;
        }
        pendingStream = flushPendingStreamMessage(result, pendingStream);
        if (isTranscriptEvent(event)) { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        if (event.type !== 'message') { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        if (event.role !== 'assistant') { pending = flushPendingMessage(result, pending); result.push(event); continue; }
        if (event.delta) {
            if (pending?.role === 'assistant') pending.content += event.content;
            else { pending = flushPendingMessage(result, pending); pending = { content: event.content, timestamp: event.timestamp, role: 'assistant' }; }
        } else { pending = flushPendingMessage(result, pending); result.push(event); }
    }
    flushPendingMessage(result, pending);
    flushPendingStreamMessage(result, pendingStream);
    return result;
}

/** Converts an Antigravity event to the Claude-shaped conversation representation used by the UI. */
export function convertEventToClaudeFormat(event: AntigravityOutputEvent): unknown {
    if (isTranscriptEvent(event)) {
        const source = normalizeTranscriptIdentifier(event.source);
        const role = source === 'MODEL' ? 'assistant' : source === 'USER_EXPLICIT' ? 'user' : 'system';
        return { type: role, timestamp: event.created_at, message: { content: [{ type: 'text', text: event.content || '' }] }, antigravity: { source: event.source, type: event.type, status: event.status, step_index: event.step_index } };
    }
    if (isAntigravityStreamEvent(event)) {
        if (event.event === 'init') {
            return { type: 'system', session_id: event.conversation_id, conversation_id: event.conversation_id, model: event.init.model, message: { content: [] } };
        }
        if (event.event === 'step_update') {
            const isAgentResponse = normalizeTranscriptIdentifier(event.step_update.step_type) === 'AGENT_RESPONSE';
            return {
                type: isAgentResponse ? 'assistant' : 'system',
                session_id: event.step_update.conversation_id,
                conversation_id: event.step_update.conversation_id,
                message: {
                    content: event.step_update.text_delta === undefined ? [] : [{ type: 'text', text: event.step_update.text_delta }],
                    usage: normalizeStreamTokenUsage(event.step_update.usage),
                },
                antigravity: { type: event.step_update.step_type, status: event.step_update.state, step_index: event.step_update.step_index },
            };
        }
        return {
            type: 'result',
            session_id: event.result.conversation_id,
            conversation_id: event.result.conversation_id,
            status: event.result.status.toLowerCase(),
            message: {
                content: event.result.response === undefined ? [] : [{ type: 'text', text: event.result.response }],
                usage: normalizeStreamTokenUsage(event.result.usage),
            },
        };
    }
    if (event.type === 'message') return { type: event.role === 'assistant' ? 'assistant' : 'user', timestamp: event.timestamp, message: { content: [{ type: 'text', text: event.content }] } };
    if (event.type === 'tool_use') return { type: 'assistant', timestamp: event.timestamp, message: { content: [{ type: 'tool_use', name: event.tool_name, id: event.tool_id, input: event.parameters }] } };
    if (event.type === 'tool_result') return { type: 'user', timestamp: event.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: event.tool_id, content: event.output, is_error: event.status === 'error' }] } };
    if (event.type === 'result') return { type: 'result', timestamp: event.timestamp, status: event.status, message: { usage: normalizeLegacyTokenUsage(event.stats) } };
    if (event.type === 'init') return { type: 'system', timestamp: event.timestamp, session_id: event.session_id, model: event.model, message: { content: [] } };
    return { type: 'error', timestamp: event.timestamp, message: { content: [{ type: 'text', text: event.message }] } };
}
