import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { validateTaskId } from './validation.js';
import {
  parseClaudeConversationFile,
  parseClaudeOutputToConversationResult,
  parseCodexOutputToConversationResult,
  type ConversationResult
} from './liveDetailsCodexParser.js';

interface LiveDetailsRoutesDeps { redisClient: RedisClientType; db: Knex; }
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

      const result = await parseClaudeConversationFile(conversationPath);
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
  if (!jobId.startsWith('issue-')) {
    return jobId;
  }

  const parts = jobId.replace(/^issue-/, '').split('-');
  parts.pop();
  return parts.join('-');
}
async function findSessionId(redisClient: RedisClientType, db: Knex, taskId: string): Promise<string | null> {
  const redisSessionId = await findSessionIdFromRedis(redisClient, taskId);
  if (redisSessionId) return redisSessionId;
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

  let state: unknown;
  try {
    state = JSON.parse(stateData);
  } catch (error) {
    console.error('[live-details] Failed to parse Redis state data:', error);
    return null;
  }

  const history = Array.isArray((state as { history?: unknown }).history)
    ? (state as { history: Array<{ state: string; metadata?: { sessionId?: string } }> }).history
    : null;
  if (!history) {
    console.log('[live-details] Redis state data has no usable history array');
    return null;
  }

  const entry = [...history].reverse().find(h => h.metadata?.sessionId);

  console.log(`[live-details] Found Redis history entry with sessionId: ${!!entry}, state: ${entry?.state}, sessionId: ${entry?.metadata?.sessionId}`);

  if (!entry) {
    console.log('[live-details] No Redis history entry with sessionId found');
    return null;
  }

  return entry.metadata!.sessionId!;
}
interface StoredLogData { files?: Record<string, string>; }
interface ExecutionDetailRow { event_type: string; event_timestamp: string; content: string | null; is_error: number | boolean | null; tool_name: string | null; tool_input: string | null; metadata: string | null; }
interface StoredMessageContentBlock { type?: string; text?: string; content?: string; }
interface StoredMessageToolContent { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: { todos?: Array<{ status: string; content: string }>; subagent_type?: string; description?: string; }; content?: unknown; is_error?: boolean; }
interface PendingSubagent { toolUseId: string; subagentType: string; description: string; startTimestamp: string; }
interface StoredMessageContext { timestamp: string; events: Array<Record<string, unknown>>; pendingSubagents: Map<string, PendingSubagent>; setTodos: (todos: Array<{ status: string; content: string }>) => void; }
interface RawExecutionEvent { type?: string; role?: string; content?: string; tool?: string; params?: { file_path?: string; command?: string }; message?: string; result?: string; item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean; status?: string }> }; }
interface StoredExecutionOutputLine { type?: string; role?: string; message?: unknown; session_id?: string; conversation_id?: string; item?: unknown; }
function mapTodoStatus(item: { completed?: boolean; status?: string }): 'completed' | 'in_progress' | 'pending' {
  if (item.status === 'completed' || item.completed) return 'completed';
  if (item.status === 'in_progress' || item.status === 'active' || item.status === 'running') return 'in_progress';
  return 'pending';
}
function mapTodoItems(items: Array<{ text?: string; completed?: boolean; status?: string }>): Array<{ status: string; content: string }> {
  return items.map(item => ({ status: mapTodoStatus(item), content: item.text || '' }));
}
function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const textParts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typedBlock = block as StoredMessageContentBlock;
      return typedBlock.type === 'text' && typedBlock.text ? typedBlock.text : (typedBlock.content ?? '');
    })
    .filter(Boolean);
  return textParts.length > 0 ? textParts.join('\n\n') : null;
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
function buildSubagentSummary(subagent: PendingSubagent, content: StoredMessageToolContent, timestamp: string): string {
  const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
  const durationSecs = Math.round(durationMs / 1000);
  const subagentOutputText = extractTextFromContentBlocks(content.content);
  const summaryHeader = `${getSubagentIcon(subagent.subagentType)} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`;
  return subagentOutputText ? `${summaryHeader}\n\n${subagentOutputText}` : summaryHeader;
}
async function parseStoredExecutionOutput(redisClient: RedisClientType, sessionId: string): Promise<ConversationResult | null> {
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
  return parseStoredOutputContent(output);
}

