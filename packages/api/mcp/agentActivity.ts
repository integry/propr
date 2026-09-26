import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { redactVisualPreviewPaths } from '@propr/core';
import { projectTaskLiveDetails } from '../routes/liveDetailsRoutes.js';
import { McpError } from './config.js';

const MAX_ACTIVITY_MESSAGE_LENGTH = 500;

interface AgentActivityArgs {
  repository: string;
  goalId?: string;
  taskId?: string;
  includeReasoningSummaries?: boolean;
  offset: number;
  limit: number;
}

interface AgentActivityTarget {
  type: 'goal' | 'task';
  goalId?: string;
  taskId: string;
  launchStrategy?: string;
  sessionId: string | null;
  fallbackTimestamp: string | null;
}

interface IndexedActivity {
  index: number;
  timestamp: string;
  message: string;
}

function notFound(): never {
  throw new McpError('NOT_FOUND', 'Target not found in your authorized repository.', 404);
}

async function latestExecutionSession(db: Knex, taskId: string): Promise<string | null> {
  try {
    const execution = await db('llm_executions')
      .where({ task_id: taskId })
      .orderBy('start_time', 'desc')
      .first('session_id');
    return typeof execution?.session_id === 'string' ? execution.session_id : null;
  } catch {
    return null;
  }
}

async function latestTaskTimestamp(db: Knex, taskId: string, fallback: unknown): Promise<string | null> {
  try {
    const history = await db('task_history')
      .where({ task_id: taskId })
      .orderBy('timestamp', 'desc')
      .first('timestamp');
    return typeof history?.timestamp === 'string'
      ? history.timestamp
      : typeof fallback === 'string' ? fallback : null;
  } catch {
    return typeof fallback === 'string' ? fallback : null;
  }
}

async function resolveGoalTarget(db: Knex, args: AgentActivityArgs, ownerId: string): Promise<AgentActivityTarget> {
  const goal = await db('goals')
    .where({ goal_id: args.goalId, repository: args.repository, owner_id: ownerId })
    .first('goal_id', 'current_task_id', 'launch_strategy', 'session_id', 'started_at', 'updated_at', 'created_at');
  if (!goal || typeof goal.current_task_id !== 'string') return notFound();
  return {
    type: 'goal',
    goalId: goal.goal_id,
    taskId: goal.current_task_id,
    launchStrategy: goal.launch_strategy,
    sessionId: typeof goal.session_id === 'string' ? goal.session_id : null,
    fallbackTimestamp: await latestTaskTimestamp(
      db,
      goal.current_task_id,
      goal.started_at ?? goal.updated_at ?? goal.created_at,
    ),
  };
}

async function resolveTaskTarget(db: Knex, args: AgentActivityArgs, ownerId: string): Promise<AgentActivityTarget> {
  const task = await db('tasks')
    .where({ task_id: args.taskId, repository: args.repository })
    .first('task_id', 'task_type', 'created_at');
  if (!task) return notFound();
  const goal = await db('goals')
    .where({ current_task_id: args.taskId })
    .first('goal_id', 'owner_id', 'launch_strategy', 'session_id', 'started_at', 'updated_at');
  if ((task.task_type === 'goal' && !goal) || (goal && goal.owner_id !== ownerId)) return notFound();
  return {
    type: 'task',
    taskId: task.task_id,
    ...(goal ? { goalId: goal.goal_id, launchStrategy: goal.launch_strategy } : {}),
    sessionId: typeof goal?.session_id === 'string'
      ? goal.session_id
      : await latestExecutionSession(db, task.task_id),
    fallbackTimestamp: await latestTaskTimestamp(
      db,
      task.task_id,
      goal?.started_at ?? goal?.updated_at ?? task.created_at,
    ),
  };
}

async function resolveTarget(db: Knex, args: AgentActivityArgs, ownerId: string): Promise<AgentActivityTarget> {
  return args.goalId
    ? resolveGoalTarget(db, args, ownerId)
    : resolveTaskTarget(db, args, ownerId);
}

