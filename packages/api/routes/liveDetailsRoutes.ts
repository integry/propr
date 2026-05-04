import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { validateTaskId } from './validation.js';
import { parseCodexOutputToConversationResult } from './liveDetailsCodexParser.js';

interface LiveDetailsRoutesDeps {
  redisClient: RedisClientType;
  db: Knex;
}

export function createLiveDetailsRoutes(deps: LiveDetailsRoutesDeps) {
  const { redisClient, db } = deps;

  async function getLiveDetails(req: Request, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;

      // Validate taskId parameter
      const taskIdValidation = validateTaskId(jobId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

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
        console.log('[live-details] Claude conversation file not found, trying stored execution output fallback');
        const fallbackResult = await parseStoredExecutionOutput(redisClient, sessionId);
        if (fallbackResult) {
          res.json(fallbackResult);
          return;
        }

        console.log('[live-details] Stored execution output fallback unavailable, trying database fallback');
        const dbFallbackResult = await parseExecutionDetailsFromDb(db, taskId, sessionId);
        if (!dbFallbackResult) {
          res.json({ events: [], todos: [], currentTask: null });
          return;
        }
        res.json(dbFallbackResult);
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

interface StoredLogData {
  files?: Record<string, string>;
}

interface ExecutionDetailRow {
  event_type: string;
  event_timestamp: string;
  content: string | null;
  is_error: number | boolean | null;
  tool_name: string | null;
  tool_input: string | null;
  metadata: string | null;
}

interface PendingSubagent {
  toolUseId: string;
  subagentType: string;
  description: string;
  startTimestamp: string;
}

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

async function parseConversationFile(conversationPath: string): Promise<ConversationResult> {
  const conversationContent = await fs.readFile(conversationPath, 'utf8');
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
    console.error(`[live-details] Error parsing line:`, parseError);
  }
  return {};
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
        const input = content.input as { subagent_type?: string; description?: string } | undefined;
        pendingSubagents.set(content.id, {
          toolUseId: content.id,
          subagentType: input?.subagent_type || 'unknown',
          description: input?.description || '',
          startTimestamp: timestamp
        });
      }
    }
  }

  return { newTodos };
}

