import fs from 'fs-extra';
import { parseCodexStreamOutput } from '@propr/core';
import type { TokenUsage, ConversationResult, TodoItem, PendingSubagent } from './liveDetailsTypes.js';

export type { TokenUsage, ConversationResult, TodoItem, PendingSubagent };

export function isConversationResultEmpty(result: ConversationResult | null): boolean {
  if (!result) return true;
  return result.events.length === 0
    && result.todos.length === 0
    && result.currentTask === null
    && result.tokenUsage === null;
}

interface CodexTodoItem { text?: string; completed?: boolean; status?: string; }
interface CodexEventContext { events: Array<Record<string, unknown>>; setTodos: (nextTodos: Array<{ status: string; content: string }>) => void; pendingCommandStarts: Map<string, string[]>; timestamp?: string; }
interface ParseLineResult { newTodos?: TodoItem[]; tokenUsage?: TokenUsage; }
export interface ClaudeMessageContent {
  type: string; text?: string; name?: string;
  internalReasoning?: boolean;
  input?: { todos?: TodoItem[]; subagent_type?: string; description?: string };
  id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean;
}
interface Message {
  type?: string; timestamp?: string;
  message?: { content?: ClaudeMessageContent[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  antigravity?: { source?: string; type?: string };
}
type MessageUsage = NonNullable<Message['usage']>;
interface ContentBlock { type: string; text?: string; content?: unknown; }
/**
 * Source slot of each event within its message: content block index times two,
 * plus one for an event synthesized from that block. Unlike its position among
 * emitted events, it does not depend on earlier messages (a Task invocation).
 */
export type ClaudeEventSlots = WeakMap<object, number>;
export interface ClaudeMessageContext { timestamp: string; events: Array<Record<string, unknown>>; pendingSubagents: Map<string, PendingSubagent>; setTodos: (todos: TodoItem[]) => void; eventSlots?: ClaudeEventSlots; }
interface ClaudeParseContext { events: Array<Record<string, unknown>>; timestamp: string; pendingSubagents: Map<string, PendingSubagent>; eventSlots?: ClaudeEventSlots; }
const MAX_MALFORMED_CLAUDE_LINE_WARNINGS = 5;
interface ClaudeWarningState { malformedLineWarnings: number; }

export function mapTodoStatus(item: { completed?: boolean; status?: string }): 'completed' | 'in_progress' | 'pending' {
  if (item.status === 'completed' || item.completed) {
    return 'completed';
  }
  if (item.status === 'in_progress' || item.status === 'active' || item.status === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

export function mapTodoItems(items: Array<{ text?: string; completed?: boolean; status?: string }>): TodoItem[] {
  return items.map(item => ({
    status: mapTodoStatus(item),
    content: item.text || ''
  }));
}

export function deriveCurrentTask(todos: TodoItem[]): string | null {
  return todos.find(t => t.status === 'in_progress')?.content
    || todos.find(t => t.status === 'pending')?.content
    || null;
}
function pushCodexToolUseEvent(events: Array<Record<string, unknown>>, toolName: string, input: { file_path?: string; command?: string } | undefined, timestamp?: string): void {
  events.push({ type: 'tool_use', toolName, input, timestamp });
}
function pushCodexToolResultEvent(events: Array<Record<string, unknown>>, result: unknown, isError: boolean, timestamp?: string): void {
  events.push({ type: 'tool_result', result, isError, timestamp });
}

function buildCommandExecutionKey(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number]): string | null {
  if (event.item?.type !== 'command_execution' || !event.item.command) {
    return null;
  }
  return event.item.id ? `id:${event.item.id}` : `command:${event.item.command}`;
}

function enqueuePendingCommandStart(pendingCommandStarts: Map<string, string[]>, key: string, command: string): void {
  const pending = pendingCommandStarts.get(key) ?? [];
  pending.push(command);
  pendingCommandStarts.set(key, pending);
}

function consumePendingCommandStart(
  pendingCommandStarts: Map<string, string[]>,
  key: string,
  command: string
): boolean {
  const pending = pendingCommandStarts.get(key);
  if (!pending || pending.length === 0) {
    return false;
  }
  const index = pending.findIndex(value => value === command);
  if (index === -1) {
    return false;
  }
  pending.splice(index, 1);
  if (pending.length === 0) {
    pendingCommandStarts.delete(key);
  } else {
    pendingCommandStarts.set(key, pending);
  }
  return true;
}

function parseCompletedCodexItem(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], context: CodexEventContext): boolean {
  const { events, setTodos, pendingCommandStarts, timestamp } = context;
  if (event.item?.type === 'reasoning' && event.item.text) {
    events.push({ type: 'thought', content: event.item.text, internalReasoning: true, timestamp });
    return true;
  }
  if (event.item?.type === 'agent_message' && event.item.text) {
    events.push({ type: 'thought', content: event.item.text, timestamp });
    return true;
  }

  if (event.item?.type === 'command_execution') {
    const commandKey = buildCommandExecutionKey(event);
    if (event.item.command) {
      const matchedStartedCommand = commandKey
        ? consumePendingCommandStart(pendingCommandStarts, commandKey, event.item.command)
        : false;
      if (!matchedStartedCommand) {
        pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
      }
    }
    pushCodexToolResultEvent(
      events,
      event.item.aggregated_output ?? '',
      event.item.exit_code != null && event.item.exit_code !== 0,
      timestamp
    );
    return true;
  }

  if (event.item?.type === 'todo_list' && event.item.items) {
    setTodos(mapTodoItems(event.item.items as CodexTodoItem[]));
    return true;
  }

  return false;
}

function buildCodexTokenUsage(parsed: ReturnType<typeof parseCodexStreamOutput>): TokenUsage | null {
  if (!parsed.tokenUsage) {
    return null;
  }

  const tokenUsage = parsed.tokenUsage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };

  return {
    input_tokens: tokenUsage.input_tokens ?? 0,
    output_tokens: tokenUsage.output_tokens ?? 0,
    cache_creation_input_tokens: tokenUsage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: tokenUsage.cache_read_input_tokens ?? 0
  };
}
function appendAssistantMessageEvent(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], events: Array<Record<string, unknown>>, timestamp?: string): boolean {
  if (event.type !== 'message' || event.role !== 'assistant' || !event.content) return false;
  events.push({ type: 'thought', content: event.content, timestamp });
  return true;
}
function appendToolUseConversationEvent(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], events: Array<Record<string, unknown>>, timestamp?: string): boolean {
  if (event.type !== 'tool_use' || !event.tool) return false;
  pushCodexToolUseEvent(events, event.tool, event.params as { file_path?: string; command?: string } | undefined, timestamp);
  return true;
}
function appendErrorConversationEvent(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], events: Array<Record<string, unknown>>, timestamp?: string): boolean {
  if (event.type !== 'error' && event.type !== 'tool_result') return false;
  pushCodexToolResultEvent(events, event.message || event.result || event.content || 'Execution error', event.type === 'error' || !!event.is_error || event.status === 'error', timestamp);
  return true;
}
function appendStartedCommandEvent(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], events: Array<Record<string, unknown>>, pendingCommandStarts: Map<string, string[]>, timestamp?: string): boolean {
  if (event.type !== 'item.started' || event.item?.type !== 'command_execution' || !event.item.command) return false;
  pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
  const commandKey = buildCommandExecutionKey(event);
  if (commandKey) {
    enqueuePendingCommandStart(pendingCommandStarts, commandKey, event.item.command);
  }
  return true;
}
function updateTodosFromEvent(event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number], context: CodexEventContext): boolean {
  const { setTodos } = context;
  if (event.type === 'item.updated' && event.item?.type === 'todo_list' && event.item.items) {
    setTodos(mapTodoItems(event.item.items as CodexTodoItem[]));
    return true;
  }
  if (event.type !== 'item.completed') return false;
  return parseCompletedCodexItem(event, context);
}