function isoTimestamp(value: unknown, fallback: string | null): string | null {
  const candidate = typeof value === 'string' && value.trim() ? value : fallback;
  if (!candidate) return null;
  const milliseconds = new Date(candidate).getTime();
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function checkpointNarration(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const checkpoint = value as { checkpointReady?: unknown; message?: unknown; summary?: unknown };
  if (checkpoint.checkpointReady !== true || typeof checkpoint.message !== 'string') return null;
  const message = compactNarration(checkpoint.message);
  if (!message) return null;
  const summary = typeof checkpoint.summary === 'string' ? compactNarration(checkpoint.summary) : null;
  return `Checkpoint ready: ${message}.${summary ? ` ${summary}` : ''}`;
}

function withoutFencedPayloads(content: string): string {
  const prose: string[] = [];
  let fence: string | null = null;
  let payload: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    // Fences may follow nested quote/list markers or list continuation indentation.
    // Match those prefixes only for fences so surrounding narration stays intact.
    const marker = line.match(/^[ \t]*(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/);
    if (!fence) {
      if (marker) {
        fence = marker[1];
        payload = [];
      } else {
        prose.push(line);
      }
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      try {
        const checkpoint = checkpointNarration(JSON.parse(payload.join('\n')));
        if (checkpoint) prose.push(checkpoint);
      } catch { /* Code and non-JSON payloads are not narration. */ }
      fence = null;
    } else {
      payload.push(line);
    }
  }
  // An unfinished fence can occur while streaming; keep only preceding prose.
  return prose.join('\n');
}

function compactNarration(content: string): string | null {
  const result = redactVisualPreviewPaths(content).trim().replace(/^\*\*Result:\*\*\s*/i, '');
  let text = withoutFencedPayloads(result).trim();
  if (!text) return null;
  if (/^[{[]/.test(text)) {
    try {
      const checkpoint = checkpointNarration(JSON.parse(text));
      if (!checkpoint) return null;
      text = checkpoint;
    } catch {
      // Keep Markdown links and bracket-prefixed status prose, but exclude
      // incomplete object payloads and arrays of structured values.
      if (text.startsWith('{') || /^\[\s*["{[]/.test(text)) return null;
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= MAX_ACTIVITY_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, MAX_ACTIVITY_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

async function ambiguousPersistedText(deps: { db: Knex }, target: AgentActivityTarget): Promise<Set<string>> {
  const ambiguous = new Set<string>();
  if (!target.sessionId) return ambiguous;
  const execution = await deps.db('llm_executions')
    .where({ task_id: target.taskId, session_id: target.sessionId })
    .orderBy('start_time', 'desc')
    .first('execution_id');
  if (!execution) return ambiguous;
  const rows = await deps.db('llm_execution_details')
    .where({ execution_id: execution.execution_id, event_type: 'assistant' })
    .select('content', 'event_timestamp');
  for (const row of rows) {
    try {
      const message = JSON.parse(row.content);
      // Legacy Vibe messages persisted only id/content/usage, flattening both
      // reasoning_content and narration into text. Without a classification
      // these blocks are ambiguous; native Claude message envelopes retain role.
      if (message?.role === 'assistant' || !Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (block?.type === 'text' && block.internalReasoning === undefined && typeof block.text === 'string') {
          ambiguous.add(JSON.stringify([isoTimestamp(row.event_timestamp, null), block.text]));
        }
      }
    } catch { /* Malformed stored content is handled by the existing projection. */ }
  }
  return ambiguous;
}

function projectNarration(
  events: Array<Record<string, unknown>>,
  fallbackTimestamp: string | null,
  includeReasoningSummaries = false,
  ambiguousText = new Set<string>(),
): IndexedActivity[] {
  const projected = events.flatMap((event, index): IndexedActivity[] => {
    if (!['thought', 'message'].includes(String(event.type)) || event.rawFallback === true) return [];
    if (event.internalReasoning === true && !(includeReasoningSummaries && event.reasoningSummary === true)) return [];
    if (ambiguousText.has(JSON.stringify([isoTimestamp(event.timestamp, fallbackTimestamp), event.content]))) return [];
    const message = typeof event.content === 'string' ? compactNarration(event.content) : null;
    const timestamp = isoTimestamp(event.timestamp, fallbackTimestamp);
    return message && timestamp ? [{ index, timestamp, message }] : [];
  });
  projected.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.index - left.index);
  const seen = new Set<string>();
  return projected.filter(entry => {
    if (seen.has(entry.message)) return false;
    seen.add(entry.message);
    return true;
  });
}

export async function getAgentActivity(
  deps: { db: Knex; redisClient: RedisClientType },
  args: AgentActivityArgs,
  ownerId: string,
) {
  const target = await resolveTarget(deps.db, args, ownerId);
  const live = await projectTaskLiveDetails(
    deps.redisClient,
    deps.db,
    target.taskId,
    { sessionId: target.sessionId, limitEvents: false },
  );
  const ambiguousText = await ambiguousPersistedText(deps, target);
  const entries = projectNarration(live?.events ?? [], target.fallbackTimestamp, args.includeReasoningSummaries, ambiguousText);
  const activity = entries
    .slice(args.offset, args.offset + args.limit)
    .map(({ timestamp, message }) => ({ timestamp, message }));
  return {
    target: {
      type: target.type,
      ...(target.goalId ? { goalId: target.goalId } : {}),
      taskId: target.taskId,
      ...(target.launchStrategy ? { launchStrategy: target.launchStrategy } : {}),
    },
    currentFocus: live?.currentTask ? compactNarration(live.currentTask) : null,
    activity,
    order: 'newest_first' as const,
    nextOffset: args.offset + args.limit < entries.length ? args.offset + args.limit : null,
  };
}