function parseUserContent(
  contentArray: MessageContent[],
  events: Array<Record<string, unknown>>,
  timestamp: string,
  pendingSubagents: Map<string, PendingSubagent>
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

      if (content.tool_use_id && pendingSubagents.has(content.tool_use_id)) {
        const subagent = pendingSubagents.get(content.tool_use_id)!;
        const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
        const durationSecs = Math.round(durationMs / 1000);
        const subagentOutputText = extractTextFromContentBlocks(content.content);
        const subagentIcon = getSubagentIcon(subagent.subagentType);
        const summaryHeader = `${subagentIcon} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`;
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

async function parseStoredExecutionOutput(
  redisClient: RedisClientType,
  sessionId: string
): Promise<ConversationResult | null> {
  const logJson = await redisClient.get(`execution:logs:session:${sessionId}`);
  if (!logJson) {
    console.log('[live-details] No stored execution logs found in Redis for session fallback');
    return null;
  }

  let logData: StoredLogData;
  try {
    logData = JSON.parse(logJson) as StoredLogData;
  } catch (error) {
    console.error('[live-details] Failed to parse stored execution log metadata:', error);
    return null;
  }

  const outputPath = logData.files?.output;
  if (!outputPath || !(await fs.pathExists(outputPath))) {
    console.log('[live-details] Stored execution output file missing for session fallback');
    return null;
  }

  const output = await fs.readFile(outputPath, 'utf8');
  return parseCodexOutputToConversationResult(output);
}

async function parseExecutionDetailsFromDb(
  db: Knex,
  taskId: string,
  sessionId: string
): Promise<ConversationResult | null> {
  const execution = await db('llm_executions')
    .where({ task_id: taskId, session_id: sessionId })
    .orderBy('start_time', 'desc')
    .first('execution_id', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens');

  if (!execution?.execution_id) {
    return null;
  }

  const details = await db('llm_execution_details')
    .where({ execution_id: execution.execution_id })
    .orderBy('sequence_number', 'asc')
    .select('event_type', 'event_timestamp', 'content', 'is_error', 'tool_name', 'tool_input', 'metadata');

  if (!details.length) {
    return null;
  }

  const result = parseExecutionDetailsRows(details as ExecutionDetailRow[]);
  const hasTokens = (execution.input_tokens ?? 0) || (execution.output_tokens ?? 0) ||
    (execution.cache_creation_input_tokens ?? 0) || (execution.cache_read_input_tokens ?? 0);

  return {
    ...result,
    tokenUsage: hasTokens ? {
      input_tokens: execution.input_tokens ?? 0,
      output_tokens: execution.output_tokens ?? 0,
      cache_creation_input_tokens: execution.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: execution.cache_read_input_tokens ?? 0
    } : null
  };
}

function parseExecutionDetailsRows(details: ExecutionDetailRow[]): Omit<ConversationResult, 'tokenUsage'> {
  const events: Array<Record<string, unknown>> = [];
  let todos: Array<{ status: string; content: string }> = [];

  for (const row of details) {
    const timestamp = row.event_timestamp;

    if (row.metadata) {
      try {
        const rawEvent = JSON.parse(row.metadata) as {
          type?: string;
          role?: string;
          content?: string;
          tool?: string;
          params?: { file_path?: string; command?: string };
          message?: string;
          result?: string;
          item?: {
            type?: string;
            text?: string;
            command?: string;
            aggregated_output?: string;
            exit_code?: number | null;
            items?: Array<{ text?: string; completed?: boolean }>;
          };
        };

        if (rawEvent.type === 'message' && rawEvent.role === 'assistant' && rawEvent.content) {
          events.push({ type: 'thought', content: rawEvent.content, timestamp });
          continue;
        }

        if (rawEvent.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            toolName: rawEvent.tool,
            input: rawEvent.params,
            timestamp
          });
          continue;
        }

        if (rawEvent.type === 'error') {
          events.push({
            type: 'tool_result',
            result: rawEvent.message || rawEvent.result || row.content || 'Execution error',
            isError: true,
            timestamp
          });
          continue;
        }

        if (rawEvent.item?.type === 'command_execution') {
          if (rawEvent.item.command) {
            events.push({
              type: 'tool_use',
              toolName: 'command_execution',
              input: { command: rawEvent.item.command },
              timestamp
            });
          }
          if (rawEvent.item.aggregated_output) {
            events.push({
              type: 'tool_result',
              result: rawEvent.item.aggregated_output,
              isError: rawEvent.item.exit_code != null && rawEvent.item.exit_code !== 0,
              timestamp
            });
          }
          continue;
        }

        if ((rawEvent.item?.type === 'reasoning' || rawEvent.item?.type === 'agent_message') && rawEvent.item.text) {
          events.push({ type: 'thought', content: rawEvent.item.text, timestamp });
          continue;
        }

        if (rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
          todos = rawEvent.item.items.map(item => ({
            status: item.completed ? 'completed' : 'pending',
            content: item.text || ''
          }));
          continue;
        }
      } catch (error) {
        console.error('[live-details] Failed to parse execution detail metadata:', error);
      }
    }

    if (row.event_type === 'tool_use' && row.tool_name) {
      let input: { file_path?: string; command?: string } | undefined;
      if (row.tool_input) {
        try {
          input = JSON.parse(row.tool_input) as { file_path?: string; command?: string };
        } catch {
          input = undefined;
        }
      }
      events.push({ type: 'tool_use', toolName: row.tool_name, input, timestamp });
      continue;
    }

    if (row.event_type === 'error') {
      events.push({
        type: 'tool_result',
        result: row.content || 'Execution error',
        isError: true,
        timestamp
      });
      continue;
    }

    if (row.content) {
      events.push({
        type: row.tool_name ? 'tool_result' : 'thought',
        content: row.tool_name ? undefined : row.content,
        result: row.tool_name ? row.content : undefined,
        isError: Boolean(row.is_error),
        timestamp
      });
    }
  }

  const currentTask = todos.find(t => t.status === 'in_progress')?.content
    || todos.find(t => t.status === 'pending')?.content
    || null;

  return { events, todos, currentTask };
}
