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
        events.push({ type: 'thought', content: assistantMessage, timestamp: eventTimestamp });
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

function getOpenCodeEventTimestamp(event: OpenCodeEvent, fallback: string): string {
  return normalizeOpenCodeTimestamp(event.timestamp, fallback);
}

function extractOpenCodeAssistantMessage(event: OpenCodeEvent): string | null {
  // Skip non-assistant messages (user, system)
  if (event.message?.role && event.message.role !== 'assistant') return null;
  const eventType = event.type?.toLowerCase();
  if (eventType && isOpenCodeNonAssistantEventType(eventType)) return null;
  const isConfirmedAssistant = event.message?.role === 'assistant';
  // Streaming deltas: top-level part/parts on confirmed assistant or non-tool events
  const topLevelPartsText = (isConfirmedAssistant || !eventType || !isOpenCodeToolRelatedType(eventType))
    ? joinOpenCodePartsText([
      ...(event.part ? [event.part] : []),
      ...(event.parts ?? []),
    ], false)
    : '';
  // Response object format (event.response.text/delta/content)
  const message = event.message;
  const responseText = joinOpenCodeTextValues([event.response?.text, event.response?.delta, event.response?.content]);
  // Confirmed assistant message with inline parts or text fields
  let messageText = '';
  if (isConfirmedAssistant) {
    messageText = message!.parts?.length
      ? joinOpenCodePartsText(message!.parts)
      : joinOpenCodeTextValues([message!.text, message!.delta, message!.content]);
  }
  if (topLevelPartsText || messageText || responseText) return joinOpenCodeTextGroups(topLevelPartsText, joinOpenCodeTextGroups(messageText, responseText)) || null;
  // Bare text/delta/content events without structured message wrapper
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
  return type === 'delta' || Boolean(event.part || event.parts?.length);
}

function joinOpenCodePartsText(parts: Array<{ type?: string; text?: string; delta?: string; content?: unknown }>, trim = true): string {
  const values = parts.flatMap(part => {
    const partType = part.type?.toLowerCase();
    if (partType && !['text', 'assistant_text', 'message', 'completion', 'reasoning'].includes(partType)) return [];
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
  const text = parts.join('');
  return trim ? text.trim() : text;
}

function joinOpenCodeTextGroups(first: string, second: string): string {
  if (!first) return second;
  if (!second || first === second) return first;
  return `${first}${second}`;
}

function extractOpenCodeEventError(event: OpenCodeEvent): string {
  if (typeof event.error === 'string') return event.error;
  return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}

function extractOpenCodeToolEvents(event: OpenCodeEvent, timestamp: string, emittedToolUseIds: Set<string>, emittedToolResultIds: Set<string>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  if (!event.part) appendOpenCodeToolEvent(events, event, timestamp, emittedToolUseIds, emittedToolResultIds);
  appendOpenCodeToolEvent(events, event.part, timestamp, emittedToolUseIds, emittedToolResultIds);
  for (const part of event.parts ?? []) appendOpenCodeToolEvent(events, part, timestamp, emittedToolUseIds, emittedToolResultIds);
  return events;
}

function appendOpenCodeToolEvent(events: Array<Record<string, unknown>>, source: OpenCodeEvent['part'] | OpenCodeEvent | undefined, timestamp: string, emittedToolUseIds: Set<string>, emittedToolResultIds: Set<string>): void {
  if (!source?.type) return;
  const type = source.type.toLowerCase();
  const sourceWithState = source as OpenCodeToolSource;
  if (isOpenCodeToolResultType(type)) {
    appendOpenCodeToolResultEvent(events, sourceWithState, timestamp, emittedToolResultIds);
    return;
  }
  if (!isOpenCodeToolUseType(type)) return;
  const toolId = getOpenCodeToolId(sourceWithState);
  if (toolId && emittedToolUseIds.has(toolId)) return;
  if (toolId) emittedToolUseIds.add(toolId);
  events.push(buildOpenCodeToolUseEvent(sourceWithState, timestamp));
  if (type === 'tool') appendOpenCodeCompletedToolResult(events, sourceWithState, timestamp, emittedToolResultIds);
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
    toolName: source.tool_name || source.tool || source.name,
    input: source.parameters || source.input || source.args || source.state?.input,
    id: getOpenCodeToolId(source),
    timestamp
  };
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
