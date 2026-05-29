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
  const topLevelPartsText = joinOpenCodePartsText([
    ...(event.part ? [event.part] : []),
    ...(event.parts ?? []),
  ], false);
  if (topLevelPartsText) return topLevelPartsText;
  const message = event.message;
  if (message?.role === 'assistant') {
    const text = message.parts?.length
      ? joinOpenCodePartsText(message.parts)
      : joinOpenCodeTextValues([message.text, message.delta, message.content]);
    return text || null;
  }
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
  const text = values.filter((value): value is string => typeof value === 'string' && value.length > 0).join('');
  return trim ? text.trim() : text;
}

function extractOpenCodeEventError(event: OpenCodeEvent): string {
  if (typeof event.error === 'string') return event.error;
  return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}
