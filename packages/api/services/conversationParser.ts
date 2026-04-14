import fs from 'fs-extra';
import type { ConversationEvent, TodoItem, TokenUsageInfo } from '@propr/shared';

/** Message content item from Claude conversation logs */
interface MessageContentItem {
  type: string;
  text?: string;
  name?: string;
  input?: { todos?: TodoItem[]; subagent_type?: string; description?: string };
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Token usage structure from Claude */
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Parsed message from JSONL conversation file */
interface ConversationMessage {
  type?: string;
  timestamp?: string;
  message?: {
    content?: MessageContentItem[];
    usage?: TokenUsage;
  };
  usage?: TokenUsage;
}

/** Pending subagent tracking info */
interface PendingSubagent {
  toolUseId: string;
  subagentType: string;
  description: string;
  startTimestamp: string;
}

// Extract text from Claude content blocks (e.g., Agent/Task tool results)
interface ContentBlock {
  type: string;
  text?: string;
  content?: string;
}

function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  if (content.length === 0) return null;

  // Check if it looks like a content blocks array
  const first = content[0] as ContentBlock;
  if (typeof first !== 'object' || first === null || !('type' in first)) {
    return null;
  }

  const textParts = content
    .map((block: ContentBlock) => {
      if (block.type === 'text' && block.text) {
        return block.text;
      }
      if (block.content) {
        return block.content;
      }
      return '';
    })
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

/** Maximum length for tool result content to prevent huge payloads */
const MAX_RESULT_LENGTH = 2000;

/** Maximum number of events to include in WebSocket payloads */
const MAX_EVENTS_FOR_SOCKET = 100;

/** Codex event item structure */
interface CodexEventItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  items?: Array<{ text: string; completed: boolean }>;
}

/** Codex event structure */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexEventItem;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
}

/**
 * Process a single Codex item.completed event item
 */
function processCodexItemCompleted(
  item: CodexEventItem,
  timestamp: string,
  events: ConversationEvent[]
): TodoItem[] | null {
  switch (item.type) {
    case 'reasoning':
      if (item.text) {
        events.push({ type: 'thought', content: item.text, timestamp });
      }
      break;
    case 'command_execution':
      events.push({
        type: 'tool_use',
        toolName: 'Bash',
        input: { command: item.command },
        timestamp
      });
      if (item.aggregated_output) {
        events.push({
          type: 'tool_result',
          result: truncateResult(item.aggregated_output),
          isError: item.exit_code !== 0,
          timestamp
        });
      }
      break;
    case 'file_change':
      if (item.changes) {
        const changesList = item.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
        events.push({
          type: 'tool_use',
          toolName: 'FileChange',
          input: { changes: item.changes },
          timestamp
        });
        events.push({
          type: 'tool_result',
          result: changesList,
          isError: false,
          timestamp
        });
      }
      break;
    case 'agent_message':
      if (item.text) {
        events.push({ type: 'thought', content: `**Result:** ${item.text}`, timestamp });
      }
      break;
    case 'todo_list':
      if (item.items) {
        return item.items.map((t, i) => ({
          id: `todo-${i}`,
          content: t.text,
          status: t.completed ? 'completed' as const : 'pending' as const
        }));
      }
      break;
  }
  return null;
}

/**
 * Parse todo items from Codex event
 */
function parseTodoItems(items: Array<{ text: string; completed: boolean }>): TodoItem[] {
  return items.map((t, i) => ({
    id: `todo-${i}`,
    content: t.text,
    status: t.completed ? 'completed' as const : 'pending' as const
  }));
}

/** Result from parsing a conversation file */
export interface ParsedConversation {
  events: ConversationEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage: TokenUsageInfo | null;
  /** Total event count before any limiting - used for incremental updates */
  totalEventCount: number;
}

/**
 * Get icon for subagent type
 */
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

/**
 * Process assistant message content items
 */
