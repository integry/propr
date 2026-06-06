import type { ConversationEvent, TodoItem, TokenUsageInfo } from '@propr/shared';
import { parseVibeTranscriptOutput, processVibeEvent } from './redisOutputParserVibe.js';

/** Result from parsing Redis output */
export interface ParsedRedisOutput {
  events: ConversationEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage: TokenUsageInfo | null;
  totalEventCount: number;
}

export interface RedisOutputParseOptions {
  executionStartTimestamp?: string | null;
}

/** State accumulated while parsing lines */
interface ParseState {
  events: ConversationEvent[];
  todos: TodoItem[];
  tokenUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  pendingAssistantMessage: string;
  antigravityStreamActive: boolean;
  syntheticTimestampBaseMs: number | null;
  syntheticTimestampIndex: number;
  seenEventFingerprints: Set<string>;
}

interface CodexEvent {
  type?: string;
  role?: string;
  content?: unknown;
  tool?: string;
  params?: unknown;
  message?: string;
  result?: unknown;
  is_error?: boolean;
  status?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  changes?: Array<{ kind: string; path: string }>;
  items?: Array<{ text: string; completed: boolean }>;
}

/** Max content length for truncation */
const MAX_CONTENT_LENGTH = 2000;

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
  return items.map((t, i) => ({
    id: `todo-${i}`,
    content: t.text,
    status: t.completed ? 'completed' as const : 'pending' as const
  }));
}

/**
 * Process Codex item.completed event
 */