function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as ContentBlock;
  if (typeof first !== 'object' || first === null || !('type' in first)) return null;
  const textParts = content
    .map((block: ContentBlock) => {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        return block.text;
      }
      return typeof block.content === 'string' ? block.content : '';
    })
    .filter(Boolean);
  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

function buildSubagentCompletionEvent(subagent: PendingSubagent, content: ClaudeMessageContent, timestamp: string): Record<string, unknown> {
  const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
  return {
    type: 'subagent_completed',
    toolUseId: subagent.toolUseId,
    subagentType: subagent.subagentType,
    description: subagent.description,
    durationSeconds: Math.round(durationMs / 1000),
    content: extractTextFromContentBlocks(content.content),
    timestamp
  };
}

function pushSlotted(context: ClaudeMessageContext, event: Record<string, unknown>, slot: number): void {
  context.events.push(event);
  context.eventSlots?.set(event, slot);
}

export function appendClaudeAssistantMessageEvents(contentArray: ClaudeMessageContent[], context: ClaudeMessageContext): boolean {
  let handled = false;
  for (const [block, content] of contentArray.entries()) {
    const textContent = typeof content.text === 'string'
      ? content.text
      : (typeof content.content === 'string' ? content.content : '');
    if (content.type === 'text' && textContent) {
      pushSlotted(context, {
        type: 'thought',
        content: textContent,
        ...(content.internalReasoning ? { internalReasoning: true } : {}),
        timestamp: context.timestamp,
      }, block * 2);
      handled = true;
      continue;
    }
    if (content.type !== 'tool_use') continue;
    pushSlotted(context, { type: 'tool_use', toolName: content.name, input: content.input, id: content.id, timestamp: context.timestamp }, block * 2);
    if (content.name === 'TodoWrite' && content.input?.todos) {
      context.setTodos(content.input.todos);
    }
    if (content.name === 'Task' && content.id) {
      context.pendingSubagents.set(content.id, {
        toolUseId: content.id,
        subagentType: content.input?.subagent_type || 'unknown',
        description: content.input?.description || '',
        startTimestamp: context.timestamp
      });
    }
    handled = true;
  }
  return handled;
}

