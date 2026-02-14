import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

interface LiveDetailsRoutesDeps {
  redisClient: RedisClientType;
  db: Knex;
}

export function createLiveDetailsRoutes(deps: LiveDetailsRoutesDeps) {
  const { redisClient, db } = deps;

  async function getLiveDetails(req: Request, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;
      const taskId = normalizeTaskId(jobId);

      console.log(`[live-details] jobId: ${jobId}, taskId: ${taskId}`);

      const sessionId = await findSessionId(redisClient, db, taskId);
      if (!sessionId) {
        console.log('[live-details] No sessionId found in either SQLite or Redis');
        res.json({ events: [], todos: [], currentTask: null });
        return;
      }

      console.log(`[live-details] Using sessionId: ${sessionId}`);

      const conversationPath = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace', `${sessionId}.jsonl`);
      console.log(`[live-details] Checking Claude conversation path: ${conversationPath}`);

      const pathExists = await fs.pathExists(conversationPath);
      if (!pathExists) {
        console.log('[live-details] Claude conversation file not found');
        res.json({ events: [], todos: [], currentTask: null });
        return;
      }

      const result = await parseConversationFile(conversationPath);
      console.log(`[live-details] Returning: ${result.events.length} events, ${result.todos.length} todos, currentTask: ${result.currentTask ? 'yes' : 'no'}`);

      res.json(result);
    } catch (error) {
      console.error(`Error in /api/task/:taskId/live-details:`, error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getLiveDetails };
}

function normalizeTaskId(jobId: string): string {
  if (jobId.startsWith('issue-')) {
    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }
  return jobId;
}

async function findSessionId(
  redisClient: RedisClientType,
  db: Knex,
  taskId: string
): Promise<string | null> {
  // Check Redis FIRST - it has the live/current execution state
  // This is important for reprocessing: Redis has the new session, DB might have the old one
  const redisSessionId = await findSessionIdFromRedis(redisClient, taskId);
  if (redisSessionId) return redisSessionId;

  // Fall back to DB for completed/historical executions
  return findSessionIdFromDb(db, taskId);
}

async function findSessionIdFromDb(db: Knex, taskId: string): Promise<string | null> {
  try {
    console.log(`[live-details] Fetching sessionId from SQLite for taskId: ${taskId}`);
    const llmExecution = await db('llm_executions')
      .where({ task_id: taskId })
      .orderBy('start_time', 'desc')
      .first();

    if (llmExecution && llmExecution.session_id) {
      console.log(`[live-details] Found sessionId in SQLite: ${llmExecution.session_id}`);
      return llmExecution.session_id as string;
    }
    console.log('[live-details] No LLM execution found in SQLite');
    return null;
  } catch (error) {
    console.error('[live-details] Error fetching from SQLite:', error);
    console.log('[live-details] Falling back to Redis');
    return null;
  }
}

async function findSessionIdFromRedis(redisClient: RedisClientType, taskId: string): Promise<string | null> {
  console.log('[live-details] Trying Redis fallback');
  const stateKey = `worker:state:${taskId}`;
  const stateData = await redisClient.get(stateKey);

  console.log(`[live-details] stateKey: ${stateKey}, hasData: ${!!stateData}`);

  if (!stateData) {
    console.log('[live-details] No state data found in Redis');
    return null;
  }

  const state = JSON.parse(stateData) as { history: Array<{ state: string; metadata?: { sessionId?: string } }> };
  const entry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.sessionId);

  console.log(`[live-details] Found claudeExecutionEntry: ${!!entry}, sessionId: ${entry?.metadata?.sessionId}`);

  if (!entry) {
    console.log('[live-details] No claude_execution entry with sessionId in Redis');
    return null;
  }

  return entry.metadata!.sessionId!;
}

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

async function parseConversationFile(conversationPath: string): Promise<ConversationResult> {
  const conversationContent = await fs.readFile(conversationPath, 'utf8');
  const lines = conversationContent.trim().split('\n').filter(line => line.trim());

  const events: Array<Record<string, unknown>> = [];
  let todos: Array<{ status: string; content: string }> = [];
  // Accumulate token usage across all messages (not just the last one)
  const tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  for (const line of lines) {
    const parsed = parseLine(line, events);
    if (parsed.newTodos) {
      todos = parsed.newTodos;
    }
    if (parsed.tokenUsage) {
      // Accumulate token usage from each message
      tokenUsage.input_tokens += parsed.tokenUsage.input_tokens;
      tokenUsage.output_tokens += parsed.tokenUsage.output_tokens;
      tokenUsage.cache_creation_input_tokens += parsed.tokenUsage.cache_creation_input_tokens;
      tokenUsage.cache_read_input_tokens += parsed.tokenUsage.cache_read_input_tokens;
    }
  }

  const inProgressTask = todos.find(t => t.status === 'in_progress');
  const currentTask = inProgressTask ? inProgressTask.content : null;

  // Return null if no tokens were counted
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
                    tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;

  return { events, todos, currentTask, tokenUsage: hasTokens ? tokenUsage : null };
}

interface ParseLineResult {
  newTodos?: Array<{ status: string; content: string }>;
  tokenUsage?: TokenUsage;
}

interface MessageContent {
  type: string;
  text?: string;
  name?: string;
  input?: { todos?: Array<{ status: string; content: string }> };
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Message {
  type?: string;
  timestamp?: string;
  message?: { content?: MessageContent[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function parseLine(
  line: string,
  events: Array<Record<string, unknown>>
): ParseLineResult {
  try {
    const message = JSON.parse(line) as Message;
    const timestamp = message.timestamp || new Date().toISOString();

    if (message.type === 'assistant' && message.message?.content) {
      return parseAssistantContent(message.message.content, events, timestamp);
    }
    if (message.type === 'user' && message.message?.content) {
      parseUserContent(message.message.content, events, timestamp);
    }
    // Extract token usage from result message or message.usage
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
    console.error(`[live-details] Error parsing line:`, parseError);
  }
  return {};
}

function parseAssistantContent(
  contentArray: MessageContent[],
  events: Array<Record<string, unknown>>,
  timestamp: string
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
    }
  }

  return { newTodos };
}

function parseUserContent(
  contentArray: MessageContent[],
  events: Array<Record<string, unknown>>,
  timestamp: string
): void {
  for (const content of contentArray) {
    if (content.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        toolUseId: content.tool_use_id,
        result: content.content,
        isError: content.is_error || false,
        timestamp
      });
    }
  }
}
