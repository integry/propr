import { normalizeOpenCodeTimestamp, parseOpenCodeJsonl, type OpenCodeEvent } from '@propr/core';
import type { ConversationResult, TokenUsage } from './liveDetailsTypes.js';

function buildOpenCodeTokenUsage(parsed: ReturnType<typeof parseOpenCodeJsonl>): TokenUsage | null {
  if (!parsed.tokenUsage) return null;
  return {
    input_tokens: parsed.tokenUsage.input_tokens ?? 0,
    output_tokens: parsed.tokenUsage.output_tokens ?? 0,
    cache_creation_input_tokens: parsed.tokenUsage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: parsed.tokenUsage.cache_read_input_tokens ?? 0
  };
}

export function parseOpenCodeOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseOpenCodeJsonl(output);
  const events: Array<Record<string, unknown>> = [];
  const timestamp = new Date().toISOString();
  let hasAssistantMessageEvents = false;
  let pendingAssistantMessage = '';
  let pendingAssistantTimestamp: string | null = null;
  const emittedToolUseIds = new Set<string>();
  const emittedToolResultIds = new Set<string>();
  const flushPendingAssistantMessage = (fallbackTimestamp: string): void => {
    if (!pendingAssistantMessage) return;
    hasAssistantMessageEvents = true;
    events.push({ type: 'thought', content: pendingAssistantMessage, timestamp: pendingAssistantTimestamp ?? fallbackTimestamp });
    pendingAssistantMessage = '';
    pendingAssistantTimestamp = null;
  };
  for (const event of parsed.conversationLog) {
    const eventTimestamp = getOpenCodeEventTimestamp(event, timestamp);
    const assistantMessage = extractOpenCodeAssistantMessage(event);
    if (assistantMessage) {
      if (isOpenCodeStreamingTextEvent(event)) {
        pendingAssistantMessage += assistantMessage;
        pendingAssistantTimestamp ??= eventTimestamp;
      } else {
        flushPendingAssistantMessage(eventTimestamp);
        hasAssistantMessageEvents = true;
        events.push(buildOpenCodeAssistantTextEvent(event, assistantMessage, eventTimestamp));
      }
    }
    if (event.type?.toLowerCase() === 'error' || event.error) {
      flushPendingAssistantMessage(eventTimestamp);
      events.push({ type: 'tool_result', result: extractOpenCodeEventError(event), isError: true, timestamp: eventTimestamp });
    }
    const toolEvents = extractOpenCodeToolEvents(event, eventTimestamp, emittedToolUseIds, emittedToolResultIds);
    if (toolEvents.length) {
      flushPendingAssistantMessage(eventTimestamp);
      events.push(...toolEvents);
    }
  }
  flushPendingAssistantMessage(timestamp);
  if (!hasAssistantMessageEvents && parsed.summary) events.push({ type: 'thought', content: parsed.summary, timestamp });
  if (parsed.error && !events.some(event => event.type === 'tool_result' && event.result === parsed.error)) {
    events.push({ type: 'tool_result', result: parsed.error, isError: true, timestamp });
  }
  const tokenUsage = buildOpenCodeTokenUsage(parsed);
  return events.length || tokenUsage ? { events, todos: [], currentTask: null, tokenUsage } : null;
}

function buildOpenCodeAssistantTextEvent(event: OpenCodeEvent, content: string, timestamp: string): Record<string, unknown> {
  const type = event.message?.role === 'assistant' && event.type?.toLowerCase() === 'message'
    ? 'message'
    : 'thought';
  return { type, content, timestamp };
}

function getOpenCodeEventTimestamp(event: OpenCodeEvent, fallback: string): string {
  return normalizeOpenCodeTimestamp(event.timestamp, fallback);
}

function extractOpenCodeAssistantMessage(event: OpenCodeEvent): string | null {
  if (event.message?.role && event.message.role !== 'assistant') return null;
  const eventType = event.type?.toLowerCase();
  if (eventType && isOpenCodeNonAssistantEventType(eventType)) return null;

  const structured = extractOpenCodeStructuredText(event, eventType);
  if (structured) return structured;

  return extractOpenCodeBareText(event, eventType);
}

