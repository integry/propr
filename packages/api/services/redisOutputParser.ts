/* eslint-disable max-lines */
import type { ConversationEvent, TodoItem, TokenUsageInfo } from '@propr/shared';
import { isOpenCodeJsonlEvent, normalizeOpenCodeTimestamp, normalizeOpenCodeUsage } from '@propr/core';

/** Result from parsing Redis output */
export interface ParsedRedisOutput {
  events: ConversationEvent[]; todos: TodoItem[]; currentTask: string | null; tokenUsage: TokenUsageInfo | null; totalEventCount: number;
}

export interface RedisOutputParseOptions {
  executionStartTimestamp?: string | null;
}

/** State accumulated while parsing lines */
interface ParseState {
  events: ConversationEvent[];
  todos: TodoItem[];
  tokenUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  lastOpenCodeCumulativeTopLevelUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null;
  pendingAssistantMessage: string; pendingAssistantTimestamp: string | null;
  syntheticTimestampBaseMs: number | null;
  syntheticTimestampIndex: number;
  seenEventFingerprints: Set<string>;
  emittedOpenCodeToolUseIds: Set<string>;
  emittedOpenCodeToolResultIds: Set<string>;
}

interface OpenCodeRedisEventUsage {
  topLevel: ParseState['tokenUsage']; nested: ParseState['tokenUsage']; cumulative: boolean;
}

interface OpenCodeRedisEvent {
  type?: string; timestamp?: string | number; sessionID?: string; sessionId?: string; session_id?: string;
  part?: OpenCodeRedisPart; parts?: OpenCodeRedisPart[];
  message?: { role?: string; content?: unknown; text?: string; delta?: string; parts?: OpenCodeRedisPart[]; usage?: Record<string, unknown> };
  response?: { content?: unknown; text?: string; delta?: string; usage?: Record<string, unknown> };
  tool?: string; tool_name?: string; name?: string; input?: Record<string, unknown>; parameters?: Record<string, unknown>; args?: Record<string, unknown>;
  output?: string; result?: string; status?: string; id?: string; callID?: string; tool_id?: string; error?: string | { message?: string; name?: string; data?: { message?: string } };
  usage?: Record<string, unknown>; stats?: Record<string, unknown>; tokens?: Record<string, unknown>;
}

interface VibeToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface VibeTranscriptEvent {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: VibeToolCall[];
  tool_call_id?: string;
  name?: string;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  token_usage?: { input_tokens?: number; output_tokens?: number };
}

/** Max content length for truncation */
const MAX_CONTENT_LENGTH = 2000;
const OPEN_CODE_TOOL_USE_TYPES = ['tool_use', 'tool', 'tool_call'];
const OPEN_CODE_TOOL_RESULT_TYPES = ['tool_result', 'tool_response'];

/**
 * Truncate long content strings
 */
function truncateContent(content: string | undefined): string {
  if (!content) return '';
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return content.substring(0, MAX_CONTENT_LENGTH) + '... [truncated]';
}

/**
 * Parse todo items array to TodoItem[]
 */
function parseTodoItems(items: Array<{ text: string; completed: boolean }>): TodoItem[] {
  return items.map((t, i) => ({ id: `todo-${i}`, content: t.text, status: t.completed ? 'completed' as const : 'pending' as const }));
}

/**
 * Process Codex item.completed event
 */
function processCodexItem(
  item: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: Array<{ kind: string; path: string }>; items?: Array<{ text: string; completed: boolean }> },
  timestamp: string,
  events: ConversationEvent[]
): TodoItem[] | null {
  switch (item.type) {
    case 'reasoning':
      if (item.text) {
        events.push({ type: 'thought' as const, content: item.text, timestamp });
      }
      break;
    case 'command_execution':
      events.push({ type: 'tool_use' as const, toolName: 'Bash', input: { command: item.command }, timestamp });
      if (item.aggregated_output) {
        events.push({ type: 'tool_result' as const, result: truncateContent(item.aggregated_output), isError: item.exit_code !== 0, timestamp });
      }
      break;
    case 'file_change':
      if (item.changes) {
        const changesList = item.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
        events.push({ type: 'tool_use' as const, toolName: 'FileChange', input: { changes: item.changes }, timestamp });
        events.push({ type: 'tool_result' as const, result: changesList, isError: false, timestamp });
      }
      break;
    case 'agent_message':
      if (item.text) {
        events.push({ type: 'thought' as const, content: `**Result:** ${item.text}`, timestamp });
      }
      break;
    case 'todo_list':
      if (item.items) {
        return parseTodoItems(item.items);
      }
      break;
  }
  return null;
}

