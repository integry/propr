import fs from 'fs-extra';
import { filterAntigravityAnalysisEvents, parseAntigravityJsonl, parseCodexStreamOutput, parseVibeConversationLog } from '@propr/core';
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
export interface ClaudeMessageContext { timestamp: string; events: Array<Record<string, unknown>>; pendingSubagents: Map<string, PendingSubagent>; setTodos: (todos: TodoItem[]) => void; }
interface ClaudeParseContext { events: Array<Record<string, unknown>>; timestamp: string; pendingSubagents: Map<string, PendingSubagent>; }
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
  if ((event.item?.type === 'reasoning' || event.item?.type === 'agent_message') && event.item.text) {
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

export function appendClaudeAssistantMessageEvents(contentArray: ClaudeMessageContent[], context: ClaudeMessageContext): boolean {
  let handled = false;
  for (const content of contentArray) {
    const textContent = typeof content.text === 'string'
      ? content.text
      : (typeof content.content === 'string' ? content.content : '');
    if (content.type === 'text' && textContent) {
      context.events.push({ type: 'thought', content: textContent, timestamp: context.timestamp });
      handled = true;
      continue;
    }
    if (content.type !== 'tool_use') continue;
    context.events.push({ type: 'tool_use', toolName: content.name, input: content.input, id: content.id, timestamp: context.timestamp });
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
  for (const content of contentArray) {
    if (content.type !== 'tool_result') continue;
    context.events.push({
      type: 'tool_result',
      toolUseId: content.tool_use_id,
      result: content.content,
      isError: content.is_error || false,
      timestamp: context.timestamp
    });
    if (content.tool_use_id && context.pendingSubagents.has(content.tool_use_id)) {
      const subagent = context.pendingSubagents.get(content.tool_use_id)!;
      context.events.push(buildSubagentCompletionEvent(subagent, content, context.timestamp));
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
  events: Array<Record<string, unknown>>,
  pendingSubagents: Map<string, PendingSubagent>,
  warningState: ClaudeWarningState
): ParseLineResult {
  try {
    const message = JSON.parse(line) as Message;
    const timestamp = message.timestamp || new Date().toISOString();
    const context = { events, timestamp, pendingSubagents };
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

export function parseClaudeOutputToConversationResult(conversationContent: string): ConversationResult {
  const lines = conversationContent.trim().split('\n').filter(line => line.trim());
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

  for (const line of lines) {
    const parsed = parseLine(line, events, pendingSubagents, warningState);
    if (parsed.newTodos) todos = parsed.newTodos;
    if (parsed.tokenUsage) {
      tokenUsage.input_tokens += parsed.tokenUsage.input_tokens;
      tokenUsage.output_tokens += parsed.tokenUsage.output_tokens;
      tokenUsage.cache_creation_input_tokens += parsed.tokenUsage.cache_creation_input_tokens;
      tokenUsage.cache_read_input_tokens += parsed.tokenUsage.cache_read_input_tokens;
    }
  }

  const currentTask = deriveCurrentTask(todos);
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
    tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;

  return { events, todos, currentTask, tokenUsage: hasTokens ? tokenUsage : null };
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

export function parseAntigravityOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseAntigravityJsonl(output);
  const events = filterAntigravityAnalysisEvents(parsed.conversationLog).map(event => ({
    type: 'thought',
    content: 'content' in event && typeof event.content === 'string' ? event.content : '',
    timestamp: 'created_at' in event ? event.created_at : 'timestamp' in event ? event.timestamp : undefined
  })).filter(event => event.content);
  const hasTokens = (parsed.tokenUsage.input_tokens ?? 0) > 0 || (parsed.tokenUsage.output_tokens ?? 0) > 0;
  return events.length || hasTokens ? {
    events,
    todos: [],
    currentTask: null,
    tokenUsage: hasTokens ? {
      input_tokens: parsed.tokenUsage.input_tokens ?? 0,
      output_tokens: parsed.tokenUsage.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    } : null
  } : null;
}

export function parseVibeOutputToConversationResult(output: string): ConversationResult | null {
  const conversationLog = parseVibeConversationLog(output);
  if (!conversationLog.length) return null;

  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const pendingSubagents: Map<string, PendingSubagent> = new Map();
  const tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  for (const message of conversationLog) {
    const timestamp = message.timestamp;
    const usage = message.message?.usage;
    if (message.type === 'assistant') {
      appendClaudeAssistantMessageEvents(message.message.content as ClaudeMessageContent[], {
        timestamp,
        events,
        pendingSubagents,
        setTodos: nextTodos => {
          todos = nextTodos;
        }
      });
    } else if (message.type === 'user') {
      appendClaudeUserMessageEvents(message.message.content as ClaudeMessageContent[], {
        timestamp,
        events,
        pendingSubagents,
        setTodos: () => {}
      });
    }
    if (usage) {
      tokenUsage.input_tokens += usage.input_tokens ?? 0;
      tokenUsage.output_tokens += usage.output_tokens ?? 0;
    }
  }

  const currentTask = deriveCurrentTask(todos);
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0;
  return { events, todos, currentTask, tokenUsage: hasTokens ? tokenUsage : null };
}
