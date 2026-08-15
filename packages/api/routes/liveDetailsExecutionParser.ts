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
  item?: { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean; status?: string }> };
  is_error?: boolean;
  status?: string;
}

type PendingCommandStarts = Map<string, string[]>;
const CODEX_LIFECYCLE_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'item.started',
  'item.updated',
  'item.completed'
]);

export function parseExecutionDetailsRows(details: ExecutionDetailRow[]): Omit<ConversationResult, 'tokenUsage'> {
  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const pendingSubagents = new Map<string, PendingSubagent>();
  const pendingCommandStarts: PendingCommandStarts = new Map();
  for (const row of details) {
    const timestamp = row.event_timestamp;
    const metadataHandled = appendEventFromMetadata(
      row,
      { timestamp, events, pendingSubagents, setTodos: nextTodos => { todos = nextTodos; } },
      pendingCommandStarts
    );
    if (metadataHandled) continue;
    // A Codex protocol row is not user-visible content. In the normal case its
    // metadata above contains the full event; this guard also prevents a
    // malformed or partially copied envelope from leaking as a JSON thought.
    if (CODEX_LIFECYCLE_EVENT_TYPES.has(row.event_type)) continue;
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

function appendCompletedCodexItem(rawEvent: RawExecutionEvent, context: ClaudeMessageContext, pendingCommandStarts: PendingCommandStarts): void {
  if ((rawEvent.item?.type === 'reasoning' || rawEvent.item?.type === 'agent_message') && rawEvent.item.text) {
    context.events.push({ type: 'thought', content: rawEvent.item.text, timestamp: context.timestamp });
    return;
  }
  if (rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
    context.setTodos(mapTodoItems(rawEvent.item.items));
    return;
  }
  if (rawEvent.item?.type === 'command_execution') {
    appendCompletedCommand(rawEvent, context, pendingCommandStarts);
  }
}

function appendRawEventByType(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if (rawEvent.type === 'tool_use') {
    if (rawEvent.tool) {
      context.events.push({ type: 'tool_use', toolName: rawEvent.tool, input: rawEvent.params, timestamp: context.timestamp });
    }
    return true;
  }
  if (rawEvent.type === 'error') {
    context.events.push({ type: 'tool_result', result: rawEvent.message || rawEvent.result || rawEvent.content || 'Execution error', isError: true, timestamp: context.timestamp });
    return true;
  }
  if (rawEvent.type === 'tool_result') {
    context.events.push({
      type: 'tool_result',
      result: rawEvent.message || rawEvent.result || rawEvent.content || 'Execution error',
      isError: Boolean(rawEvent.is_error) || rawEvent.status === 'error',
      timestamp: context.timestamp
    });
    return true;
  }
  return false;
}

function appendEventFromMetadata(row: ExecutionDetailRow, context: ClaudeMessageContext, pendingCommandStarts: PendingCommandStarts): boolean {
  if (!row.metadata) return false;
  try {
    const rawEvent = JSON.parse(row.metadata) as RawExecutionEvent;
    if (appendModelSourceEvent(rawEvent, context)) return true;
    if (rawEvent.source === 'USER_EXPLICIT' || rawEvent.source === 'SYSTEM') return true;
    if (appendMetadataMessageEvent(rawEvent, context)) return true;
    if (appendRawEventByType(rawEvent, context)) return true;
    if (appendCodexLifecycleEvent(rawEvent, context, pendingCommandStarts)) return true;
  } catch (error) {
    console.error('[live-details] Failed to parse execution detail metadata:', error);
  }
  return false;
}

function appendMetadataMessageEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if (rawEvent.type !== 'message') return false;
  if (!rawEvent.content) return true;
  if (rawEvent.role === 'assistant') {
    if (typeof rawEvent.content === 'string') {
      context.events.push({ type: 'thought', content: rawEvent.content, timestamp: context.timestamp });
      return true;
    }
    const assistantContent = extractMessageContentBlocks(rawEvent.content);
    if (assistantContent) appendClaudeAssistantMessageEvents(assistantContent, context);
    return true;
  }
  if (rawEvent.role === 'user') {
    const userContent = extractMessageContentBlocks(rawEvent.content);
    if (userContent) appendClaudeUserMessageEvents(userContent, context);
  }
  return true;
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

function appendCodexLifecycleEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext, pendingCommandStarts: PendingCommandStarts): boolean {
  if (!rawEvent.type || !CODEX_LIFECYCLE_EVENT_TYPES.has(rawEvent.type)) return false;
  if (rawEvent.type === 'item.started') appendStartedCommand(rawEvent, context, pendingCommandStarts);
  if (rawEvent.type === 'item.updated' && rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
    context.setTodos(mapTodoItems(rawEvent.item.items));
  }
  if (rawEvent.type === 'item.completed') appendCompletedCodexItem(rawEvent, context, pendingCommandStarts);
  return true;
}

function appendStartedCommand(rawEvent: RawExecutionEvent, context: ClaudeMessageContext, pendingCommandStarts: PendingCommandStarts): void {
  const command = rawEvent.item?.type === 'command_execution' ? rawEvent.item.command : undefined;
  if (!command) return;
  context.events.push({ type: 'tool_use', toolName: 'command_execution', input: { command }, timestamp: context.timestamp });
  const key = commandExecutionKey(rawEvent);
  if (!key) return;
  const pending = pendingCommandStarts.get(key) ?? [];
  pending.push(command);
  pendingCommandStarts.set(key, pending);
}

function appendCompletedCommand(rawEvent: RawExecutionEvent, context: ClaudeMessageContext, pendingCommandStarts: PendingCommandStarts): void {
  const command = rawEvent.item?.command;
  if (command && !consumePendingCommandStart(rawEvent, command, pendingCommandStarts)) {
    context.events.push({ type: 'tool_use', toolName: 'command_execution', input: { command }, timestamp: context.timestamp });
  }
  context.events.push({
    type: 'tool_result',
    result: rawEvent.item?.aggregated_output ?? '',
    isError: rawEvent.item?.exit_code != null && rawEvent.item.exit_code !== 0,
    timestamp: context.timestamp
  });
}

function commandExecutionKey(rawEvent: RawExecutionEvent): string | null {
  if (rawEvent.item?.type !== 'command_execution' || !rawEvent.item.command) return null;
  return rawEvent.item.id ? `id:${rawEvent.item.id}` : `command:${rawEvent.item.command}`;
}

function consumePendingCommandStart(rawEvent: RawExecutionEvent, command: string, pendingCommandStarts: PendingCommandStarts): boolean {
  const key = commandExecutionKey(rawEvent);
  if (!key) return false;
  const pending = pendingCommandStarts.get(key);
  if (!pending) return false;
  const index = pending.indexOf(command);
  if (index === -1) return false;
  pending.splice(index, 1);
  if (pending.length === 0) pendingCommandStarts.delete(key);
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