export function appendClaudeUserMessageEvents(contentArray: ClaudeMessageContent[], context: ClaudeMessageContext): boolean {
  let handled = false;
  for (const [block, content] of contentArray.entries()) {
    if (content.type !== 'tool_result') continue;
    pushSlotted(context, {
      type: 'tool_result',
      toolUseId: content.tool_use_id,
      result: content.content,
      isError: content.is_error || false,
      timestamp: context.timestamp
    }, block * 2);
    if (content.tool_use_id && context.pendingSubagents.has(content.tool_use_id)) {
      const subagent = context.pendingSubagents.get(content.tool_use_id)!;
      pushSlotted(context, buildSubagentCompletionEvent(subagent, content, context.timestamp), block * 2 + 1);
      context.pendingSubagents.delete(content.tool_use_id);
    }
    handled = true;
  }
  return handled;
}

function buildTokenUsage(usage: MessageUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
  };
}

function parseAssistantContent(contentArray: ClaudeMessageContent[], context: ClaudeParseContext, usage?: MessageUsage): ParseLineResult {
  let newTodos: TodoItem[] | undefined;
  appendClaudeAssistantMessageEvents(contentArray, {
    ...context,
    setTodos: todos => {
      newTodos = todos;
    }
  });
  return { newTodos, tokenUsage: buildTokenUsage(usage) };
}

function parseUserContent(contentArray: ClaudeMessageContent[], context: ClaudeParseContext): void {
  appendClaudeUserMessageEvents(contentArray, { ...context, setTodos: () => {} });
}

function parseLine(
  line: string,
  stream: Omit<ClaudeParseContext, 'timestamp'>,
  warningState: ClaudeWarningState
): ParseLineResult {
  try {
    const message = JSON.parse(line) as Message;
    const timestamp = message.timestamp || new Date().toISOString();
    const context = { ...stream, timestamp };
    const usage = message.usage || message.message?.usage;
    if (message.antigravity) {
      if (message.antigravity.source === 'MODEL' && message.antigravity.type === 'PLANNER_RESPONSE' && message.message?.content) {
        return parseAssistantContent(message.message.content, context, usage);
      }
      return usage ? { tokenUsage: buildTokenUsage(usage) } : {};
    }
    if (message.type === 'assistant' && message.message?.content) {
      return parseAssistantContent(message.message.content, context, usage);
    }
    if (message.type === 'user' && message.message?.content) {
      parseUserContent(message.message.content, context);
    }
    if (usage) {
      return { tokenUsage: buildTokenUsage(usage) };
    }
  } catch (parseError) {
    if (warningState.malformedLineWarnings < MAX_MALFORMED_CLAUDE_LINE_WARNINGS) {
      warningState.malformedLineWarnings += 1;
      console.warn('[live-details] Skipping malformed Claude transcript line', parseError);
    }
  }
  return {};
}

