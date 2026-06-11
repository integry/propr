import {
  appendClaudeAssistantMessageEvents,
  appendClaudeUserMessageEvents,
  deriveCurrentTask,
  mapTodoItems,
  type ClaudeMessageContent,
  type ClaudeMessageContext,
  type ConversationResult,
  type PendingSubagent,
  type TodoItem
} from './liveDetailsCodexParser.js';

export interface ExecutionDetailRow { event_type: string; event_timestamp: string; content: string | null; is_error: number | boolean | null; tool_name: string | null; tool_input: string | null; metadata: string | null; }
interface RawExecutionEvent {
  type?: string; role?: string; content?: unknown; tool?: string; params?: { file_path?: string; command?: string }; message?: string; result?: string;
  source?: string;
  item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean; status?: string }> };
}

export function parseExecutionDetailsRows(details: ExecutionDetailRow[]): Omit<ConversationResult, 'tokenUsage'> {
  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const pendingSubagents = new Map<string, PendingSubagent>();
  for (const row of details) {
    const timestamp = row.event_timestamp;
    const metadataHandled = appendEventFromMetadata(row, { timestamp, events, pendingSubagents, setTodos: nextTodos => { todos = nextTodos; } });
    if (metadataHandled) continue;
    if (appendStoredMessageEvent(row, { timestamp, events, pendingSubagents, setTodos: nextTodos => { todos = nextTodos; } })) continue;
    if (appendToolUseEvent(row, timestamp, events)) continue;
    if (appendErrorEvent(row, timestamp, events)) continue;
    appendFallbackContentEvent(row, timestamp, events);
  }
  const currentTask = deriveCurrentTask(todos);
  return { events, todos, currentTask };
}

function appendModelSourceEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if (rawEvent.source !== 'MODEL') return false;
  if (rawEvent.type === 'PLANNER_RESPONSE' && typeof rawEvent.content === 'string' && rawEvent.content.trim()) {
    context.events.push({ type: 'thought', content: rawEvent.content, timestamp: context.timestamp });
  }
  return true;
}

function appendRawItemEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if ((rawEvent.item?.type === 'reasoning' || rawEvent.item?.type === 'agent_message') && rawEvent.item.text) {
    context.events.push({ type: 'thought', content: rawEvent.item.text, timestamp: context.timestamp });
    return true;
  }
  if (rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
    context.setTodos(mapTodoItems(rawEvent.item.items));
    return true;
  }
  return false;
}

function appendRawEventByType(rawEvent: RawExecutionEvent, row: ExecutionDetailRow, context: ClaudeMessageContext): boolean {
  if (rawEvent.type === 'tool_use') {
    context.events.push({ type: 'tool_use', toolName: rawEvent.tool, input: rawEvent.params, timestamp: context.timestamp });
    return true;
  }
  if (rawEvent.type === 'error') {
    context.events.push({ type: 'tool_result', result: rawEvent.message || rawEvent.result || row.content || 'Execution error', isError: true, timestamp: context.timestamp });
    return true;
  }
  return false;
}

function appendEventFromMetadata(row: ExecutionDetailRow, context: ClaudeMessageContext): boolean {
  if (!row.metadata) return false;
  try {
    const rawEvent = JSON.parse(row.metadata) as RawExecutionEvent;
    if (appendModelSourceEvent(rawEvent, context)) return true;
    if (rawEvent.source === 'USER_EXPLICIT' || rawEvent.source === 'SYSTEM') return true;
    if (appendMetadataMessageEvent(rawEvent, context)) return true;
    if (appendRawEventByType(rawEvent, row, context)) return true;
    if (appendCommandExecutionEvents(rawEvent, context.timestamp, context.events)) return true;
    return appendRawItemEvent(rawEvent, context);
  } catch (error) {
    console.error('[live-details] Failed to parse execution detail metadata:', error);
  }
  return false;
}

function appendMetadataMessageEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if (rawEvent.type !== 'message' || !rawEvent.content) return false;
  if (rawEvent.role === 'assistant') {
    if (typeof rawEvent.content === 'string') {
      context.events.push({ type: 'thought', content: rawEvent.content, timestamp: context.timestamp });
      return true;
    }
    const assistantContent = extractMessageContentBlocks(rawEvent.content);
    return assistantContent ? appendClaudeAssistantMessageEvents(assistantContent, context) : false;
  }
  if (rawEvent.role === 'user') {
    const userContent = extractMessageContentBlocks(rawEvent.content);
    return userContent ? appendClaudeUserMessageEvents(userContent, context) : false;
  }
  return false;
}

function extractMessageContentBlocks(content: unknown): ClaudeMessageContent[] | null {
  if (Array.isArray(content)) return content as ClaudeMessageContent[];
  if (content && typeof content === 'object' && Array.isArray((content as { content?: unknown }).content)) {
    return (content as { content: ClaudeMessageContent[] }).content;
  }
  return null;
}

function appendStoredMessageEvent(row: ExecutionDetailRow, context: ClaudeMessageContext): boolean {
  if ((row.event_type !== 'user' && row.event_type !== 'assistant') || !row.content) return false;
  try {
    const contentBlocks = (JSON.parse(row.content) as { content?: ClaudeMessageContent[] }).content;
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return false;
    if (row.event_type === 'assistant') return appendClaudeAssistantMessageEvents(contentBlocks, context);
    return appendClaudeUserMessageEvents(contentBlocks, context);
  } catch {
    return false;
  }
}

function appendCommandExecutionEvents(rawEvent: RawExecutionEvent, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (rawEvent.item?.type !== 'command_execution') return false;
  if (rawEvent.item.command) events.push({ type: 'tool_use', toolName: 'command_execution', input: { command: rawEvent.item.command }, timestamp });
  if (rawEvent.item.aggregated_output) events.push({
    type: 'tool_result', result: rawEvent.item.aggregated_output, isError: rawEvent.item.exit_code != null && rawEvent.item.exit_code !== 0, timestamp
  });
  return true;
}

function parseToolInput(toolInput: string | null): { file_path?: string; command?: string } | undefined {
  if (!toolInput) return undefined;
  try { return JSON.parse(toolInput) as { file_path?: string; command?: string }; } catch { return undefined; }
}

function appendToolUseEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (row.event_type !== 'tool_use' || !row.tool_name) return false;
  events.push({ type: 'tool_use', toolName: row.tool_name, input: parseToolInput(row.tool_input), timestamp });
  return true;
}

function appendErrorEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (row.event_type !== 'error') return false;
  events.push({ type: 'tool_result', result: row.content || 'Execution error', isError: true, timestamp });
  return true;
}

function appendFallbackContentEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): void {
  if (!row.content) return;
  events.push({ type: row.tool_name ? 'tool_result' : 'thought', content: row.tool_name ? undefined : row.content, result: row.tool_name ? row.content : undefined, isError: Boolean(row.is_error), timestamp });
}
