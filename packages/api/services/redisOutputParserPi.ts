import type { ConversationEvent } from '@propr/shared';

/**
 * Live projection of `pi --mode json` output (see Pi's docs/json.md). Records
 * key on `type` alone: a session header, then `agent_*`, `turn_*`,
 * `message_*` and `tool_execution_*` session events. `message_update` records
 * are delta-only, so assistant text and thinking are buffered per
 * `contentIndex` until `text_end`/`thinking_end` or `message_end`, which carry
 * the authoritative content.
 *
 * Every live event ID comes from data the record itself carries, never from
 * parse order or what this projection saw first, so a reader starting on any
 * line of a retention-trimmed stream names each event as the watcher did:
 * - a tool call and its result: the `toolCallId` every tool record carries;
 * - a text or thinking block: its message's identity plus its `contentIndex`.
 *   `message_update` records carry no message identity, so a block streamed
 *   before this projection saw its `message_start` stays buffered, unpublished,
 *   until `message_end` names it.
 */

type JsonRecord = Record<string, unknown>;

interface PiUsage { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }

interface PiBlock { kind: 'text' | 'thinking'; text: string }

interface PiToolCall { name?: string; input?: Record<string, unknown> }

/** Pi-specific parser state, one per projection. */
export interface PiStreamState {
  /** Streaming blocks of the current assistant message, by `contentIndex`. */
  blocks: Map<number, PiBlock>;
  /** Content indexes of the current assistant message already emitted. */
  emittedBlocks: Set<number>;
  /** The block mirrored into the pending assistant message. */
  activeIndex: number | null;
  /**
   * Identity of the current assistant message (see messageIdentity), which its
   * `message_start` and `message_end` both carry. Null when this projection
   * did not see the message start (retention trimmed it).
   */
  messageId: string | null;
  toolCalls: Map<string, PiToolCall>;
  emittedToolUseIds: Set<string>;
  emittedToolResultIds: Set<string>;
  /** Latest real timestamp seen; tool and update records carry none. */
  lastTimestamp: string | null;
}

/** The slice of the Redis parser state the Pi projection reads and writes. */
export interface PiParseState {
  events: ConversationEvent[];
  tokenUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  pendingAssistantMessage: string;
  pendingAssistantTimestamp: string | null;
  pendingAssistantInternalReasoning: boolean;
  pendingAssistantKey: string | null;
  eventKeys: WeakMap<object, string>;
  pi: PiStreamState;
}

const MAX_CONTENT_LENGTH = 2000;
const FAILED_STOP_REASONS = new Set(['error', 'aborted']);
/** Session events without a distinguishing payload; each name is Pi's own. */
const PI_BARE_EVENT_TYPES = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
  'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end',
  'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished',
]);
const PI_TOOL_EVENT_TYPES = new Set(['tool_execution_start', 'tool_execution_update', 'tool_execution_end']);