function parseStoredOutputContent(output: string): ConversationResult | null {
  if (!output.trim()) {
    return null;
  }

  if (looksLikeClaudeOutput(output)) {
    return parseClaudeOutputToConversationResult(output);
  }

  return parseCodexOutputToConversationResult(output);
}

function looksLikeClaudeOutput(output: string): boolean {
  const firstLine = output
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);

  if (!firstLine) {
    return false;
  }

  try {
    const parsed = JSON.parse(firstLine) as StoredExecutionOutputLine;
    return parsed.type === 'assistant'
      || parsed.type === 'user'
      || parsed.type === 'result'
      || !!parsed.message
      || !!parsed.session_id
      || !!parsed.conversation_id;
  } catch {
    return false;
  }
}
async function parseExecutionDetailsFromDb(db: Knex, taskId: string, sessionId: string): Promise<ConversationResult | null> {
  const execution = await db('llm_executions')
    .where({ task_id: taskId, session_id: sessionId })
    .orderBy('start_time', 'desc')
    .first('execution_id', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens');

  if (!execution?.execution_id) return null;
  const details = await db('llm_execution_details')
    .where({ execution_id: execution.execution_id })
    .orderBy('sequence_number', 'asc')
    .select('event_type', 'event_timestamp', 'content', 'is_error', 'tool_name', 'tool_input', 'metadata');
  if (!details.length) return null;
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
  const pendingSubagents = new Map<string, PendingSubagent>();
  for (const row of details) {
    const timestamp = row.event_timestamp;
    const metadataHandled = appendEventFromMetadata(row, timestamp, events, nextTodos => { todos = nextTodos; });
    if (metadataHandled) continue;
    if (appendStoredMessageEvent(row, {
      timestamp,
      events,
      pendingSubagents,
      setTodos: nextTodos => { todos = nextTodos; }
    })) continue;
    if (appendToolUseEvent(row, timestamp, events)) continue;
    if (appendErrorEvent(row, timestamp, events)) continue;
    appendFallbackContentEvent(row, timestamp, events);
  }
  const currentTask = todos.find(t => t.status === 'in_progress')?.content
    || todos.find(t => t.status === 'pending')?.content
    || null;
  return { events, todos, currentTask };
}
function appendEventFromMetadata(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>, setTodos: (todos: Array<{ status: string; content: string }>) => void): boolean {
  if (!row.metadata) return false;
  try {
    const rawEvent = JSON.parse(row.metadata) as RawExecutionEvent;
    if (rawEvent.type === 'message' && rawEvent.role === 'assistant' && rawEvent.content) {
      events.push({ type: 'thought', content: rawEvent.content, timestamp });
      return true;
    }
    if (rawEvent.type === 'tool_use') {
      events.push({ type: 'tool_use', toolName: rawEvent.tool, input: rawEvent.params, timestamp });
      return true;
    }
    if (rawEvent.type === 'error') {
      events.push({ type: 'tool_result', result: rawEvent.message || rawEvent.result || row.content || 'Execution error', isError: true, timestamp });
      return true;
    }
    if (appendCommandExecutionEvents(rawEvent, timestamp, events)) return true;
    if ((rawEvent.item?.type === 'reasoning' || rawEvent.item?.type === 'agent_message') && rawEvent.item.text) {
      events.push({ type: 'thought', content: rawEvent.item.text, timestamp });
      return true;
    }
    if (rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
      setTodos(mapTodoItems(rawEvent.item.items));
      return true;
    }
  } catch (error) {
    console.error('[live-details] Failed to parse execution detail metadata:', error);
  }
  return false;
}
function appendStoredMessageEvent(row: ExecutionDetailRow, context: StoredMessageContext): boolean {
  if ((row.event_type !== 'user' && row.event_type !== 'assistant') || !row.content) return false;
  try {
    const parsedContent = JSON.parse(row.content) as { content?: StoredMessageToolContent[] };
    const contentBlocks = parsedContent.content;
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return false;
    if (row.event_type === 'assistant') return appendAssistantStoredMessageEvents(contentBlocks, context);
    return appendUserStoredMessageEvents(contentBlocks, context);
  } catch {
    return false;
  }
}
function appendAssistantStoredMessageEvents(contentBlocks: StoredMessageToolContent[], context: StoredMessageContext): boolean {
  let handled = false;
  for (const content of contentBlocks) {
    if (appendAssistantTextContent(content, context)) {
      handled = true;
      continue;
    }
    if (appendAssistantToolUseContent(content, context)) {
      handled = true;
    }
  }
  return handled;
}
function appendAssistantTextContent(content: StoredMessageToolContent, context: StoredMessageContext): boolean {
  const textContent = typeof content.text === 'string'
    ? content.text
    : (typeof content.content === 'string' ? content.content : '');
  if (content.type !== 'text' || !textContent) return false;
  context.events.push({ type: 'thought', content: textContent, timestamp: context.timestamp });
  return true;
}
function appendAssistantToolUseContent(content: StoredMessageToolContent, context: StoredMessageContext): boolean {
  if (content.type !== 'tool_use') return false;
  context.events.push({
    type: 'tool_use',
    toolName: content.name,
    input: content.input,
    id: content.id,
    timestamp: context.timestamp
  });
  if (content.name === 'TodoWrite' && content.input?.todos) context.setTodos(content.input.todos);
  if (content.name === 'Task' && content.id) {
    context.pendingSubagents.set(content.id, {
      toolUseId: content.id,
      subagentType: content.input?.subagent_type || 'unknown',
      description: content.input?.description || '',
      startTimestamp: context.timestamp
    });
  }
  return true;
}
function appendUserStoredMessageEvents(contentBlocks: StoredMessageToolContent[], context: StoredMessageContext): boolean {
  let handled = false;
  for (const content of contentBlocks) {
    if (!appendUserToolResultContent(content, context)) continue;
    handled = true;
  }
  return handled;
}
function appendUserToolResultContent(content: StoredMessageToolContent, context: StoredMessageContext): boolean {
  if (content.type !== 'tool_result') return false;
  context.events.push({
    type: 'tool_result',
    toolUseId: content.tool_use_id,
    result: content.content,
    isError: content.is_error || false,
    timestamp: context.timestamp
  });
  if (!content.tool_use_id || !context.pendingSubagents.has(content.tool_use_id)) return true;
  const subagent = context.pendingSubagents.get(content.tool_use_id)!;
  context.events.push({
    type: 'thought',
    content: buildSubagentSummary(subagent, content, context.timestamp),
    timestamp: context.timestamp,
    isSubagentSummary: true
  });
  context.pendingSubagents.delete(content.tool_use_id);
  return true;
}
function appendCommandExecutionEvents(rawEvent: RawExecutionEvent, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (rawEvent.item?.type !== 'command_execution') return false;
  if (rawEvent.item.command) events.push({ type: 'tool_use', toolName: 'command_execution', input: { command: rawEvent.item.command }, timestamp });
  if (rawEvent.item.aggregated_output) events.push({
    type: 'tool_result', result: rawEvent.item.aggregated_output, isError: rawEvent.item.exit_code != null && rawEvent.item.exit_code !== 0, timestamp
  });
  return true;
}
function parseToolInput(toolInput: string | null): { file_path?: string; command?: string } | undefined {
  if (!toolInput) return undefined;
  try {
    return JSON.parse(toolInput) as { file_path?: string; command?: string };
  } catch {
    return undefined;
  }
}
function appendToolUseEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (row.event_type !== 'tool_use' || !row.tool_name) return false;
  events.push({ type: 'tool_use', toolName: row.tool_name, input: parseToolInput(row.tool_input), timestamp });
  return true;
}
function appendErrorEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): boolean {
  if (row.event_type !== 'error') return false;
  events.push({ type: 'tool_result', result: row.content || 'Execution error', isError: true, timestamp });
  return true;
}
function appendFallbackContentEvent(row: ExecutionDetailRow, timestamp: string, events: Array<Record<string, unknown>>): void {
  if (!row.content) return;
  events.push({ type: row.tool_name ? 'tool_result' : 'thought', content: row.tool_name ? undefined : row.content, result: row.tool_name ? row.content : undefined, isError: Boolean(row.is_error), timestamp });
}
