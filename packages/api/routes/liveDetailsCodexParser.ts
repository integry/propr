import { parseCodexStreamOutput } from '@propr/core';

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface ConversationResult {
  events: Array<Record<string, unknown>>;
  todos: Array<{ status: string; content: string }>;
  currentTask: string | null;
  tokenUsage: TokenUsage | null;
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
  events: Array<Record<string, unknown>>,
  setTodos: (nextTodos: Array<{ status: string; content: string }>) => void,
  timestamp?: string
): boolean {
  if ((event.item?.type === 'reasoning' || event.item?.type === 'agent_message') && event.item.text) {
    events.push({ type: 'thought', content: event.item.text, timestamp });
    return true;
  }

  if (event.item?.type === 'command_execution') {
    if (event.item.command) {
      pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
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
    setTodos(event.item.items.map(item => ({
      status: item.completed ? 'completed' : 'pending',
      content: item.text
    })));
    return true;
  }

  return false;
}

function buildCodexTokenUsage(parsed: ReturnType<typeof parseCodexStreamOutput>): TokenUsage | null {
  if (!parsed.tokenUsage) {
    return null;
  }

  return {
    input_tokens: parsed.tokenUsage.input_tokens ?? 0,
    output_tokens: parsed.tokenUsage.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

export function parseCodexOutputToConversationResult(output: string): ConversationResult | null {
  const parsed = parseCodexStreamOutput(output);
  if (!parsed.conversationLog || parsed.conversationLog.length === 0) {
    return null;
  }

  const events: Array<Record<string, unknown>> = [];
  let todos: Array<{ status: string; content: string }> = [];

  for (const event of parsed.conversationLog) {
    const timestamp = (event as { timestamp?: string }).timestamp;

    if (event.type === 'message' && event.role === 'assistant' && event.content) {
      events.push({ type: 'thought', content: event.content, timestamp });
      continue;
    }

    if (event.type === 'tool_use' && event.tool) {
      pushCodexToolUseEvent(
        events,
        event.tool,
        event.params as { file_path?: string; command?: string } | undefined,
        timestamp
      );
      continue;
    }

    if (event.type === 'error') {
      pushCodexToolResultEvent(events, event.message || event.result || 'Execution error', true, timestamp);
      continue;
    }

    if (event.type === 'item.started' && event.item?.type === 'command_execution' && event.item.command) {
      pushCodexToolUseEvent(events, 'command_execution', { command: event.item.command }, timestamp);
      continue;
    }

    if (event.type === 'item.completed' && parseCompletedCodexItem(event, events, nextTodos => {
      todos = nextTodos;
    }, timestamp)) {
      continue;
    }
  }

  const currentTask = todos.find(t => t.status === 'pending')?.content || null;
  return { events, todos, currentTask, tokenUsage: buildCodexTokenUsage(parsed) };
}