function processCodexItem(
  item: CodexItem,
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
        events.push({
          type: 'tool_result' as const,
          result: truncateContent(item.aggregated_output),
          isError: item.exit_code !== 0,
          timestamp
        });
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
function processCodexMessage(event: CodexEvent, timestamp: string, state: ParseState): boolean {
  if (event.role !== 'assistant') return false;
  const content = textFromValue(event.content);
  if (content) state.events.push({ type: 'thought' as const, content: truncateContent(content), timestamp });
  return true;
}

function processCodexToolUse(event: CodexEvent, timestamp: string, state: ParseState): boolean {
  if (!event.tool) return false;
  state.events.push({
    type: 'tool_use' as const,
    toolName: event.tool,
    input: event.params as Record<string, unknown> | undefined,
    timestamp
  });
  return true;
}

function processCodexToolResult(event: CodexEvent, timestamp: string, state: ParseState): boolean {
  state.events.push({
    type: 'tool_result' as const,
    result: truncateContent(textFromValue(event.message) || textFromValue(event.result) || textFromValue(event.content) || 'Execution error'),
    isError: event.type === 'error' || Boolean(event.is_error) || event.status === 'error',
    timestamp
  });
  return true;
}

function processCodexItemCompleted(event: CodexEvent, timestamp: string, state: ParseState): boolean {
  if (!event.item) return false;
  const updatedTodos = processCodexItem(event.item, timestamp, state.events);
  if (updatedTodos) state.todos = updatedTodos;
  return true;
}

function processCodexItemUpdated(event: CodexEvent, _timestamp: string, state: ParseState): boolean {
  if (event.item?.type !== 'todo_list' || !event.item.items) return false;
  state.todos = parseTodoItems(event.item.items);
  return true;
}

function processCodexTurnCompleted(event: CodexEvent, _timestamp: string, state: ParseState): boolean {
  if (!event.usage) return false;
  state.tokenUsage.input_tokens += (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
  state.tokenUsage.output_tokens += event.usage.output_tokens ?? 0;
  return true;
}

function processCodexEvent(event: CodexEvent, timestamp: string, state: ParseState): boolean {
  switch (event.type) {
    case 'message':
      return processCodexMessage(event, timestamp, state);
    case 'tool_use':
      return processCodexToolUse(event, timestamp, state);
    case 'error':
    case 'tool_result':
      return processCodexToolResult(event, timestamp, state);
    case 'result':
      return true;
    case 'item.completed':
      return processCodexItemCompleted(event, timestamp, state);
    case 'item.updated':
      return processCodexItemUpdated(event, timestamp, state);
    case 'turn.completed':
      return processCodexTurnCompleted(event, timestamp, state);
    default:
      return false;
  }
}

/**
 * Process Antigravity events (message, tool_use, tool_result, result)
 */
function processAntigravityEvent(
  event: { type?: string; role?: string; delta?: boolean; content?: string; tool_name?: string; parameters?: unknown; tool_id?: string; output?: string; result?: unknown; status?: string; stats?: { input_tokens?: number; output_tokens?: number } },
  timestamp: string,
  state: ParseState
): void {
  if (event.type === 'message' && event.role === 'assistant') {
    if (event.delta) {
      state.pendingAssistantMessage += event.content || '';
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
    state.events.push({
      type: 'tool_use' as const,
      toolName: event.tool_name,
      input: event.parameters as Record<string, unknown> | undefined,
      id: event.tool_id,
      timestamp
    });
    return;
  }
  if (event.type === 'tool_result') {
    const result = textFromValue(event.output) || textFromValue(event.result) || '';
    state.events.push({
      type: 'tool_result' as const,
      toolUseId: event.tool_id,
      result: truncateContent(result),
      isError: event.status === 'error',
      timestamp
    });
    return;
  }
  if (event.type === 'result' && event.stats) {
    flushPendingMessage(state, timestamp);
    state.tokenUsage.input_tokens += event.stats.input_tokens ?? 0;
    state.tokenUsage.output_tokens += event.stats.output_tokens ?? 0;
  }
}

/**
 * Flush pending assistant message to events
 */
function flushPendingMessage(state: ParseState, timestamp: string): void {
  if (state.pendingAssistantMessage) {
    state.events.push({ type: 'thought' as const, content: state.pendingAssistantMessage, timestamp });
    state.pendingAssistantMessage = '';
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

function getNextSyntheticTimestamp(state: ParseState): string {
  if (state.syntheticTimestampBaseMs === null) return new Date().toISOString();
  const timestamp = new Date(state.syntheticTimestampBaseMs + state.syntheticTimestampIndex * 1000).toISOString();
  state.syntheticTimestampIndex += 1;
  return timestamp;
}

function hasAntigravityModelMetadata(event: { model?: unknown }): boolean {
  return typeof event.model === 'string' && event.model.trim().length > 0;
}

function isAntigravityStreamEvent(
  event: {
    type?: string;
    model?: unknown;
    tool_name?: unknown;
    parameters?: unknown;
    tool_id?: unknown;
    output?: unknown;
  },
  state: ParseState
): boolean {
  if (event.type === 'init') {
    return hasAntigravityModelMetadata(event);
  }
  if (state.antigravityStreamActive) {
    return event.type === 'message'
      || event.type === 'tool_use'
      || event.type === 'tool_result'
      || event.type === 'result';
  }
  if ((event.type === 'message' || event.type === 'result') && hasAntigravityModelMetadata(event)) {
    return true;
  }
  if (event.type === 'tool_use') {
    return typeof event.tool_name === 'string'
      || event.parameters !== undefined
      || typeof event.tool_id === 'string';
  }
  if (event.type === 'tool_result') {
    return typeof event.tool_id === 'string' || event.output !== undefined;
  }
  return false;
}

/**
 * Parse a single line of Redis output
 */
function parseLine(line: string, state: ParseState): void {
  try {
    const event = JSON.parse(line);
    const timestamp = event.timestamp || getNextSyntheticTimestamp(state);

    if (isAntigravityStreamEvent(event, state)) {
      state.antigravityStreamActive = true;
      processAntigravityEvent(event, timestamp, state);
      return;
    }

    // Try Codex event processing first
    if (!processCodexEvent(event, timestamp, state)) {
      if (event.role === 'assistant' || event.role === 'tool' || event.role === 'system' || event.role === 'user') {
        processVibeEvent(event, timestamp, state);
        return;
      }
      // Fall back to Antigravity stream event processing
      processAntigravityEvent(event, timestamp, state);
    }
  } catch {
    // Skip non-JSON lines
  }
}

/**
 * Parse Redis output (Codex NDJSON or Antigravity JSONL format)
 */
export function parseRedisOutput(lines: string[], options: RedisOutputParseOptions = {}): ParsedRedisOutput {
  const executionStartMs = options.executionStartTimestamp ? new Date(options.executionStartTimestamp).getTime() : NaN;
  const state: ParseState = {
    events: [],
    todos: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    pendingAssistantMessage: '',
    antigravityStreamActive: false,
    syntheticTimestampBaseMs: Number.isNaN(executionStartMs) ? null : executionStartMs,
    syntheticTimestampIndex: 0,
    seenEventFingerprints: new Set()
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
  const hasTokens = state.tokenUsage.input_tokens > 0 || state.tokenUsage.output_tokens > 0;

  return {
    events: state.events,
    todos: state.todos,
    currentTask: inProgressTask ? inProgressTask.content : null,
    tokenUsage: hasTokens ? state.tokenUsage : null,
    totalEventCount: state.events.length
  };
}
