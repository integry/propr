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

/** Result from parsing a conversation file */
export interface ParsedConversation {
  events: ConversationEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage: TokenUsageInfo | null;
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
      events.push({
        type: 'tool_use',
        toolName: content.name,
        input: content.input as Record<string, unknown>,
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

    events.push({
      type: 'tool_result',
      toolUseId: content.tool_use_id,
      result: content.content as unknown,
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

  return {
    events,
    todos,
    currentTask,
    tokenUsage: hasTokens ? tokenUsage : null
  };
}
