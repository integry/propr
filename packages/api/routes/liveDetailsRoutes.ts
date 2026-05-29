import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { validateTaskId } from './validation.js';
import {
  appendClaudeAssistantMessageEvents,
  appendClaudeUserMessageEvents,
  deriveCurrentTask,
  isConversationResultEmpty,
  mapTodoItems,
  parseClaudeConversationFile,
  parseClaudeOutputToConversationResult,
  parseCodexOutputToConversationResult,
  parseOpenCodeOutputToConversationResult,
  type ClaudeMessageContent,
  type ClaudeMessageContext,
  type ConversationResult,
  type PendingSubagent,
  type TodoItem
} from './liveDetailsCodexParser.js';

interface LiveDetailsRoutesDeps { redisClient: RedisClientType; db: Knex; }
interface HistoryEntryWithSessionMetadata { state?: string; metadata?: { sessionId?: string }; }
const LIVE_EXECUTION_STATES = new Set(['claude_execution', 'codex_execution', 'gemini_execution', 'opencode_execution']);
export function createLiveDetailsRoutes(deps: LiveDetailsRoutesDeps) {
  const { redisClient, db } = deps;
  async function getLiveDetails(req: Request, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;
      const taskIdValidation = validateTaskId(jobId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }
      const taskId = normalizeTaskId(jobId);
      console.log(`[live-details] jobId: ${jobId}, taskId: ${taskId}`);
      const sessionId = await findSessionId(redisClient, db, taskId);
      if (!sessionId) {
        const activeRedisResult = await parseActiveExecutionOutput(redisClient, taskId);
        if (activeRedisResult) {
          res.json(activeRedisResult);
          return;
        }
        console.log('[live-details] No sessionId found in either SQLite or Redis');
        res.json({ events: [], todos: [], currentTask: null });
        return;
      }
      console.log(`[live-details] Using sessionId: ${sessionId}`);
      const conversationPath = await findClaudeConversationPath(sessionId);
      console.log(`[live-details] Checking Claude conversation path: ${conversationPath ?? 'not found'}`);
      if (!conversationPath) {
        console.log('[live-details] Claude conversation file not found, trying active Redis output');
        const activeRedisResult = await parseActiveExecutionOutput(redisClient, taskId);
        if (activeRedisResult) {
          res.json(activeRedisResult);
          return;
        }
        console.log('[live-details] Claude conversation file not found, trying stored execution output fallback');
        const fallbackResult = await parseStoredExecutionOutput(redisClient, sessionId);
        if (fallbackResult) {
          res.json(fallbackResult);
          return;
        }
        console.log('[live-details] Stored execution output fallback unavailable, trying database fallback');
        const dbFallbackResult = await parseExecutionDetailsFromDb(db, taskId, sessionId);
        if (!dbFallbackResult) {
          const rawStoredOutput = await loadStoredExecutionOutput(redisClient, sessionId);
          if (rawStoredOutput?.rawFallback) {
            res.json(rawStoredOutput.rawFallback);
            return;
          }
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
  if (!jobId.startsWith('issue-')) return jobId;
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
    ? (state as { history: HistoryEntryWithSessionMetadata[] }).history
    : null;
  if (!history) { console.log('[live-details] Redis state data has no usable history array'); return null; }
  const entry = findLatestHistoryEntryWithSessionId(history);
  console.log(`[live-details] Found Redis history entry with sessionId: ${!!entry}, state: ${entry?.state}, sessionId: ${entry?.metadata?.sessionId}`);
  if (!entry) { console.log('[live-details] No Redis history entry with sessionId found'); return null; }
  return entry.metadata!.sessionId!;
}
export function findLatestHistoryEntryWithSessionId(history: HistoryEntryWithSessionMetadata[]): HistoryEntryWithSessionMetadata | null {
  for (const entry of [...history].reverse()) {
    if (LIVE_EXECUTION_STATES.has(entry.state ?? '') && typeof entry.metadata?.sessionId === 'string' && entry.metadata.sessionId.trim().length > 0) return entry;
  }
  return null;
}
interface StoredLogData { files?: Record<string, string>; }
interface ExecutionDetailRow { event_type: string; event_timestamp: string; content: string | null; is_error: number | boolean | null; tool_name: string | null; tool_input: string | null; metadata: string | null; }
interface RawExecutionEvent { type?: string; role?: string; content?: unknown; tool?: string; params?: { file_path?: string; command?: string }; message?: string; result?: string; item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean; status?: string }> }; }
interface StoredExecutionOutputLine { type?: string; role?: string; message?: unknown; sessionID?: string; session_id?: string; conversation_id?: string; item?: unknown; part?: unknown; parts?: unknown[]; }
export type StoredOutputFormat = 'claude' | 'codex' | 'opencode' | 'unknown';
export interface ParsedStoredOutput {
  parsed: ConversationResult | null;
  rawFallback: ConversationResult | null;
  format: StoredOutputFormat;
}
function getClaudeProjectDirName(workspacePath: string): string {
  const normalizedPath = path.resolve(workspacePath).replace(/\\/g, '/');
  const collapsed = normalizedPath.replace(/\/+/g, '-');
  return collapsed.startsWith('-') ? collapsed : `-${collapsed}`;
}
function getClaudeConversationPathCandidates(sessionId: string): string[] {
  const configuredProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
  const projectDirNames = new Set([getClaudeProjectDirName(process.cwd()), '-home-node-workspace']);
  const baseDirs = configuredProjectsDir ? [configuredProjectsDir] : [path.join(os.homedir(), '.claude', 'projects')];
  return baseDirs.flatMap(baseDir =>
    [...projectDirNames].map(projectDirName => path.join(baseDir, projectDirName, `${sessionId}.jsonl`))
  );
}
async function findClaudeConversationPath(sessionId: string): Promise<string | null> {
  for (const candidatePath of getClaudeConversationPathCandidates(sessionId)) {
    if (await fs.pathExists(candidatePath)) return candidatePath;
  }
  return null;
}
async function parseStoredExecutionOutput(redisClient: RedisClientType, sessionId: string): Promise<ConversationResult | null> {
  const parsedOutput = await loadStoredExecutionOutput(redisClient, sessionId);
  return parsedOutput?.parsed ?? null;
}
async function loadStoredExecutionOutput(redisClient: RedisClientType, sessionId: string): Promise<ParsedStoredOutput | null> {
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
async function parseActiveExecutionOutput(redisClient: RedisClientType, taskId: string): Promise<ConversationResult | null> {
  const output = await redisClient.get(`agent:output:${taskId}`);
  if (!output?.trim()) return null;
  const parsedOutput = parseStoredOutputContent(output);
  return parsedOutput.parsed ?? parsedOutput.rawFallback;
}
export function parseStoredOutputContent(output: string): ParsedStoredOutput {
  if (!output.trim()) return { parsed: null, rawFallback: null, format: 'unknown' };
  const format = detectStoredOutputFormat(output);
  if (format === 'claude') {
    const parsed = parseClaudeOutputToConversationResult(output);
    return { parsed: isConversationResultEmpty(parsed) ? null : parsed, rawFallback: buildRawOutputConversationResult(output), format };
  }
  if (format === 'codex') {
    const parsed = parseCodexOutputToConversationResult(output);
    return { parsed: isConversationResultEmpty(parsed) ? null : parsed, rawFallback: buildRawOutputConversationResult(output), format };
  }
  if (format === 'opencode') {
    const parsed = parseOpenCodeOutputToConversationResult(output);
    return { parsed: isConversationResultEmpty(parsed) ? null : parsed, rawFallback: buildRawOutputConversationResult(output), format };
  }
  const opencodeParsed = parseOpenCodeOutputToConversationResult(output);
  if (!isConversationResultEmpty(opencodeParsed)) return { parsed: opencodeParsed, rawFallback: buildRawOutputConversationResult(output), format: 'opencode' };
  const codexParsed = parseCodexOutputToConversationResult(output);
  if (!isConversationResultEmpty(codexParsed)) return { parsed: codexParsed, rawFallback: buildRawOutputConversationResult(output), format: 'codex' };
  const claudeParsed = parseClaudeOutputToConversationResult(output);
  if (!isConversationResultEmpty(claudeParsed)) return { parsed: claudeParsed, rawFallback: buildRawOutputConversationResult(output), format: 'claude' };
  return { parsed: null, rawFallback: buildRawOutputConversationResult(output), format };
}
export function detectStoredOutputFormat(output: string): StoredOutputFormat {
  const firstLine = output.split('\n').map(line => line.trim()).find(line => line.length > 0);
  if (!firstLine) return 'unknown';
  try {
    const parsed = JSON.parse(firstLine) as StoredExecutionOutputLine;
    const type = parsed.type?.toLowerCase();
    if (parsed.sessionID || parsed.part || parsed.parts || (type === 'message' && typeof parsed.message === 'object' && parsed.message !== null)) {
      return 'opencode';
    }
    if (parsed.type === 'message'
      || parsed.type === 'tool_use'
      || parsed.type === 'error'
      || parsed.type === 'result'
      || parsed.type === 'turn.started'
      || parsed.type === 'turn.completed'
      || parsed.type === 'item.started'
      || parsed.type === 'item.updated'
      || parsed.type === 'item.completed'
      || parsed.item !== undefined) {
      return 'codex';
    }

    if (parsed.type === 'assistant' || parsed.type === 'user' || !!parsed.session_id || !!parsed.conversation_id) {
      return 'claude';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
function buildRawOutputConversationResult(output: string): ConversationResult | null {
  const trimmed = output.trim();
  return trimmed ? { events: [{ type: 'thought', content: trimmed }], todos: [], currentTask: null, tokenUsage: null } : null;
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
  const hasTokens = (execution.input_tokens ?? 0) || (execution.output_tokens ?? 0) || (execution.cache_creation_input_tokens ?? 0) || (execution.cache_read_input_tokens ?? 0);
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
  let todos: TodoItem[] = [];
  const pendingSubagents = new Map<string, PendingSubagent>();
  for (const row of details) {
    const timestamp = row.event_timestamp;
    const metadataHandled = appendEventFromMetadata(row, { timestamp, events, pendingSubagents, setTodos: nextTodos => { todos = nextTodos; } });
    if (metadataHandled) continue;
    if (appendStoredMessageEvent(row, { timestamp, events, pendingSubagents, setTodos: nextTodos => { todos = nextTodos; } })) continue;
    if (appendToolUseEvent(row, timestamp, events)) continue;
    if (appendErrorEvent(row, timestamp, events)) continue;
    appendFallbackContentEvent(row, timestamp, events);
  }
  const currentTask = deriveCurrentTask(todos);
  return { events, todos, currentTask };
}
function appendEventFromMetadata(row: ExecutionDetailRow, context: ClaudeMessageContext): boolean {
  if (!row.metadata) return false;
  try {
    const rawEvent = JSON.parse(row.metadata) as RawExecutionEvent;
    if (appendMetadataMessageEvent(rawEvent, context)) return true;
    if (rawEvent.type === 'tool_use') {
      context.events.push({ type: 'tool_use', toolName: rawEvent.tool, input: rawEvent.params, timestamp: context.timestamp });
      return true;
    }
    if (rawEvent.type === 'error') {
      context.events.push({ type: 'tool_result', result: rawEvent.message || rawEvent.result || row.content || 'Execution error', isError: true, timestamp: context.timestamp });
      return true;
    }
    if (appendCommandExecutionEvents(rawEvent, context.timestamp, context.events)) return true;
    if ((rawEvent.item?.type === 'reasoning' || rawEvent.item?.type === 'agent_message') && rawEvent.item.text) {
      context.events.push({ type: 'thought', content: rawEvent.item.text, timestamp: context.timestamp });
      return true;
    }
    if (rawEvent.item?.type === 'todo_list' && rawEvent.item.items) {
      context.setTodos(mapTodoItems(rawEvent.item.items));
      return true;
    }
  } catch (error) {
    console.error('[live-details] Failed to parse execution detail metadata:', error);
  }
  return false;
}
function appendMetadataMessageEvent(rawEvent: RawExecutionEvent, context: ClaudeMessageContext): boolean {
  if (rawEvent.type !== 'message' || !rawEvent.content) return false;
  if (rawEvent.role === 'assistant') {
    if (typeof rawEvent.content === 'string') {
      context.events.push({ type: 'thought', content: rawEvent.content, timestamp: context.timestamp });
      return true;
    }
    const assistantContent = extractMessageContentBlocks(rawEvent.content);
    return assistantContent ? appendClaudeAssistantMessageEvents(assistantContent, context) : false;
  }
  if (rawEvent.role === 'user') {
    const userContent = extractMessageContentBlocks(rawEvent.content);
    return userContent ? appendClaudeUserMessageEvents(userContent, context) : false;
  }
  return false;
}
function extractMessageContentBlocks(content: unknown): ClaudeMessageContent[] | null {
  if (Array.isArray(content)) return content as ClaudeMessageContent[];
  if (content && typeof content === 'object' && Array.isArray((content as { content?: unknown }).content)) {
    return (content as { content: ClaudeMessageContent[] }).content;
  }
  return null;
}
function appendStoredMessageEvent(row: ExecutionDetailRow, context: ClaudeMessageContext): boolean {
  if ((row.event_type !== 'user' && row.event_type !== 'assistant') || !row.content) return false;
  try {
    const contentBlocks = (JSON.parse(row.content) as { content?: ClaudeMessageContent[] }).content;
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return false;
    if (row.event_type === 'assistant') return appendClaudeAssistantMessageEvents(contentBlocks, context);
    return appendClaudeUserMessageEvents(contentBlocks, context);
  } catch {
    return false;
  }
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
  try { return JSON.parse(toolInput) as { file_path?: string; command?: string }; } catch { return undefined; }
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
