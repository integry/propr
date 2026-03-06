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

/** Maximum length for tool result content to prevent huge payloads */
const MAX_RESULT_LENGTH = 2000;

/** Maximum number of events to include in WebSocket payloads */
const MAX_EVENTS_FOR_SOCKET = 100;

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

      const icon = getSubagentIcon(subagent.subagentType);
      events.push({
        type: 'thought',
        content: `${icon} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`,
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
 * Parse Claude conversation file (JSONL format)
 */
export async function parseConversationFile(conversationPath: string): Promise<ParsedConversation> {
  const conversationContent = await fs.readFile(conversationPath, 'utf8');
  const lines = conversationContent.trim().split('\n').filter(line => line.trim());

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
