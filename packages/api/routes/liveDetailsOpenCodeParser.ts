import { normalizeOpenCodeTimestamp, parseOpenCodeJsonl, type OpenCodeEvent } from '@propr/core';
import type { ConversationResult, TokenUsage } from './liveDetailsCodexParser.js';

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
    const toolEvents = extractOpenCodeToolEvents(event, eventTimestamp);
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
  if (event.message?.role && event.message.role !== 'assistant') return null;
  const topLevelPartsText = joinOpenCodePartsText([
    ...(event.part ? [event.part] : []),
    ...(event.parts ?? []),
  ], false);
  const message = event.message;
  let messageText = '';
  if (message?.role === 'assistant') {
    messageText = message.parts?.length
      ? joinOpenCodePartsText(message.parts)
      : joinOpenCodeTextValues([message.text, message.delta, message.content]);
  }
  if (topLevelPartsText || messageText) return joinOpenCodeTextGroups(topLevelPartsText, messageText) || null;
  if (!event.type || !['text', 'delta', 'completion'].includes(event.type.toLowerCase())) return null;
  const text = joinOpenCodeTextValues([event.text, event.delta, event.content], !isOpenCodeStreamingTextEvent(event));
  return text || null;
}

function isOpenCodeStreamingTextEvent(event: OpenCodeEvent): boolean {
  const type = event.type?.toLowerCase();
  return type === 'delta' || Boolean(event.part || event.parts?.length);
}

function joinOpenCodePartsText(parts: Array<{ type?: string; text?: string; delta?: string; content?: unknown }>, trim = true): string {
  const values = parts.flatMap(part => {
    const partType = part.type?.toLowerCase();
    if (partType && !['text', 'assistant_text', 'message', 'completion'].includes(partType)) return [];
    return [part.text, part.delta, part.content];
  });
  return joinOpenCodeTextValues(values, trim);
}

function joinOpenCodeTextValues(values: unknown[], trim = true): string {
  const added = new Set<string>();
  const text = values.filter((value): value is string => {
    if (typeof value !== 'string' || value.length === 0 || added.has(value)) return false;
    added.add(value);
    return true;
  }).join('');
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

function extractOpenCodeToolEvents(event: OpenCodeEvent, timestamp: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  appendOpenCodeToolEvent(events, event, timestamp);
  appendOpenCodeToolEvent(events, event.part, timestamp);
  for (const part of event.parts ?? []) appendOpenCodeToolEvent(events, part, timestamp);
  return events;
}

function appendOpenCodeToolEvent(events: Array<Record<string, unknown>>, source: OpenCodeEvent['part'] | OpenCodeEvent | undefined, timestamp: string): void {
  if (!source?.type) return;
  const type = source.type.toLowerCase();
  if (['tool_use', 'tool', 'tool_call'].includes(type)) {
    events.push({
      type: 'tool_use',
      toolName: source.tool_name || source.tool || source.name,
      input: source.parameters || source.input || source.args,
      id: source.tool_id || source.id,
      timestamp
    });
    return;
  }
  if (['tool_result', 'tool_response'].includes(type)) {
    events.push({
      type: 'tool_result',
      toolUseId: source.tool_id || source.id,
      result: source.output || source.result,
      isError: source.status === 'error',
      timestamp
    });
  }
}