export function createPiStreamState(): PiStreamState {
  return {
    blocks: new Map(),
    emittedBlocks: new Set(),
    activeIndex: null,
    messageId: null,
    toolCalls: new Map(),
    emittedToolUseIds: new Set(),
    emittedToolResultIds: new Set(),
    lastTimestamp: null,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a Pi JSON-mode record; every other agent's records are left alone. */
export function isPiRecord(event: unknown): boolean {
  if (!isRecord(event) || typeof event.type !== 'string') return false;
  const type = event.type;
  if (type === 'session') return typeof event.version === 'number' && typeof event.id === 'string';
  if (PI_BARE_EVENT_TYPES.has(type)) return true;
  if (type === 'message_start' || type === 'message_end') return isRecord(event.message) && typeof event.message.role === 'string';
  if (type === 'message_update') return isRecord(event.assistantMessageEvent);
  if (PI_TOOL_EVENT_TYPES.has(type)) return typeof event.toolCallId === 'string';
  return false;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return content.substring(0, MAX_CONTENT_LENGTH) + '... [truncated]';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is JsonRecord => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('');
}

function toolInput(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function timestampFor(state: PiParseState, fallback: string): string {
  return state.pi.lastTimestamp ?? fallback;
}

function pushEvent(state: PiParseState, event: ConversationEvent, key?: string | null): void {
  if (key) state.eventKeys.set(event, key);
  state.events.push(event);
}

function clearPending(state: PiParseState): void {
  state.pendingAssistantMessage = '';
  state.pendingAssistantTimestamp = null;
  state.pendingAssistantInternalReasoning = false;
  state.pendingAssistantKey = null;
  state.pi.activeIndex = null;
}

/**
 * The event key of an assistant block, the same whether its `*_end` update or
 * the final `message_end` emitted it, so a read that starts after retention
 * trimmed the stream names the block the watcher emitted.
 */
function piBlockKey(messageId: string, index: number): string {
  return `pi:block:${encodeURIComponent(messageId)}:${index}`;
}

/**
 * Emit a completed text or thinking block under its message's block key, which
 * it also streamed under. Only `message_end` emits a block of a message with no
 * identity at all; it is keyed by that record.
 */
function emitBlock(state: PiParseState, index: number, { kind, text }: PiBlock, timestamp: string): void {
  const messageId = state.pi.messageId;
  if (state.pi.activeIndex === index) clearPending(state);
  state.pi.emittedBlocks.add(index);
  state.pi.blocks.delete(index);
  if (!text.trim()) return;
  pushEvent(state, {
    type: 'thought' as const,
    content: truncateContent(text),
    ...(kind === 'thinking' ? { internalReasoning: true } : {}),
    timestamp,
  }, messageId ? piBlockKey(messageId, index) : null);
}

/**
 * Only completed blocks are published: a block's buffered text depends on
 * where a read started, its final content does not.
 */
function resetAssistantMessage(state: PiParseState): void {
  if (state.pi.activeIndex !== null) clearPending(state);
  state.pi.blocks.clear();
  state.pi.emittedBlocks.clear();
}

function processMessageUpdate(update: JsonRecord, timestamp: string, state: PiParseState): void {
  const type = typeof update.type === 'string' ? update.type : '';
  const index = typeof update.contentIndex === 'number' ? update.contentIndex : null;
  const kind: PiBlock['kind'] | null = type.startsWith('text_') ? 'text' : type.startsWith('thinking_') ? 'thinking' : null;
  // Tool-call blocks surface through message_end and tool_execution_* records;
  // a block still streaming before one stays buffered for message_end.
  if (index === null || !kind) return;
  if (state.pi.emittedBlocks.has(index)) return;
  // A block left unended stays buffered for message_end, which carries its final content.
  if (state.pi.activeIndex !== null && state.pi.activeIndex !== index) clearPending(state);
  const block = state.pi.blocks.get(index) ?? { kind, text: '' };
  state.pi.blocks.set(index, block);
  if (type.endsWith('_end')) {
    const content = typeof update.content === 'string' ? update.content : block.text;
    // Without the message's identity the block could only be named by this
    // record, which retention may trim; message_end emits it under its key.
    if (state.pi.messageId) {
      emitBlock(state, index, { kind, text: content }, timestamp);
      return;
    }
    block.text = content;
  } else if (type.endsWith('_delta') && typeof update.delta === 'string') block.text += update.delta;
  // A block of a message whose start retention trimmed stays buffered, unpublished:
  // shown now it could only be named by this record, and message_end, which
  // carries the message's identity, would emit it under its block key instead.
  if (!block.text || !state.pi.messageId) return;
  state.pi.activeIndex = index;
  state.pendingAssistantMessage = truncateContent(block.text);
  state.pendingAssistantInternalReasoning = kind === 'thinking';
  state.pendingAssistantTimestamp ??= timestamp;
  // Streaming under the block's key keeps its ID when it completes.
  state.pendingAssistantKey = piBlockKey(state.pi.messageId, index);
}

/** A call's announcement, whichever of `message_end` or `tool_execution_*` carried it first, under its `toolCallId`. */
function emitToolUse(state: PiParseState, id: string, timestamp: string): void {
  if (state.pi.emittedToolUseIds.has(id)) return;
  state.pi.emittedToolUseIds.add(id);
  const call = state.pi.toolCalls.get(id);
  pushEvent(state, { type: 'tool_use' as const, toolName: call?.name || 'tool', input: call?.input, id, timestamp }, piToolKey('tool_use', id));
}

/**
 * Pi reports a result in `tool_execution_end`, a `toolResult` message and
 * `turn_end`: one event per call. Which copy a projection sees first depends on
 * what Redis retention kept, so the result is keyed by its call rather than by
 * its record.
 */
function emitToolResult(state: PiParseState, id: string, { content, isError }: { content: unknown; isError: boolean }, timestamp: string): void {
  if (state.pi.emittedToolResultIds.has(id)) return;
  emitToolUse(state, id, timestamp);
  state.pi.emittedToolResultIds.add(id);
  pushEvent(state, { type: 'tool_result' as const, toolUseId: id, result: truncateContent(contentText(content)), isError, timestamp }, piToolKey('tool_result', id));
}

/** The event key of a call's announcement or result, the same whichever of Pi's copies emitted it. */
function piToolKey(type: 'tool_use' | 'tool_result', toolCallId: string): string {
  return `pi:${type}:${encodeURIComponent(toolCallId)}`;
}

function rememberToolCall(state: PiParseState, id: string, name: unknown, input: unknown): void {
  const known = state.pi.toolCalls.get(id) ?? {};
  state.pi.toolCalls.set(id, {
    name: known.name ?? (typeof name === 'string' && name ? name : undefined),
    input: known.input ?? toolInput(input),
  });
}

function addUsage(state: PiParseState, usage: unknown): void {
  if (!isRecord(usage)) return;
  const piUsage = usage as PiUsage;
  state.tokenUsage.input_tokens += count(piUsage.input);
  state.tokenUsage.output_tokens += count(piUsage.output);
  state.tokenUsage.cache_read_input_tokens += count(piUsage.cacheRead);
  state.tokenUsage.cache_creation_input_tokens += count(piUsage.cacheWrite);
}

function processAssistantMessageEnd(message: JsonRecord, timestamp: string, state: PiParseState): void {
  state.pi.messageId = messageIdentity(message);
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (block.type === 'text' || block.type === 'thinking') {
        // Its text_end/thinking_end already emitted it, under the same key.
        if (state.pi.emittedBlocks.has(index)) return;
        const text = block.type === 'text' ? block.text : block.thinking;
        emitBlock(state, index, { kind: block.type, text: typeof text === 'string' ? text : '' }, timestamp);
      } else if (block.type === 'toolCall' && typeof block.id === 'string') {
        rememberToolCall(state, block.id, block.name, block.arguments);
        emitToolUse(state, block.id, timestamp);
      }
    });
  }
  // A block that streamed but is missing from the final message is dropped.
  resetAssistantMessage(state);
  const messageId = state.pi.messageId;
  state.pi.messageId = null;
  addUsage(state, message.usage);
  if (FAILED_STOP_REASONS.has(String(message.stopReason)) && typeof message.errorMessage === 'string' && message.errorMessage) {
    const content = truncateContent(`Pi stopped (${message.stopReason}): ${message.errorMessage}`);
    pushEvent(state, { type: 'thought' as const, content, timestamp }, messageId ? `pi:stop:${encodeURIComponent(messageId)}` : null);
  }
}

