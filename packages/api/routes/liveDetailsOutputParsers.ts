import { filterAntigravityAnalysisEvents, parseAntigravityJsonl, parseVibeConversationLog } from '@propr/core';
import {
  appendClaudeAssistantMessageEvents,
  appendClaudeUserMessageEvents,
  deriveCurrentTask,
  type ClaudeMessageContent,
} from './liveDetailsCodexParser.js';
import type { TokenUsage, ConversationResult, TodoItem, PendingSubagent } from './liveDetailsTypes.js';

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