/**
 * Process Codex events (item.completed, item.updated, turn.completed)
 */
function processCodexEvent(
  event: { type?: string; item?: { type?: string; items?: Array<{ text: string; completed: boolean }> }; usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } },
  timestamp: string,
  state: ParseState
): boolean {
  if (event.type === 'item.completed' && event.item) {
    const item = event.item as { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: Array<{ kind: string; path: string }>; items?: Array<{ text: string; completed: boolean }> };
    const updatedTodos = processCodexItem(item, timestamp, state.events);
    if (updatedTodos) state.todos = updatedTodos;
    return true;
  }
  if (event.type === 'item.updated' && event.item?.type === 'todo_list' && event.item?.items) {
    state.todos = parseTodoItems(event.item.items);
    return true;
  }
  if (event.type === 'turn.completed' && event.usage) {
    state.tokenUsage.input_tokens += (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
    state.tokenUsage.output_tokens += event.usage.output_tokens ?? 0;
    return true;
  }
  if (event.type === 'result' && event.usage) {
    state.tokenUsage.input_tokens += (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
    state.tokenUsage.output_tokens += event.usage.output_tokens ?? 0;
    return true;
  }
  return false;
}

/**
 * Process Gemini events (message, tool_use, tool_result, result)
 */
function processGeminiEvent(
  event: { type?: string; role?: string; delta?: boolean; content?: string; tool_name?: string; parameters?: unknown; tool_id?: string; output?: string; status?: string; stats?: { input_tokens?: number; output_tokens?: number } },
  timestamp: string,
  state: ParseState
): void {
  if (event.type === 'message' && event.role === 'assistant') {
    if (event.delta) {
      state.pendingAssistantMessage += event.content || '';
      if (event.content) state.pendingAssistantTimestamp ??= timestamp;
    } else {
      flushPendingMessage(state, timestamp);
      if (event.content) {
        state.events.push({ type: 'thought' as const, content: event.content, timestamp });
      }
    }
    return;
  }
  if (event.type === 'tool_use') {
    flushPendingMessage(state, timestamp);
    state.events.push({ type: 'tool_use' as const, toolName: event.tool_name, input: event.parameters as Record<string, unknown> | undefined, id: event.tool_id, timestamp });
    return;
  }
  if (event.type === 'tool_result') {
    state.events.push({ type: 'tool_result' as const, toolUseId: event.tool_id, result: truncateContent(event.output), isError: event.status === 'error', timestamp });
    return;
  }
  if (event.type === 'result' && event.stats) {
    flushPendingMessage(state, timestamp);
    state.tokenUsage.input_tokens += event.stats.input_tokens ?? 0;
    state.tokenUsage.output_tokens += event.stats.output_tokens ?? 0;
  }
}

/**
 * Process OpenCode JSON stream events.
 */
function processOpenCodeEvent(
  event: OpenCodeRedisEvent,
  timestamp: string,
  state: ParseState
): boolean {
  if (!isOpenCodeEvent(event)) return false;
  const type = event.type?.toLowerCase();
  const assistantText = extractOpenCodeAssistantText(event);
  if (assistantText) {
    if (type === 'delta' || event.part || event.parts?.length) {
      state.pendingAssistantMessage += assistantText;
      state.pendingAssistantTimestamp ??= timestamp;
    } else {
      flushPendingMessage(state, timestamp);
      state.events.push({ type: 'thought' as const, content: assistantText, timestamp });
    }
  }

  if (type === 'error' || event.error) {
    flushPendingMessage(state, timestamp);
    state.events.push({
      type: 'tool_result' as const,
      result: extractOpenCodeError(event.error),
      isError: true,
      timestamp
    });
  }
  const toolEvents = extractOpenCodeToolEvents(event, timestamp, state);
  if (toolEvents.length) {
    flushPendingMessage(state, timestamp);
    state.events.push(...toolEvents);
  }

  const eventUsage = buildOpenCodeRedisEventUsage(event);
  if (eventUsage) addOpenCodeRedisUsage(state, eventUsage);
  return true;
}

interface OpenCodeRedisPart {
  type?: string; text?: string; content?: unknown; delta?: string; callID?: string; tokens?: Record<string, unknown>;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: unknown; metadata?: { output?: string; exit?: number } };
  tool?: string; tool_name?: string; name?: string;
  input?: Record<string, unknown>; parameters?: Record<string, unknown>; args?: Record<string, unknown>;
  output?: string; result?: string; status?: string; id?: string; tool_id?: string;
}

type OpenCodeRedisToolSource = OpenCodeRedisEvent & Pick<OpenCodeRedisPart, 'callID' | 'state'>;

function isOpenCodeEvent(event: OpenCodeRedisEvent): boolean {
  return isOpenCodeJsonlEvent(event) || hasOpenCodeToolShape(event);
}

function hasOpenCodeToolShape(event: OpenCodeRedisEvent): boolean {
  if (hasOpenCodeToolSourceShape(event)) return true;
  if (hasOpenCodeToolSourceShape(event.part)) return true;
  return (event.parts ?? []).some(hasOpenCodeToolSourceShape);
}

function hasOpenCodeToolSourceShape(source: (OpenCodeRedisEvent | OpenCodeRedisPart) | undefined): boolean {
  if (!source) return false;
  const type = source?.type?.toLowerCase();
  if (!type || (!isOpenCodeToolUseType(type) && !isOpenCodeToolResultType(type))) return false;
  const toolSource = source as OpenCodeRedisToolSource;
  return Boolean(
    toolSource.callID
    || toolSource.tool_id
    || toolSource.id
    || toolSource.tool
    || toolSource.tool_name
    || toolSource.name
    || toolSource.state
  );
}

function extractOpenCodeAssistantText(event: OpenCodeRedisEvent): string {
  if (event.message?.role && event.message.role !== 'assistant') return '';
  const topLevelParts: string[] = [];
  addOpenCodeTextPart(topLevelParts, event.part);
  for (const part of event.parts || []) addOpenCodeTextPart(topLevelParts, part);
  const messageParts: string[] = [];
  if (event.message?.role === 'assistant') {
    if (event.message.parts?.length) {
      for (const part of event.message.parts) addOpenCodeTextPart(messageParts, part);
    } else {
      addOpenCodeTextContainer(messageParts, event.message);
    }
  }
  if (!topLevelParts.length && !messageParts.length && event.type && ['text', 'assistant', 'message', 'delta', 'completion'].includes(event.type.toLowerCase())) {
    addOpenCodeTextContainer(topLevelParts, event as { text?: string; content?: unknown; delta?: string });
  }
  if (event.type && ['text', 'assistant', 'message', 'delta', 'completion'].includes(event.type.toLowerCase())) addOpenCodeTextContainer(topLevelParts, event.response);
  return joinOpenCodeTextGroups(topLevelParts, messageParts);
}

function addOpenCodeTextPart(parts: string[], part?: { type?: string; text?: string; content?: unknown; delta?: string }): void {
  if (!part) return;
  const partType = part.type?.toLowerCase();
  if (partType && !['text', 'assistant_text', 'message', 'completion', 'reasoning'].includes(partType)) return;
  addOpenCodeTextContainer(parts, part);
}

function addOpenCodeTextContainer(parts: string[], container?: { text?: string; content?: unknown; delta?: string }): void {
  if (!container) return;
  for (const value of [container.text, container.delta, container.content]) {
    if (typeof value === 'string' && value && !parts.includes(value)) {
      parts.push(value);
    }
  }
}

function extractOpenCodeError(error: OpenCodeRedisEvent['error']): string {
  if (typeof error === 'string') return error;
  return error?.data?.message || error?.message || error?.name || 'OpenCode execution failed';
}

function buildOpenCodeRedisEventUsage(event: OpenCodeRedisEvent): OpenCodeRedisEventUsage | null {
  const topLevelUsage = emptyRedisTokenUsage();
  const nestedUsage = emptyRedisTokenUsage();
  mergeOpenCodeRedisUsageByMax(topLevelUsage, event.usage);
  mergeOpenCodeRedisUsageByMax(topLevelUsage, event.stats);
  mergeOpenCodeRedisUsageByMax(topLevelUsage, event.tokens);
  mergeOpenCodeRedisUsageByMax(topLevelUsage, event.part?.tokens);
  mergeOpenCodeRedisUsageByMax(nestedUsage, event.message?.usage);
  mergeOpenCodeRedisUsageByMax(nestedUsage, event.response?.usage);
  return hasRedisTokenUsage(topLevelUsage) || hasRedisTokenUsage(nestedUsage)
    ? { topLevel: topLevelUsage, nested: nestedUsage, cumulative: event.type?.toLowerCase() === 'result' }
    : null;
}

function emptyRedisTokenUsage(): ParseState['tokenUsage'] {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function mergeOpenCodeRedisUsageByMax(target: ParseState['tokenUsage'], usage?: Record<string, unknown>): void {
  const normalized = normalizeOpenCodeUsage(usage);
  if (!normalized) return;
  target.input_tokens = Math.max(target.input_tokens, normalized.input_tokens ?? 0);
  target.output_tokens = Math.max(target.output_tokens, normalized.output_tokens ?? 0);
  target.cache_creation_input_tokens = Math.max(target.cache_creation_input_tokens, normalized.cache_creation_input_tokens ?? 0);
  target.cache_read_input_tokens = Math.max(target.cache_read_input_tokens, normalized.cache_read_input_tokens ?? 0);
}

function addOpenCodeRedisUsage(state: ParseState, usage: OpenCodeRedisEventUsage): void {
  if (hasRedisTokenUsage(usage.nested)) addRedisTokenUsage(state.tokenUsage, usage.nested);
  if (hasRedisTokenUsage(usage.topLevel)) {
    const previousUsage = state.lastOpenCodeCumulativeTopLevelUsage;
    if (usage.cumulative || isCumulativeRedisUsageSnapshot(usage.topLevel, previousUsage)) {
      mergeRedisTokenUsageByMax(state.tokenUsage, usage.topLevel);
      state.lastOpenCodeCumulativeTopLevelUsage = usage.topLevel;
    } else {
      addRedisTokenUsage(state.tokenUsage, usage.topLevel);
    }
  }
}

function hasOpenCodeSessionId(event: OpenCodeRedisEvent): boolean {
  return Boolean(event.sessionID || event.sessionId || event.session_id);
}

interface OpenCodeRedisToolTracker {
  emittedToolUseIds: Set<string>;
  emittedToolResultIds: Set<string>;
}

function extractOpenCodeToolEvents(event: OpenCodeRedisEvent, timestamp: string, state: ParseState): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const tracker: OpenCodeRedisToolTracker = {
    emittedToolUseIds: state.emittedOpenCodeToolUseIds,
    emittedToolResultIds: state.emittedOpenCodeToolResultIds
  };
  if (!event.part) appendOpenCodeToolEvent(events, event, timestamp, tracker);
  appendOpenCodeToolEvent(events, event.part, timestamp, tracker);
  for (const part of event.parts ?? []) appendOpenCodeToolEvent(events, part, timestamp, tracker);
  return events;
}

function appendOpenCodeToolEvent(events: ConversationEvent[], source: (OpenCodeRedisEvent | OpenCodeRedisPart) | undefined, timestamp: string, tracker: OpenCodeRedisToolTracker): void {
  if (!source?.type) return;
  const type = source.type.toLowerCase();
  const sourceWithState = source as OpenCodeRedisToolSource;
  if (isOpenCodeToolResultType(type)) {
    appendOpenCodeToolResultEvent(events, sourceWithState, timestamp, tracker.emittedToolResultIds);
    return;
  }
  if (!isOpenCodeToolUseType(type)) return;
  const toolId = getOpenCodeToolId(sourceWithState);
  if (toolId && tracker.emittedToolUseIds.has(toolId)) return;
  if (toolId) tracker.emittedToolUseIds.add(toolId);
  events.push(buildOpenCodeToolUseEvent(sourceWithState, timestamp));
  if (type === 'tool') appendOpenCodeCompletedToolResult(events, sourceWithState, timestamp, tracker.emittedToolResultIds);
}

function isOpenCodeToolUseType(type: string): boolean { return OPEN_CODE_TOOL_USE_TYPES.includes(type); }

function isOpenCodeToolResultType(type: string): boolean { return OPEN_CODE_TOOL_RESULT_TYPES.includes(type); }

function buildOpenCodeToolUseEvent(source: OpenCodeRedisToolSource, timestamp: string): ConversationEvent {
  return { type: 'tool_use' as const, toolName: source.tool_name || source.tool || source.name, input: source.parameters || source.input || source.args || source.state?.input, id: getOpenCodeToolId(source), timestamp };
}

function appendOpenCodeCompletedToolResult(events: ConversationEvent[], source: OpenCodeRedisToolSource, timestamp: string, emittedToolResultIds: Set<string>): void {
  if (!source.state || !['completed', 'error'].includes(source.state.status ?? '')) return;
  const toolId = getOpenCodeToolId(source);
  if (toolId && emittedToolResultIds.has(toolId)) return;
  if (toolId) emittedToolResultIds.add(toolId);
  events.push({ type: 'tool_result' as const, toolUseId: getOpenCodeToolId(source), result: truncateContent(extractOpenCodeToolResult(source)), isError: isOpenCodeToolStateError(source), timestamp });
}

function appendOpenCodeToolResultEvent(events: ConversationEvent[], source: OpenCodeRedisToolSource, timestamp: string, emittedToolResultIds: Set<string>): void {
  const toolId = getOpenCodeToolId(source);
  if (toolId && emittedToolResultIds.has(toolId)) return;
  if (toolId) emittedToolResultIds.add(toolId);
  events.push({ type: 'tool_result' as const, toolUseId: toolId, result: truncateContent(source.output || source.result), isError: source.status === 'error', timestamp });
}

function getOpenCodeToolId(source: OpenCodeRedisToolSource): string | undefined { return source.tool_id || source.callID || source.id; }

function extractOpenCodeToolResult(source: OpenCodeRedisToolSource): string {
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

function isOpenCodeToolStateError(source: OpenCodeRedisToolSource): boolean {
  if (source.state?.status === 'error' || source.status === 'error') return true;
  return typeof source.state?.metadata?.exit === 'number' && source.state.metadata.exit !== 0;
}

function joinOpenCodeTextGroups(first: string[], second: string[]): string {
  const firstText = first.join('');
  const secondText = second.join('');
  if (!firstText) return secondText;
  if (!secondText || firstText === secondText) return firstText;
  return `${firstText}${secondText}`;
}

function addRedisTokenUsage(target: ParseState['tokenUsage'], usage: ParseState['tokenUsage']): ParseState['tokenUsage'] {
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens;
  target.cache_read_input_tokens += usage.cache_read_input_tokens;
  return target;
}

function mergeRedisTokenUsageByMax(target: ParseState['tokenUsage'], usage: ParseState['tokenUsage']): void {
  target.input_tokens = Math.max(target.input_tokens, usage.input_tokens);
  target.output_tokens = Math.max(target.output_tokens, usage.output_tokens);
  target.cache_creation_input_tokens = Math.max(target.cache_creation_input_tokens, usage.cache_creation_input_tokens);
  target.cache_read_input_tokens = Math.max(target.cache_read_input_tokens, usage.cache_read_input_tokens);
}

function isCumulativeRedisUsageSnapshot(current: ParseState['tokenUsage'], previous: ParseState['tokenUsage'] | null): boolean {
  if (!previous || !hasRedisTokenUsage(previous)) return false;
  const fields: Array<keyof ParseState['tokenUsage']> = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  let hasIncrease = false;
  for (const field of fields) {
    if (current[field] < previous[field]) return false;
    if (current[field] > previous[field]) hasIncrease = true;
  }
  return hasIncrease;
}

function hasRedisTokenUsage(usage: ParseState['tokenUsage']): boolean {
  return usage.input_tokens > 0
    || usage.output_tokens > 0
    || usage.cache_creation_input_tokens > 0
    || usage.cache_read_input_tokens > 0;
}

/**
 * Flush pending assistant message to events
 */
function flushPendingMessage(state: ParseState, timestamp: string): void {
  if (state.pendingAssistantMessage) {
    state.events.push({ type: 'thought' as const, content: state.pendingAssistantMessage, timestamp: state.pendingAssistantTimestamp ?? timestamp });
    state.pendingAssistantMessage = '';
    state.pendingAssistantTimestamp = null;
  }
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

function getNextSyntheticTimestamp(state: ParseState): string {
  if (state.syntheticTimestampBaseMs === null) return new Date().toISOString();
  const timestamp = new Date(state.syntheticTimestampBaseMs + state.syntheticTimestampIndex * 1000).toISOString();
  state.syntheticTimestampIndex += 1;
  return timestamp;
}

function pushEvent(state: ParseState, event: ConversationEvent): void {
  const fingerprint = JSON.stringify({
    type: event.type,
    content: event.content,
    toolName: event.toolName,
    input: event.input,
    toolUseId: event.toolUseId,
    result: event.result,
    isError: event.isError
  });
  if (state.seenEventFingerprints.has(fingerprint)) return;
  state.seenEventFingerprints.add(fingerprint);
  state.events.push(event);
}

function processVibeAssistantEvent(event: VibeTranscriptEvent, timestamp: string, state: ParseState): void {
  const reasoning = textFromValue(event.reasoning_content);
  if (reasoning) pushEvent(state, { type: 'thought' as const, content: truncateContent(reasoning), timestamp });

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

function processVibeEvent(event: VibeTranscriptEvent, timestamp: string, state: ParseState): void {
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

function parseVibeTranscriptOutput(output: string, state: ParseState): boolean {
  const objects = extractCompleteJsonObjectsFromArray(output);
  if (objects.length === 0) return false;

  let handled = false;
  for (const objectText of objects) {
    try {
      const event = JSON.parse(objectText) as VibeTranscriptEvent;
      if (event.role === 'assistant' || event.role === 'tool' || event.role === 'system' || event.role === 'user') {
        processVibeEvent(event, getNextSyntheticTimestamp(state), state);
        handled = true;
      }
    } catch {
      // Ignore incomplete or malformed objects; later Redis updates may complete them.
    }
  }
  return handled;
}

/**
 * Parse a single line of Redis output
 */
function parseLine(line: string, state: ParseState): void {
  try {
    const event = JSON.parse(line);
    if (event.role === 'assistant' || event.role === 'tool' || event.role === 'system' || event.role === 'user') {
      const timestamp = event.timestamp || getNextSyntheticTimestamp(state);
      processVibeEvent(event, timestamp, state);
      return;
    }

    const timestamp = normalizeEventTimestamp(event.timestamp);

    if (shouldProcessOpenCodeBeforeCodex(event) && processOpenCodeEvent(event, timestamp, state)) return;
    if (!processCodexEvent(event, timestamp, state)) {
      if (!processOpenCodeEvent(event, timestamp, state)) {
        processGeminiEvent(event, timestamp, state);
      }
    }
  } catch {
    // Skip non-JSON lines
  }
}

function normalizeEventTimestamp(timestamp: unknown): string {
  return normalizeOpenCodeTimestamp(timestamp, new Date().toISOString());
}

function shouldProcessOpenCodeBeforeCodex(event: OpenCodeRedisEvent): boolean {
  return hasOpenCodeSessionId(event) && isOpenCodeEvent(event);
}

/**
 * Parse Redis output (Codex, Gemini, or OpenCode JSONL format)
 */
export function parseRedisOutput(lines: string[], options: RedisOutputParseOptions = {}): ParsedRedisOutput {
  const executionStartMs = options.executionStartTimestamp ? new Date(options.executionStartTimestamp).getTime() : NaN;
  const state: ParseState = {
    events: [],
    todos: [],
    tokenUsage: emptyRedisTokenUsage(),
    lastOpenCodeCumulativeTopLevelUsage: null,
    pendingAssistantMessage: '',
    pendingAssistantTimestamp: null,
    syntheticTimestampBaseMs: Number.isNaN(executionStartMs) ? null : executionStartMs,
    syntheticTimestampIndex: 0,
    seenEventFingerprints: new Set(),
    emittedOpenCodeToolUseIds: new Set(),
    emittedOpenCodeToolResultIds: new Set()
  };

  if (parseVibeTranscriptOutput(lines.join('\n'), state)) {
    const hasTokens = state.tokenUsage.input_tokens > 0 || state.tokenUsage.output_tokens > 0;
    return {
      events: state.events,
      todos: state.todos,
      currentTask: null,
      tokenUsage: hasTokens ? state.tokenUsage : null,
      totalEventCount: state.events.length
    };
  }

  for (const line of lines) {
    parseLine(line, state);
  }

  // Flush any remaining pending message
  flushPendingMessage(state, new Date().toISOString());

  const inProgressTask = state.todos.find(t => t.status === 'in_progress');
  const hasTokens = hasRedisTokenUsage(state.tokenUsage);

  return { events: state.events, todos: state.todos, currentTask: inProgressTask ? inProgressTask.content : null, tokenUsage: hasTokens ? state.tokenUsage : null, totalEventCount: state.events.length };
}