function processMessage(type: string, message: JsonRecord, timestamp: string, state: PiParseState): void {
  if (message.role === 'assistant') {
    if (type === 'message_start') {
      // A message that never ended is not published (Pi always ends one, even an aborted one).
      resetAssistantMessage(state);
      state.pi.messageId = messageIdentity(message);
    } else {
      processAssistantMessageEnd(message, timestamp, state);
    }
    return;
  }
  if (type === 'message_end' && message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    rememberToolCall(state, message.toolCallId, message.toolName, undefined);
    emitToolResult(state, message.toolCallId, { content: message.content, isError: message.isError === true }, timestamp);
  }
  // The user prompt is not narration.
}

function processToolExecution(event: JsonRecord, timestamp: string, state: PiParseState): void {
  const id = event.toolCallId as string;
  rememberToolCall(state, id, event.toolName, event.args);
  if (event.type === 'tool_execution_start') {
    emitToolUse(state, id, timestamp);
  } else if (event.type === 'tool_execution_end') {
    const result = isRecord(event.result) ? event.result : { content: event.result };
    emitToolResult(state, id, { content: result.content, isError: event.isError === true || result.isError === true }, timestamp);
  }
}

function processTurnEnd(event: JsonRecord, timestamp: string, state: PiParseState): void {
  if (!Array.isArray(event.toolResults)) return;
  for (const result of event.toolResults) {
    if (!isRecord(result) || typeof result.toolCallId !== 'string') continue;
    rememberToolCall(state, result.toolCallId, result.toolName, undefined);
    emitToolResult(state, result.toolCallId, { content: result.content, isError: result.isError === true }, timestamp);
  }
}

/**
 * An assistant message's identity: the creation time both its start and end
 * records carry, else its `responseId`. The time comes first because providers
 * may reuse a response ID across a run's messages.
 */
function messageIdentity(message: JsonRecord): string | null {
  const ms = message.timestamp;
  if (typeof ms === 'number' && Number.isFinite(ms)) return String(ms);
  return typeof message.responseId === 'string' && message.responseId ? `response:${message.responseId}` : null;
}

function messageTimestamp(message: JsonRecord): string | null {
  const ms = message.timestamp;
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Projects one Pi record; returns false when the record is not Pi's. */
export function processPiRecord(event: unknown, fallbackTimestamp: string, state: PiParseState): boolean {
  if (!isPiRecord(event)) return false;
  const record = event as JsonRecord;
  const type = record.type as string;
  if (type === 'session') {
    if (typeof record.timestamp === 'string') state.pi.lastTimestamp = record.timestamp;
    return true;
  }
  if (type === 'message_start' || type === 'message_end') {
    const message = record.message as JsonRecord;
    const own = messageTimestamp(message);
    if (own) state.pi.lastTimestamp = own;
    processMessage(type, message, own ?? timestampFor(state, fallbackTimestamp), state);
    return true;
  }
  const timestamp = timestampFor(state, fallbackTimestamp);
  if (type === 'message_update') processMessageUpdate(record.assistantMessageEvent as JsonRecord, timestamp, state);
  else if (PI_TOOL_EVENT_TYPES.has(type)) processToolExecution(record, timestamp, state);
  else if (type === 'turn_end') processTurnEnd(record, timestamp, state);
  return true;
}

const PI_LINE_PREFIX = /^\s*\{"type":"(?:session|agent_|turn_|message_|tool_execution_|compaction_|auto_retry_|summarization_retry_)/;

/** Pi writes `type` first; the prefix check keeps other agents' lines from being parsed twice. */
export function isPiJsonLine(line: string): boolean {
  if (!PI_LINE_PREFIX.test(line)) return false;
  try {
    return isPiRecord(JSON.parse(line));
  } catch {
    return false;
  }
}
