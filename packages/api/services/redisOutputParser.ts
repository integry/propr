import type { ConversationEvent, TodoItem, TokenUsageInfo } from '@propr/shared';

/** Result from parsing Redis output */
export interface ParsedRedisOutput {
  events: ConversationEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage: TokenUsageInfo | null;
  totalEventCount: number;
}

/** State accumulated while parsing lines */
interface ParseState {
  events: ConversationEvent[];
  todos: TodoItem[];
  tokenUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  pendingAssistantMessage: string;
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
    state.events.push({
      type: 'tool_result' as const,
      toolUseId: event.tool_id,
      result: truncateContent(event.output),
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
 * Process OpenCode JSON stream events.
 */
function processOpenCodeEvent(
  event: {
    type?: string;
    timestamp?: string | number;
    sessionID?: string;
    part?: { type?: string; text?: string; content?: unknown; delta?: string };
    parts?: Array<{ type?: string; text?: string; content?: unknown; delta?: string }>;
    message?: { role?: string; content?: unknown; text?: string; delta?: string; parts?: Array<{ type?: string; text?: string; content?: unknown; delta?: string }> };
    error?: string | { message?: string; name?: string; data?: { message?: string } };
    usage?: Record<string, unknown>;
    stats?: Record<string, unknown>;
    tokens?: Record<string, unknown>;
  },
  timestamp: string,
  state: ParseState
): boolean {
  if (!isOpenCodeEvent(event)) return false;
  const type = event.type?.toLowerCase();
  const assistantText = extractOpenCodeAssistantText(event);
  if (assistantText) {
    if (type === 'delta' || event.part || event.parts?.length) {
      state.pendingAssistantMessage += assistantText;
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

  applyOpenCodeRedisUsage(state, event.usage);
  applyOpenCodeRedisUsage(state, event.stats);
  applyOpenCodeRedisUsage(state, event.tokens);
  return true;
}

function isOpenCodeEvent(event: Parameters<typeof processOpenCodeEvent>[0]): boolean {
  const type = event.type?.toLowerCase();
  return Boolean(
    event.sessionID
    || event.part
    || event.parts?.length
    || event.message
    || type === 'delta'
    || type === 'text'
    || type === 'completion'
    || event.usage
    || event.tokens
  );
}

function extractOpenCodeAssistantText(event: Parameters<typeof processOpenCodeEvent>[0]): string {
  const parts: string[] = [];
  addOpenCodeTextPart(parts, event.part);
  for (const part of event.parts || []) addOpenCodeTextPart(parts, part);
  if (event.message?.role === 'assistant') {
    addOpenCodeTextContainer(parts, event.message);
    for (const part of event.message.parts || []) addOpenCodeTextPart(parts, part);
  }
  if (!parts.length && event.type && ['text', 'assistant', 'message', 'delta', 'completion'].includes(event.type.toLowerCase())) {
    addOpenCodeTextContainer(parts, event as { text?: string; content?: unknown; delta?: string });
  }
  return parts.join('');
}

function addOpenCodeTextPart(parts: string[], part?: { type?: string; text?: string; content?: unknown; delta?: string }): void {
  if (!part) return;
  const partType = part.type?.toLowerCase();
  if (partType && !['text', 'assistant_text', 'message', 'completion'].includes(partType)) return;
  addOpenCodeTextContainer(parts, part);
}

function addOpenCodeTextContainer(parts: string[], container?: { text?: string; content?: unknown; delta?: string }): void {
  if (!container) return;
  const added = new Set<string>();
  for (const value of [container.text, container.delta, container.content]) {
    if (typeof value === 'string' && value && !added.has(value)) {
      parts.push(value);
      added.add(value);
    }
  }
}

function extractOpenCodeError(error: Parameters<typeof processOpenCodeEvent>[0]['error']): string {
  if (typeof error === 'string') return error;
  return error?.data?.message || error?.message || error?.name || 'OpenCode execution failed';
}

function applyOpenCodeRedisUsage(state: ParseState, usage?: Record<string, unknown>): void {
  if (!usage) return;
  const inputTokens = firstUsageNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input', 'prompt']);
  const outputTokens = firstUsageNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output', 'completion']);
  const cacheCreationTokens = firstUsageNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens']);
  const cacheReadTokens = firstUsageNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens', 'cacheReadTokens']);
  state.tokenUsage.input_tokens = Math.max(state.tokenUsage.input_tokens, inputTokens ?? 0);
  state.tokenUsage.output_tokens = Math.max(state.tokenUsage.output_tokens, outputTokens ?? 0);
  state.tokenUsage.cache_creation_input_tokens = Math.max(state.tokenUsage.cache_creation_input_tokens, cacheCreationTokens ?? 0);
  state.tokenUsage.cache_read_input_tokens = Math.max(state.tokenUsage.cache_read_input_tokens, cacheReadTokens ?? 0);
}

function firstUsageNumber(usage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
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

/**
 * Parse a single line of Redis output
 */
function parseLine(line: string, state: ParseState): void {
  try {
    const event = JSON.parse(line);
    const timestamp = event.timestamp || new Date().toISOString();

    // Try Codex event processing first
    if (!processCodexEvent(event, timestamp, state)) {
      if (!processOpenCodeEvent(event, timestamp, state)) {
        processGeminiEvent(event, timestamp, state);
      }
    }
  } catch {
    // Skip non-JSON lines
  }
}

/**
 * Parse Redis output (Codex, Gemini, or OpenCode JSONL format)
 */
export function parseRedisOutput(lines: string[]): ParsedRedisOutput {
  const state: ParseState = {
    events: [],
    todos: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    pendingAssistantMessage: ''
  };

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
