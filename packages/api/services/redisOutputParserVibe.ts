import type { ConversationEvent, TokenUsageInfo } from '@propr/shared';
import { isVibe3GenerationEntry, vibe3EntryToTranscriptEvents, type Vibe3GenerationEntry } from './redisOutputParserVibe3.js';

interface VibeToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

export interface VibeTranscriptEvent {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: VibeToolCall[];
  tool_call_id?: string;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  token_usage?: { input_tokens?: number; output_tokens?: number };
}

interface VibeParseState {
  events: ConversationEvent[];
  tokenUsage: TokenUsageInfo;
  syntheticTimestampBaseMs: number | null;
  syntheticTimestampIndex: number;
  seenEventFingerprints: Set<string>;
  /** Live projection only: `events.length` wherever a record skipped an event emitted by an earlier record. */
  skippedSlots?: number[];
}

const MAX_CONTENT_LENGTH = 2000;

function truncateContent(content: string | undefined): string {
  if (!content) return '';
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return content.substring(0, MAX_CONTENT_LENGTH) + '... [truncated]';
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(textFromValue).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('\n') : undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textFromValue(record.text)
      || textFromValue(record.content)
      || textFromValue(record.message)
      || textFromValue(record.result)
      || textFromValue(record.output);
  }
  return undefined;
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (!input) return undefined;
  if (typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return { arguments: input };
  }
}

function isGenericVibeCompletionContent(content: string): boolean {
  return /^task completed\.?$/i.test(content.trim());
}

function getNextSyntheticTimestamp(state: VibeParseState): string {
  if (state.syntheticTimestampBaseMs === null) return new Date().toISOString();
  const timestamp = new Date(state.syntheticTimestampBaseMs + state.syntheticTimestampIndex * 1000).toISOString();
  state.syntheticTimestampIndex += 1;
  return timestamp;
}

function pushEvent(state: VibeParseState, event: ConversationEvent): void {
  const fingerprint = JSON.stringify({
    type: event.type,
    content: event.content,
    toolName: event.toolName,
    input: event.input,
    toolUseId: event.toolUseId,
    result: event.result,
    isError: event.isError
  });
  if (state.seenEventFingerprints.has(fingerprint)) {
    state.skippedSlots?.push(state.events.length);
    return;
  }
  state.seenEventFingerprints.add(fingerprint);
  state.events.push(event);
}

function processVibeAssistantEvent(event: VibeTranscriptEvent, timestamp: string, state: VibeParseState): void {
  const reasoning = textFromValue(event.reasoning_content);
  if (reasoning) pushEvent(state, { type: 'thought' as const, content: truncateContent(reasoning), internalReasoning: true, timestamp });

  const content = textFromValue(event.content);
  if (content && !isGenericVibeCompletionContent(content)) {
    pushEvent(state, { type: 'thought' as const, content: truncateContent(content), timestamp });
  }

  for (const toolCall of event.tool_calls || []) {
    pushEvent(state, {
      type: 'tool_use' as const,
      toolName: toolCall.function?.name || 'tool',
      input: parseToolInput(toolCall.function?.arguments),
      id: toolCall.id,
      timestamp
    });
  }
}

export function processVibeEvent(event: VibeTranscriptEvent, timestamp: string, state: VibeParseState): void {
  if (event.role === 'system') return;

  const usage = event.usage || event.token_usage;
  if (usage) {
    state.tokenUsage.input_tokens += usage.input_tokens ?? 0;
    state.tokenUsage.output_tokens += usage.output_tokens ?? 0;
  }

  if (event.role === 'assistant') {
    processVibeAssistantEvent(event, timestamp, state);
    return;
  }

  if (event.role === 'tool') {
    const result = textFromValue(event.content) || textFromValue(event.result) || textFromValue(event.output) || textFromValue(event.error);
    if (result) {
      pushEvent(state, {
        type: 'tool_result' as const,
        toolUseId: event.tool_call_id,
        result: truncateContent(result),
        isError: result.includes('<tool_error>') || Boolean(event.error),
        timestamp
      });
    }
  }
}

function extractCompleteJsonObjectsFromArray(output: string): string[] {
  const arrayStart = output.indexOf('[');
  if (arrayStart === -1) return [];

  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(output.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }

  return objects;
}

/**
 * Project a Vibe 3 generation entry (message/effect/reasoning) through the Vibe 2
 * transcript path. Returns false when the record is not a Vibe 3 entry.
 */
export function processVibe3Entry(event: unknown, fallbackTimestamp: string, state: VibeParseState): boolean {
  if (!isVibe3GenerationEntry(event)) return false;
  const entry = event as Vibe3GenerationEntry;
  const timestamp = typeof entry.createdAt === 'number' ? new Date(entry.createdAt).toISOString() : fallbackTimestamp;
  for (const transcriptEvent of vibe3EntryToTranscriptEvents(entry)) processVibeEvent(transcriptEvent, timestamp, state);
  return true;
}

/** Vibe 2 transcript records are keyed by `role`; returns false for anything else. */
export function processVibeRoleRecord(event: VibeTranscriptEvent, timestamp: string, state: VibeParseState): boolean {
  if (event.role !== 'assistant' && event.role !== 'tool' && event.role !== 'system' && event.role !== 'user') return false;
  processVibeEvent(event, timestamp, state);
  return true;
}

export function parseVibeTranscriptOutput(output: string, state: VibeParseState): boolean {
  const objects = extractCompleteJsonObjectsFromArray(output);
  if (objects.length === 0) return false;

  let handled = false;
  for (const objectText of objects) {
    try {
      const event = JSON.parse(objectText) as VibeTranscriptEvent;
      if (processVibe3Entry(event, getNextSyntheticTimestamp(state), state)) {
        handled = true;
      } else if (processVibeRoleRecord(event, getNextSyntheticTimestamp(state), state)) {
        handled = true;
      }
    } catch {
      // Ignore incomplete or malformed objects; later Redis updates may complete them.
    }
  }
  return handled;
}
