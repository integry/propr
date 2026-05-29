import { parseOpenCodeJsonl, type OpenCodeEvent } from '@propr/core';
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
  for (const event of parsed.conversationLog) {
    const eventTimestamp = getOpenCodeEventTimestamp(event, timestamp);
    const assistantMessage = extractOpenCodeAssistantMessage(event);
    if (assistantMessage) {
      hasAssistantMessageEvents = true;
      events.push({ type: 'thought', content: assistantMessage, timestamp: eventTimestamp });
    }
    if (event.type?.toLowerCase() === 'error' || event.error) {
      events.push({ type: 'tool_result', result: extractOpenCodeEventError(event), isError: true, timestamp: eventTimestamp });
    }
  }
  if (!hasAssistantMessageEvents && parsed.summary) events.push({ type: 'thought', content: parsed.summary, timestamp });
  if (parsed.error && !events.some(event => event.type === 'tool_result' && event.result === parsed.error)) {
    events.push({ type: 'tool_result', result: parsed.error, isError: true, timestamp });
  }
  const tokenUsage = buildOpenCodeTokenUsage(parsed);
  return events.length || tokenUsage ? { events, todos: [], currentTask: null, tokenUsage } : null;
}

function getOpenCodeEventTimestamp(event: OpenCodeEvent, fallback: string): string {
  if (typeof event.timestamp === 'string') return event.timestamp;
  if (typeof event.timestamp === 'number') return new Date(event.timestamp).toISOString();
  return fallback;
}

function extractOpenCodeAssistantMessage(event: OpenCodeEvent): string | null {
  const message = event.message;
  if (message?.role === 'assistant') {
    const text = message.parts?.length
      ? joinOpenCodeTextValues(message.parts.flatMap(part => [part.text, part.delta, part.content]))
      : joinOpenCodeTextValues([message.text, message.delta, message.content]);
    return text || null;
  }
  if (!event.type || !['text', 'delta', 'completion'].includes(event.type.toLowerCase())) return null;
  const text = joinOpenCodeTextValues([event.text, event.delta, event.content]);
  return text || null;
}

function joinOpenCodeTextValues(values: unknown[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join('').trim();
}

function extractOpenCodeEventError(event: OpenCodeEvent): string {
  if (typeof event.error === 'string') return event.error;
  return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}