function processAssistantContent(
  contentItems: MessageContentItem[],
  timestamp: string,
  events: ConversationEvent[],
  pendingSubagents: Map<string, PendingSubagent>
): TodoItem[] | null {
  let updatedTodos: TodoItem[] | null = null;

  for (const content of contentItems) {
    if (content.type === 'text' && content.text) {
      events.push({ type: 'thought', content: content.text, timestamp });
    } else if (content.type === 'tool_use') {
      // Truncate large inputs to prevent huge WebSocket payloads
      const truncatedInput = truncateResult(content.input) as Record<string, unknown>;

      events.push({
        type: 'tool_use',
        toolName: content.name,
        input: truncatedInput,
        id: content.id,
        timestamp
      });

      if (content.name === 'TodoWrite' && content.input?.todos) {
        updatedTodos = content.input.todos;
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

  return updatedTodos;
}

/**
 * Truncate large result content to prevent huge WebSocket payloads
 */
function truncateResult(result: unknown): unknown {
  if (typeof result === 'string' && result.length > MAX_RESULT_LENGTH) {
    return result.substring(0, MAX_RESULT_LENGTH) + `... [truncated ${result.length - MAX_RESULT_LENGTH} chars]`;
  }
  if (Array.isArray(result)) {
    // For arrays, truncate each string element and limit array size
    return result.slice(0, 10).map(item => truncateResult(item));
  }
  if (result && typeof result === 'object') {
    // For objects, truncate string values recursively
    const truncated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      truncated[key] = truncateResult(value);
    }
    return truncated;
  }
  return result;
}

/**
 * Process user message content items (tool results)
 */
function processUserContent(
  contentItems: MessageContentItem[],
  timestamp: string,
  events: ConversationEvent[],
  pendingSubagents: Map<string, PendingSubagent>
): void {
  for (const content of contentItems) {
    if (content.type !== 'tool_result') continue;

    // Truncate large results to prevent huge WebSocket payloads
    const truncatedResult = truncateResult(content.content);

    events.push({
      type: 'tool_result',
      toolUseId: content.tool_use_id,
      result: truncatedResult,
      isError: content.is_error || false,
      timestamp
    });

    if (content.tool_use_id && pendingSubagents.has(content.tool_use_id)) {
      const subagent = pendingSubagents.get(content.tool_use_id)!;
      const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
      const durationSecs = Math.round(durationMs / 1000);

      // Extract the actual text content from the subagent's result
      const subagentOutputText = extractTextFromContentBlocks(content.content);

      // Add a summary thought event for the subagent with its output
      const icon = getSubagentIcon(subagent.subagentType);
      const summaryHeader = `${icon} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`;

      // Include the subagent's output text if available
      const thoughtContent = subagentOutputText
        ? `${summaryHeader}\n\n${subagentOutputText}`
        : summaryHeader;

      events.push({
        type: 'thought',
        content: thoughtContent,
        timestamp,
        isSubagentSummary: true
      });

      pendingSubagents.delete(content.tool_use_id);
    }
  }
}

/**
 * Accumulate token usage from a message
 */
function accumulateTokenUsage(
  usage: TokenUsage | undefined,
  tokenUsage: TokenUsageInfo
): void {
  if (!usage) return;
  tokenUsage.input_tokens += usage.input_tokens ?? 0;
  tokenUsage.output_tokens += usage.output_tokens ?? 0;
  tokenUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  tokenUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

/**
 * Detect if content is Codex format (has thread.started or item.completed events)
 */
function isCodexFormat(lines: string[]): boolean {
  for (const line of lines.slice(0, 10)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'thread.started' || parsed.type === 'item.completed' || parsed.type === 'turn.started') {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Parse Codex conversation file (NDJSON format with item events)
 */
function parseCodexConversation(lines: string[]): ParsedConversation {
  const events: ConversationEvent[] = [];
  let todos: TodoItem[] = [];
  const tokenUsage: TokenUsageInfo = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as CodexEvent;
      const timestamp = new Date().toISOString();

      if (event.type === 'item.completed' && event.item) {
        const updatedTodos = processCodexItemCompleted(event.item, timestamp, events);
        if (updatedTodos) {
          todos = updatedTodos;
        }
      } else if (event.type === 'item.updated' && event.item?.type === 'todo_list' && event.item?.items) {
        todos = parseTodoItems(event.item.items);
      } else if (event.type === 'turn.completed' && event.usage) {
        tokenUsage.input_tokens += (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
        tokenUsage.output_tokens += event.usage.output_tokens ?? 0;
      }
    } catch {
      // Skip non-JSON lines (like entrypoint output)
      continue;
    }
  }

  const inProgressTask = todos.find(t => t.status === 'in_progress');
  const currentTask = inProgressTask ? inProgressTask.content : null;
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0;
  const totalEventCount = events.length;
  const limitedEvents = events.length > MAX_EVENTS_FOR_SOCKET
    ? events.slice(-MAX_EVENTS_FOR_SOCKET)
    : events;

  return {
    events: limitedEvents,
    todos,
    currentTask,
    tokenUsage: hasTokens ? tokenUsage : null,
    totalEventCount
  };
}

/**
 * Parse Claude conversation file (JSONL format)
 */
export async function parseConversationFile(conversationPath: string): Promise<ParsedConversation> {
  const conversationContent = await fs.readFile(conversationPath, 'utf8');
  const lines = conversationContent.trim().split('\n').filter(line => line.trim());

  // Detect and handle Codex format
  if (isCodexFormat(lines)) {
    return parseCodexConversation(lines);
  }

  const events: ConversationEvent[] = [];
  let todos: TodoItem[] = [];
  const tokenUsage: TokenUsageInfo = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
  const pendingSubagents: Map<string, PendingSubagent> = new Map();

  for (const line of lines) {
    try {
      const message = JSON.parse(line) as ConversationMessage;
      const timestamp = message.timestamp || new Date().toISOString();

      if (message.type === 'assistant' && message.message?.content) {
        const updatedTodos = processAssistantContent(
          message.message.content,
          timestamp,
          events,
          pendingSubagents
        );
        if (updatedTodos) {
          todos = updatedTodos;
        }
      }

      if (message.type === 'user' && message.message?.content) {
        processUserContent(message.message.content, timestamp, events, pendingSubagents);
      }

      const usage = message.usage || message.message?.usage;
      accumulateTokenUsage(usage, tokenUsage);
    } catch (error) {
      console.error('[ConversationParser] Error parsing conversation line:', error);
    }
  }

  const inProgressTask = todos.find(t => t.status === 'in_progress');
  const currentTask = inProgressTask ? inProgressTask.content : null;

  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
    tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;

  // Track total event count before limiting (for incremental update tracking)
  const totalEventCount = events.length;

  // Limit events to most recent to prevent huge WebSocket payloads
  // Keep only the last MAX_EVENTS_FOR_SOCKET events for real-time updates
  const limitedEvents = events.length > MAX_EVENTS_FOR_SOCKET
    ? events.slice(-MAX_EVENTS_FOR_SOCKET)
    : events;

  return {
    events: limitedEvents,
    todos,
    currentTask,
    tokenUsage: hasTokens ? tokenUsage : null,
    totalEventCount
  };
}