export async function parseClaudeConversationFile(conversationPath: string): Promise<ConversationResult> {
  const conversationContent = await fs.readFile(conversationPath, 'utf8');
  return parseClaudeOutputToConversationResult(conversationContent);
}

/**
 * Record-by-record projection of Claude stream-json, for readers that only
 * fetch new output. Feeding every record and then calling result() gives
 * exactly what parseClaudeOutputToConversationResult() returns.
 */
export interface ClaudeStreamProjection {
  /** Consumes one record and returns the events it completed. */
  feed(line: string): Array<Record<string, unknown>>;
  /** An event's stable slot within the record that produced it (see {@link ClaudeEventSlots}). */
  slot(event: object): number | undefined;
  /** Everything but the events, without touching them. */
  metadata(): Omit<ConversationResult, 'events'>;
  /** Every event fed so far; empty unless the projection retains events. */
  result(): ConversationResult;
}

/**
 * `retainEvents: false` releases each event once feed() returns it, keeping only
 * what later records depend on (todos, usage, pending subagents), so a live
 * reader's memory does not grow with the length of the run.
 */
export function createClaudeStreamProjection({ retainEvents = true }: { retainEvents?: boolean } = {}): ClaudeStreamProjection {
  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
  const pendingSubagents: Map<string, PendingSubagent> = new Map();
  const warningState: ClaudeWarningState = { malformedLineWarnings: 0 };
  const eventSlots: ClaudeEventSlots = new WeakMap();
  const metadata = () => {
    const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
      tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;
    return { todos, currentTask: deriveCurrentTask(todos), tokenUsage: hasTokens ? { ...tokenUsage } : null };
  };

  return {
    feed(line) {
      if (!line.trim()) return [];
      const before = events.length;
      const parsed = parseLine(line, { events, pendingSubagents, eventSlots }, warningState);
      if (parsed.newTodos) todos = parsed.newTodos;
      if (parsed.tokenUsage) {
        tokenUsage.input_tokens += parsed.tokenUsage.input_tokens;
        tokenUsage.output_tokens += parsed.tokenUsage.output_tokens;
        tokenUsage.cache_creation_input_tokens += parsed.tokenUsage.cache_creation_input_tokens;
        tokenUsage.cache_read_input_tokens += parsed.tokenUsage.cache_read_input_tokens;
      }
      const emitted = events.slice(before);
      if (!retainEvents) events.length = 0;
      return emitted;
    },
    slot: event => eventSlots.get(event),
    metadata,
    result: () => ({ events, ...metadata() }),
  };
}

export function parseClaudeOutputToConversationResult(conversationContent: string): ConversationResult {
  const projection = createClaudeStreamProjection();
  for (const line of conversationContent.trim().split('\n')) projection.feed(line);
  return projection.result();
}

export function parseCodexOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseCodexStreamOutput(output);
  if (!parsed.conversationLog || parsed.conversationLog.length === 0) {
    const tokenUsage = buildCodexTokenUsage(parsed);
    return tokenUsage
      ? { events: [], todos: [], currentTask: null, tokenUsage }
      : null;
  }

  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const pendingCommandStarts = new Map<string, string[]>();

  for (const event of parsed.conversationLog) {
    const timestamp = (event as { timestamp?: string }).timestamp;
    const eventContext: CodexEventContext = {
      events,
      setTodos: nextTodos => {
        todos = nextTodos;
      },
      pendingCommandStarts,
      timestamp
    };

    if (
      appendAssistantMessageEvent(event, events, timestamp)
      || appendToolUseConversationEvent(event, events, timestamp)
      || appendErrorConversationEvent(event, events, timestamp)
      || appendStartedCommandEvent(event, events, pendingCommandStarts, timestamp)
      || updateTodosFromEvent(event, eventContext)
    ) {
      continue;
    }
  }

  const currentTask = deriveCurrentTask(todos);
  return { events, todos, currentTask, tokenUsage: buildCodexTokenUsage(parsed) };
}
