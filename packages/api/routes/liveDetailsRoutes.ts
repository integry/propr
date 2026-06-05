import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { validateTaskId } from './validation.js';
import {
  isConversationResultEmpty,
  parseClaudeConversationFile,
  parseClaudeOutputToConversationResult,
  parseCodexOutputToConversationResult,
  parseVibeOutputToConversationResult,
  type ConversationResult
} from './liveDetailsCodexParser.js';
import { parseExecutionDetailsRows, type ExecutionDetailRow } from './liveDetailsExecutionParser.js';
import { parseRedisOutput } from '../services/redisOutputParser.js';
import { detectStoredOutputFormat, type StoredOutputFormat } from './liveDetailsStoredOutputFormat.js';

interface LiveDetailsRoutesDeps { redisClient: RedisClientType; db: Knex; }
interface HistoryEntryWithSessionMetadata { state?: string; timestamp?: string; metadata?: { sessionId?: string }; }
const LIVE_EXECUTION_STATES = new Set(['claude_execution', 'codex_execution', 'antigravity_execution', 'gemini_execution']);
const EXECUTION_TIMING_STATES = new Set(['claude_execution', 'codex_execution', 'antigravity_execution', 'gemini_execution', 'vibe_execution']);
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
        const activeRedisResult = await parseActiveExecutionOutput(redisClient, db, taskId);
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
        const activeRedisResult = await parseActiveExecutionOutput(redisClient, db, taskId);
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

async function findExecutionStartTimestamp(redisClient: RedisClientType, db: Knex, taskId: string): Promise<string | null> {
  const redisTimestamp = await findExecutionStartTimestampFromRedis(redisClient, taskId);
  if (redisTimestamp) return redisTimestamp;
  return findExecutionStartTimestampFromDb(db, taskId);
}

async function findExecutionStartTimestampFromRedis(redisClient: RedisClientType, taskId: string): Promise<string | null> {
  try {
    const stateData = await redisClient.get(`worker:state:${taskId}`);
    if (!stateData) return null;
    const state = JSON.parse(stateData) as { history?: HistoryEntryWithSessionMetadata[] };
    const history = Array.isArray(state.history) ? state.history : [];
    const entry = history.find(item => item.timestamp && EXECUTION_TIMING_STATES.has(item.state ?? ''))
      || history.find(item => item.timestamp && (item.state ?? '').endsWith('_execution'));
    return entry?.timestamp ?? null;
  } catch {
    return null;
  }
}

async function findExecutionStartTimestampFromDb(db: Knex, taskId: string): Promise<string | null> {
  try {
    const llmExecution = await db('llm_executions')
      .where({ task_id: taskId })
      .orderBy('start_time', 'desc')
      .first('start_time');
    const startTime = llmExecution?.start_time;
    return startTime ? new Date(startTime as string | Date).toISOString() : null;
  } catch {
    return null;
  }
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
export { detectStoredOutputFormat, type StoredOutputFormat } from './liveDetailsStoredOutputFormat.js';
export interface ParsedStoredOutput { parsed: ConversationResult | null; rawFallback: ConversationResult | null; format: StoredOutputFormat; }
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
async function parseActiveExecutionOutput(redisClient: RedisClientType, db: Knex, taskId: string): Promise<ConversationResult | null> {
  const output = await redisClient.get(`agent:output:${taskId}`);
  if (!output?.trim()) return null;
  const executionStartTimestamp = await findExecutionStartTimestamp(redisClient, db, taskId);
  const redisParsed = parseRedisOutput(output.split('\n').filter(line => line.trim()), { executionStartTimestamp });
  if (redisParsed.events.length > 0 || redisParsed.todos.length > 0 || redisParsed.currentTask || redisParsed.tokenUsage) {
    return {
      events: redisParsed.events as unknown as Array<Record<string, unknown>>,
      todos: redisParsed.todos,
      currentTask: redisParsed.currentTask,
      tokenUsage: redisParsed.tokenUsage
    };
  }
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
  if (format === 'codex' || format === 'antigravity') {
    const parsed = parseCodexOutputToConversationResult(output);
    return { parsed: isConversationResultEmpty(parsed) ? null : parsed, rawFallback: buildRawOutputConversationResult(output), format };
  }
  if (format === 'vibe') {
    const parsed = parseVibeOutputToConversationResult(output);
    return { parsed: isConversationResultEmpty(parsed) ? null : parsed, rawFallback: buildRawOutputConversationResult(output), format };
  }
  const codexParsed = parseCodexOutputToConversationResult(output);
  if (!isConversationResultEmpty(codexParsed)) return { parsed: codexParsed, rawFallback: buildRawOutputConversationResult(output), format: 'codex' };
  const claudeParsed = parseClaudeOutputToConversationResult(output);
  if (!isConversationResultEmpty(claudeParsed)) return { parsed: claudeParsed, rawFallback: buildRawOutputConversationResult(output), format: 'claude' };
  const vibeParsed = parseVibeOutputToConversationResult(output);
  if (!isConversationResultEmpty(vibeParsed)) return { parsed: vibeParsed, rawFallback: buildRawOutputConversationResult(output), format: 'vibe' };
  return { parsed: null, rawFallback: buildRawOutputConversationResult(output), format };
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
