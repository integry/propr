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

function processVibeEvent(event: VibeTranscriptEvent, timestamp: string, state: ParseState): void {
  if (event.role === 'system') return;

  const usage = event.usage || event.token_usage;
  if (usage) {
    state.tokenUsage.input_tokens += usage.input_tokens ?? 0;
    state.tokenUsage.output_tokens += usage.output_tokens ?? 0;
  }

  if (event.role === 'assistant') {
    const reasoning = textFromValue(event.reasoning_content);
    if (reasoning) state.events.push({ type: 'thought' as const, content: truncateContent(reasoning), timestamp });

    const content = textFromValue(event.content);
    if (content) state.events.push({ type: 'thought' as const, content: truncateContent(content), timestamp });

    for (const toolCall of event.tool_calls || []) {
      state.events.push({
        type: 'tool_use' as const,
        toolName: toolCall.function?.name || 'tool',
        input: parseToolInput(toolCall.function?.arguments),
        id: toolCall.id,
        timestamp
      });
    }
    return;
  }

  if (event.role === 'tool') {
    const result = textFromValue(event.content) || textFromValue(event.result) || textFromValue(event.output) || textFromValue(event.error);
    if (result) {
      state.events.push({
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
        processVibeEvent(event, new Date().toISOString(), state);
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
    const timestamp = event.timestamp || new Date().toISOString();

    if (event.role === 'assistant' || event.role === 'tool' || event.role === 'system' || event.role === 'user') {
      processVibeEvent(event, timestamp, state);
      return;
    }

    // Try Codex event processing first
    if (!processCodexEvent(event, timestamp, state)) {
      // Fall back to Gemini event processing
      processGeminiEvent(event, timestamp, state);
    }
  } catch {
    // Skip non-JSON lines
  }
}

/**
 * Parse Redis output (Codex NDJSON or Gemini JSONL format)
 */
export function parseRedisOutput(lines: string[]): ParsedRedisOutput {
  const state: ParseState = {
    events: [],
    todos: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    pendingAssistantMessage: ''
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
