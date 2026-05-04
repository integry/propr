import fs from 'fs-extra';
import { parseCodexStreamOutput } from '@propr/core';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ConversationResult {
  events: Array<Record<string, unknown>>;
  todos: Array<{ status: string; content: string }>;
  currentTask: string | null;
  tokenUsage: TokenUsage | null;
}

interface CodexTodoItem {
  text?: string;
  completed?: boolean;
  status?: string;
}

interface PendingSubagent {
  toolUseId: string;
  subagentType: string;
  description: string;
  startTimestamp: string;
}
interface CodexEventContext {
  events: Array<Record<string, unknown>>;
  setTodos: (nextTodos: Array<{ status: string; content: string }>) => void;
  pendingCommandStarts: Map<string, number>;
  timestamp?: string;
}
interface ParseLineResult { newTodos?: Array<{ status: string; content: string }>; tokenUsage?: TokenUsage; }
interface MessageContent {
  type: string; text?: string; name?: string;
  input?: { todos?: Array<{ status: string; content: string }>; subagent_type?: string; description?: string };
  id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean;
}
interface Message {
  type?: string; timestamp?: string;
  message?: { content?: MessageContent[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}
interface ContentBlock { type: string; text?: string; content?: string; }

function mapCodexTodoStatus(item: CodexTodoItem): 'completed' | 'in_progress' | 'pending' {
  if (item.status === 'completed' || item.completed) {
    return 'completed';
  }
  if (item.status === 'in_progress' || item.status === 'active' || item.status === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

function mapCodexTodos(items: CodexTodoItem[]): Array<{ status: string; content: string }> {
  return items.map(item => ({
    status: mapCodexTodoStatus(item),
    content: item.text || ''
  }));
}

function pushCodexToolUseEvent(
  events: Array<Record<string, unknown>>,
  toolName: string,
  input: { file_path?: string; command?: string } | undefined,
  timestamp?: string
): void {
  events.push({ type: 'tool_use', toolName, input, timestamp });
}

function pushCodexToolResultEvent(
  events: Array<Record<string, unknown>>,
  result: unknown,
  isError: boolean,
  timestamp?: string
): void {
  events.push({ type: 'tool_result', result, isError, timestamp });
}

function parseCompletedCodexItem(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  context: CodexEventContext
): boolean {
  const { events, setTodos, pendingCommandStarts, timestamp } = context;
  if ((event.item?.type === 'reasoning' || event.item?.type === 'agent_message') && event.item.text) {
    events.push({ type: 'thought', content: event.item.text, timestamp });
    return true;
  }

  if (event.item?.type === 'command_execution') {
    if (event.item.command) {
      const startedCount = pendingCommandStarts.get(event.item.command) ?? 0;
      if (startedCount > 0) {
        pendingCommandStarts.set(event.item.command, startedCount - 1);
      } else {
        pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
      }
    }
    if (event.item.aggregated_output) {
      pushCodexToolResultEvent(
        events,
        event.item.aggregated_output,
        event.item.exit_code != null && event.item.exit_code !== 0,
        timestamp
      );
    }
    return true;
  }

  if (event.item?.type === 'todo_list' && event.item.items) {
    setTodos(mapCodexTodos(event.item.items as CodexTodoItem[]));
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

function appendAssistantMessageEvent(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  events: Array<Record<string, unknown>>,
  timestamp?: string
): boolean {
  if (event.type !== 'message' || event.role !== 'assistant' || !event.content) return false;
  events.push({ type: 'thought', content: event.content, timestamp });
  return true;
}

function appendToolUseConversationEvent(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  events: Array<Record<string, unknown>>,
  timestamp?: string
): boolean {
  if (event.type !== 'tool_use' || !event.tool) return false;
  pushCodexToolUseEvent(events, event.tool, event.params as { file_path?: string; command?: string } | undefined, timestamp);
  return true;
}

function appendErrorConversationEvent(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  events: Array<Record<string, unknown>>,
  timestamp?: string
): boolean {
  if (event.type !== 'error') return false;
  pushCodexToolResultEvent(events, event.message || event.result || 'Execution error', true, timestamp);
  return true;
}

function appendStartedCommandEvent(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  events: Array<Record<string, unknown>>,
  pendingCommandStarts: Map<string, number>,
  timestamp?: string
): boolean {
  if (event.type !== 'item.started' || event.item?.type !== 'command_execution' || !event.item.command) return false;
  pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
  pendingCommandStarts.set(event.item.command, (pendingCommandStarts.get(event.item.command) ?? 0) + 1);
  return true;
}

function updateTodosFromEvent(
  event: ReturnType<typeof parseCodexStreamOutput>['conversationLog'][number],
  context: CodexEventContext
): boolean {
  const { setTodos } = context;
  if (event.type === 'item.updated' && event.item?.type === 'todo_list' && event.item.items) {
    setTodos(mapCodexTodos(event.item.items as CodexTodoItem[]));
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
    .map((block: ContentBlock) => block.type === 'text' && block.text ? block.text : (block.content ?? ''))
    .filter(Boolean);
  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

function parseAssistantContent(
  contentArray: MessageContent[],
  events: Array<Record<string, unknown>>,
  timestamp: string,
  pendingSubagents: Map<string, PendingSubagent>
): ParseLineResult {
  let newTodos: Array<{ status: string; content: string }> | undefined;

  for (const content of contentArray) {
    if (content.type === 'text') {
      events.push({ type: 'thought', content: content.text, timestamp });
    } else if (content.type === 'tool_use') {
      events.push({ type: 'tool_use', toolName: content.name, input: content.input, id: content.id, timestamp });
      if (content.name === 'TodoWrite' && content.input?.todos) {
        newTodos = content.input.todos;
      }
      if (content.name === 'Task' && content.id) {
        pendingSubagents.set(content.id, {
          toolUseId: content.id,
          subagentType: content.input?.subagent_type || 'unknown',
          description: content.input?.description || '',
          startTimestamp: timestamp
        });
      }
    }
  }

  return { newTodos };
}

function getSubagentIcon(subagentType: string): string {
  switch (subagentType.toLowerCase()) {
    case 'explore':
      return '🔍';
    case 'plan':
      return '📋';
    case 'bash':
      return '⚡';
    default:
      return '🤖';
  }
}

function buildSubagentSummary(subagent: PendingSubagent, content: MessageContent, timestamp: string): string {
  const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
  const durationSecs = Math.round(durationMs / 1000);
  const subagentOutputText = extractTextFromContentBlocks(content.content);
  const subagentIcon = getSubagentIcon(subagent.subagentType);
  const summaryHeader = `${subagentIcon} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`;
  return subagentOutputText ? `${summaryHeader}\n\n${subagentOutputText}` : summaryHeader;
}

function parseUserContent(
  contentArray: MessageContent[],
  events: Array<Record<string, unknown>>,
  timestamp: string,
  pendingSubagents: Map<string, PendingSubagent>
): void {
  for (const content of contentArray) {
    if (content.type !== 'tool_result') continue;
    events.push({
      type: 'tool_result',
      toolUseId: content.tool_use_id,
      result: content.content,
      isError: content.is_error || false,
      timestamp
    });
    if (!content.tool_use_id || !pendingSubagents.has(content.tool_use_id)) continue;
    const subagent = pendingSubagents.get(content.tool_use_id)!;
    events.push({
      type: 'thought',
      content: buildSubagentSummary(subagent, content, timestamp),
      timestamp,
      isSubagentSummary: true
    });
    pendingSubagents.delete(content.tool_use_id);
  }
}

function parseLine(
  line: string,
  events: Array<Record<string, unknown>>,
  pendingSubagents: Map<string, PendingSubagent>
): ParseLineResult {
  try {
    const message = JSON.parse(line) as Message;
    const timestamp = message.timestamp || new Date().toISOString();
    if (message.type === 'assistant' && message.message?.content) {
      return parseAssistantContent(message.message.content, events, timestamp, pendingSubagents);
    }
    if (message.type === 'user' && message.message?.content) {
      parseUserContent(message.message.content, events, timestamp, pendingSubagents);
    }
    const usage = message.usage || message.message?.usage;
    if (usage) {
      return {
        tokenUsage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
        }
      };
    }
  } catch (parseError) {
    console.error('[live-details] Error parsing line:', parseError);
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
  let todos: Array<{ status: string; content: string }> = [];
  const tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
  const pendingSubagents: Map<string, PendingSubagent> = new Map();

  for (const line of lines) {
    const parsed = parseLine(line, events, pendingSubagents);
    if (parsed.newTodos) {
      todos = parsed.newTodos;
    }
    if (parsed.tokenUsage) {
      tokenUsage.input_tokens += parsed.tokenUsage.input_tokens;
      tokenUsage.output_tokens += parsed.tokenUsage.output_tokens;
      tokenUsage.cache_creation_input_tokens += parsed.tokenUsage.cache_creation_input_tokens;
      tokenUsage.cache_read_input_tokens += parsed.tokenUsage.cache_read_input_tokens;
    }
  }

  const inProgressTask = todos.find(t => t.status === 'in_progress');
  const currentTask = inProgressTask ? inProgressTask.content : null;
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
    tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;

  return { events, todos, currentTask, tokenUsage: hasTokens ? tokenUsage : null };
}

export function parseCodexOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseCodexStreamOutput(output);
  if (!parsed.conversationLog || parsed.conversationLog.length === 0) {
    return null;
  }

  const events: Array<Record<string, unknown>> = [];
  let todos: Array<{ status: string; content: string }> = [];
  const pendingCommandStarts = new Map<string, number>();

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

  const currentTask = todos.find(t => t.status === 'in_progress')?.content
    || todos.find(t => t.status === 'pending')?.content
    || null;
  return { events, todos, currentTask, tokenUsage: buildCodexTokenUsage(parsed) };
}