function extractOpenCodeStructuredText(event: OpenCodeEvent, eventType: string | undefined): string | null {
  const isConfirmedAssistant = event.message?.role === 'assistant';
  const includeTopLevel = isConfirmedAssistant || !eventType || !isOpenCodeToolRelatedType(eventType);
  const topLevelPartsText = includeTopLevel
    ? joinOpenCodePartsText([...(event.part ? [event.part] : []), ...(event.parts ?? [])], false)
    : '';
  const responseText = joinOpenCodeTextValues([event.response?.text, event.response?.delta, event.response?.content]);
  const messageText = isConfirmedAssistant
    ? extractOpenCodeConfirmedAssistantText(event.message!, !isOpenCodeStreamingTextEvent(event))
    : '';
  const combined = joinOpenCodeTextGroups(topLevelPartsText, joinOpenCodeTextGroups(messageText, responseText));
  return combined || null;
}

function extractOpenCodeConfirmedAssistantText(message: NonNullable<OpenCodeEvent['message']>, trim = true): string {
  return message.parts?.length
    ? joinOpenCodePartsText(message.parts, trim)
    : joinOpenCodeTextValues([message.text, message.delta, message.content], trim);
}

function extractOpenCodeBareText(event: OpenCodeEvent, eventType: string | undefined): string | null {
  if (!eventType || !['text', 'delta', 'completion', 'reasoning'].includes(eventType)) return null;
  const text = joinOpenCodeTextValues([event.text, event.delta, event.content], !isOpenCodeStreamingTextEvent(event));
  return text || null;
}

function isOpenCodeNonAssistantEventType(type: string): boolean {
  return ['user', 'system', 'user_message', 'system_message'].includes(type);
}

function isOpenCodeToolRelatedType(type: string): boolean {
  return ['tool_use', 'tool_result', 'tool', 'tool_call', 'tool_response'].includes(type);
}

function isOpenCodeStreamingTextEvent(event: OpenCodeEvent): boolean {
  const type = event.type?.toLowerCase();
  if (type && ['delta', 'text_delta', 'message_delta', 'part_delta'].includes(type)) return true;
  if (typeof event.delta === 'string' || typeof event.response?.delta === 'string' || typeof event.message?.delta === 'string') return true;
  const parts = [...(event.part ? [event.part] : []), ...(event.parts ?? []), ...(event.message?.parts ?? [])];
  return parts.some(part => {
    const partType = part.type?.toLowerCase();
    return typeof part.delta === 'string' || partType === 'delta' || partType === 'text_delta';
  });
}

function joinOpenCodePartsText(parts: Array<{ type?: string; text?: string; delta?: string; content?: unknown }>, trim = true): string {
  const values = parts.flatMap(part => {
    const partType = part.type?.toLowerCase();
    if (partType && !['text', 'text_delta', 'delta', 'assistant_text', 'message', 'completion', 'reasoning'].includes(partType)) return [];
    return [part.text, part.delta, part.content];
  });
  return joinOpenCodeTextValues(values, trim);
}

function joinOpenCodeTextValues(values: unknown[], trim = true): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    parts.push(value);
  }
  const text = parts.join(trim ? '\n' : '');
  return trim ? text.trim() : text;
}

function joinOpenCodeTextGroups(first: string, second: string): string {
  if (!first) return second;
  if (!second || first === second) return first;
  return `${first}\n${second}`;
}

function extractOpenCodeEventError(event: OpenCodeEvent): string {
  if (typeof event.error === 'string') return event.error;
  return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}

interface OpenCodeToolTracker {
  emittedToolUseIds: Set<string>;
  emittedToolResultIds: Set<string>;
}

function extractOpenCodeToolEvents(event: OpenCodeEvent, timestamp: string, emittedToolUseIds: Set<string>, emittedToolResultIds: Set<string>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const tracker: OpenCodeToolTracker = { emittedToolUseIds, emittedToolResultIds };
  if (!event.part) appendOpenCodeToolEvent(events, event, timestamp, tracker);
  appendOpenCodeToolEvent(events, event.part, timestamp, tracker);
  for (const part of event.parts ?? []) appendOpenCodeToolEvent(events, part, timestamp, tracker);
  return events;
}

