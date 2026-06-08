export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface TodoItem { status: string; content: string; }

export interface ConversationResult { events: Array<Record<string, unknown>>; todos: TodoItem[]; currentTask: string | null; tokenUsage: TokenUsage | null; }

export interface PendingSubagent { toolUseId: string; subagentType: string; description: string; startTimestamp: string; }
