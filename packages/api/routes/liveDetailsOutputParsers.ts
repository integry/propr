import {
  aggregateDeltaMessages,
  filterAntigravityAnalysisEvents,
  getAntigravityAnalysisText,
  parseAntigravityJsonl,
  parseVibeConversationLog,
  type AntigravityOutputEvent,
} from '@propr/core';
import {
  appendClaudeAssistantMessageEvents,
  appendClaudeUserMessageEvents,
  deriveCurrentTask,
  type ClaudeMessageContent,
} from './liveDetailsCodexParser.js';
import type { TokenUsage, ConversationResult, TodoItem, PendingSubagent } from './liveDetailsTypes.js';

function resolveAntigravityLiveDetailsTokenUsage(
  parsedUsage: Partial<TokenUsage>,
  events: AntigravityOutputEvent[],
  hasProtocolError: boolean,
): TokenUsage {
  const usage: TokenUsage = {
    input_tokens: parsedUsage.input_tokens ?? 0,
    output_tokens: parsedUsage.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: parsedUsage.cache_read_input_tokens ?? 0,
  };
  if (!hasProtocolError) return usage;

  // Stored output is an observability source, not execution-success evidence.
  // Preserve valid-shaped usage from partial streams even when strict runtime
  // correlation rejected those envelopes (for example, a result without init).
  for (const event of events) {
    if (!('event' in event) || event.event === 'init') continue;
    const observed = event.event === 'step_update' ? event.step_update.usage : event.result.usage;
    usage.input_tokens = Math.max(usage.input_tokens, observed?.input_tokens ?? 0);
    usage.output_tokens = Math.max(usage.output_tokens, observed?.output_tokens ?? 0);
    usage.cache_read_input_tokens = Math.max(usage.cache_read_input_tokens, observed?.cache_read_tokens ?? 0);
  }
  return usage;
}

export function parseAntigravityOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseAntigravityJsonl(output);
  const events = filterAntigravityAnalysisEvents(aggregateDeltaMessages(parsed.conversationLog)).map(event => ({
    type: 'thought',
    content: getAntigravityAnalysisText(event) ?? '',
    timestamp: 'created_at' in event ? event.created_at : 'timestamp' in event ? event.timestamp : undefined
  })).filter(event => event.content);
  const tokenUsage = resolveAntigravityLiveDetailsTokenUsage(
    parsed.tokenUsage,
    parsed.conversationLog,
    parsed.protocolError !== undefined,
  );
  const hasTokens = tokenUsage.input_tokens > 0
    || tokenUsage.output_tokens > 0
    || tokenUsage.cache_read_input_tokens > 0;
  return events.length || hasTokens ? {
    events,
    todos: [],
    currentTask: null,
    tokenUsage: hasTokens ? tokenUsage : null
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