function appendOpenCodeToolEvent(events: Array<Record<string, unknown>>, source: OpenCodeEvent['part'] | OpenCodeEvent | undefined, timestamp: string, tracker: OpenCodeToolTracker): void {
  if (!source?.type) return;
  const type = source.type.toLowerCase();
  const sourceWithState = source as OpenCodeToolSource;
  if (isOpenCodeToolResultType(type)) {
    appendOpenCodeToolResultEvent(events, sourceWithState, timestamp, tracker.emittedToolResultIds);
    return;
  }
  if (!isOpenCodeToolUseType(type)) return;
  const toolId = getOpenCodeToolId(sourceWithState);
  const toolName = getOpenCodeToolName(sourceWithState);
  if (!toolId && !toolName) return;
  if (toolId && tracker.emittedToolUseIds.has(toolId)) return;
  if (toolId) tracker.emittedToolUseIds.add(toolId);
  events.push(buildOpenCodeToolUseEvent(sourceWithState, timestamp));
  if (type === 'tool') appendOpenCodeCompletedToolResult(events, sourceWithState, timestamp, tracker.emittedToolResultIds);
}

interface OpenCodeToolSource {
  id?: string;
  callID?: string;
  tool_id?: string;
  tool?: string;
  tool_name?: string;
  name?: string;
  input?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
  output?: string;
  result?: string;
  status?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: unknown;
    metadata?: { output?: string; exit?: number };
  };
}

function isOpenCodeToolUseType(type: string): boolean {
  return ['tool_use', 'tool', 'tool_call'].includes(type);
}

function isOpenCodeToolResultType(type: string): boolean {
  return ['tool_result', 'tool_response'].includes(type);
}

function buildOpenCodeToolUseEvent(source: OpenCodeToolSource, timestamp: string): Record<string, unknown> {
  return {
    type: 'tool_use',
    toolName: getOpenCodeToolName(source),
    input: source.parameters || source.input || source.args || source.state?.input,
    id: getOpenCodeToolId(source),
    timestamp
  };
}

function getOpenCodeToolName(source: OpenCodeToolSource): string | undefined {
  return source.tool_name || source.tool || source.name;
}

function appendOpenCodeCompletedToolResult(events: Array<Record<string, unknown>>, source: OpenCodeToolSource, timestamp: string, emittedToolResultIds: Set<string>): void {
  if (!source.state || !['completed', 'error'].includes(source.state.status ?? '')) return;
  const toolId = getOpenCodeToolId(source);
  if (toolId && emittedToolResultIds.has(toolId)) return;
  if (toolId) emittedToolResultIds.add(toolId);
  events.push({
    type: 'tool_result',
    toolUseId: toolId,
    result: extractOpenCodeToolResult(source),
    isError: isOpenCodeToolStateError(source),
    timestamp
  });
}

function appendOpenCodeToolResultEvent(events: Array<Record<string, unknown>>, source: OpenCodeToolSource, timestamp: string, emittedToolResultIds: Set<string>): void {
  const toolId = getOpenCodeToolId(source);
  if (toolId && emittedToolResultIds.has(toolId)) return;
  if (toolId) emittedToolResultIds.add(toolId);
  events.push({
    type: 'tool_result',
    toolUseId: toolId,
    result: extractOpenCodeToolResult(source),
    isError: isOpenCodeToolStateError(source),
    timestamp
  });
}

function getOpenCodeToolId(source: OpenCodeToolSource): string | undefined {
  return source.tool_id || source.callID || source.id;
}

function extractOpenCodeToolResult(source: OpenCodeToolSource): string {
  const state = source.state;
  if (!state) return source.output || source.result || '';
  if (typeof state.output === 'string') return state.output;
  if (typeof state.metadata?.output === 'string') return state.metadata.output;
  if (typeof state.error === 'string') return state.error;
  if (state.error && typeof state.error === 'object' && 'message' in state.error && typeof state.error.message === 'string') {
    return state.error.message;
  }
  return source.output || source.result || '';
}

function isOpenCodeToolStateError(source: OpenCodeToolSource): boolean {
  if (source.state?.status === 'error' || source.status === 'error') return true;
  return typeof source.state?.metadata?.exit === 'number' && source.state.metadata.exit !== 0;
}
