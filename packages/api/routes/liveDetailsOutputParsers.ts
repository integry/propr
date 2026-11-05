import {
  aggregateDeltaMessages,
  filterAntigravityAnalysisEvents,
  getAntigravityAnalysisText,
  parseAntigravityJsonl,
  parseVibeConversationLog,
  splitAntigravityInvocations,
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

/**
 * The usage attributable to one invocation. `result.usage` is cumulative over
 * the whole conversation, so it is this invocation's own cost only while the
 * conversation has a single turn; a resumed invocation (num_turns > 1) is
 * measured by its per-step usage instead.
 */
function invocationTokenUsage(usage: TokenUsage, events: AntigravityOutputEvent[]): TokenUsage {
  const result = events.find(event => 'event' in event && event.event === 'result');
  const turns = result && 'event' in result && result.event === 'result' ? result.result.num_turns : undefined;
  if (turns === undefined || turns <= 1) return usage;
  const steps = new Map<number, { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number }>();
  for (const event of events) {
    if ('event' in event && event.event === 'step_update' && event.step_update.usage) steps.set(event.step_update.step_index, event.step_update.usage);
  }
  const own = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const step of steps.values()) {
    own.input_tokens += step.input_tokens ?? 0;
    own.output_tokens += step.output_tokens ?? 0;
    own.cache_read_input_tokens += step.cache_read_tokens ?? 0;
  }
  return own;
}

function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>((total, usage) => ({
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + usage.cache_creation_input_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + usage.cache_read_input_tokens,
  }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
}

/**
 * A running Antigravity invocation publishes its init envelope before any
 * narration; while its task is live, showing that protocol JSON raw would leak
 * envelopes. Terminal, malformed, and finished output keeps its raw fallback.
 */
export function isAntigravityStreamAwaitingNarration(output: string): boolean {
  const latest = parseAntigravityJsonl(splitAntigravityInvocations(output).pop() ?? '');
  return latest.hasStreamEnvelopes && !latest.terminalStatus && !latest.protocolError;
}

export function parseAntigravityOutputToConversationResult(output: string): ConversationResult | null {
  const invocations = splitAntigravityInvocations(output).map(invocation => parseAntigravityJsonl(invocation));
  const events = invocations.flatMap(parsed => filterAntigravityAnalysisEvents(aggregateDeltaMessages(parsed.conversationLog))).map(event => ({
    type: 'thought',
    content: getAntigravityAnalysisText(event) ?? '',
    timestamp: 'created_at' in event ? event.created_at : 'timestamp' in event ? event.timestamp : undefined
  })).filter(event => event.content);
  const tokenUsage = sumTokenUsage(invocations.map(parsed => invocationTokenUsage(
    resolveAntigravityLiveDetailsTokenUsage(parsed.tokenUsage, parsed.conversationLog, parsed.protocolError !== undefined),
    parsed.conversationLog,
  )));
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
