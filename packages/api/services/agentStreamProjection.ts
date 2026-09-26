import type { ConversationEvent } from '@propr/shared';
import { parseClaudeOutputToConversationResult } from '../routes/liveDetailsCodexParser.js';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';
import {
  parseRedisOutput,
  type NativeGoalProjection,
  type ParsedRedisOutput,
  type RedisOutputParseOptions,
} from './redisOutputParser.js';

/** Matches the conversation-file watcher budget so live payloads stay bounded. */
const MAX_LIVE_EVENTS = 100;

export interface AgentStreamParseOptions extends RedisOutputParseOptions {
  /** Activity callers paginate narration after filtering the complete stream. */
  limitEvents?: boolean;
}

/** Matches the Redis parser's synthetic timestamp spacing for other providers. */
const SYNTHETIC_TIMESTAMP_STEP_MS = 1000;

/**
 * Project raw agent stdout streamed through Redis into live events.
 *
 * Claude emits `stream-json` envelopes that the Codex/OpenCode/Antigravity
 * parser silently mangles - tool calls disappear and only a few assistant
 * texts survive - so route that format to the Claude transcript parser and
 * leave every other provider on the generic Redis parser.
 */
export function parseAgentStreamOutput(output: string, options: AgentStreamParseOptions = {}): ParsedRedisOutput {
  if (detectStoredOutputFormat(output) === 'claude') return projectClaudeStreamOutput(output, options);
  return parseRedisOutput(output.split('\n').filter(line => line.trim()), options);
}

function projectClaudeStreamOutput(output: string, options: AgentStreamParseOptions): ParsedRedisOutput {
  // Container entrypoints print plain text before Claude's first envelope, and
  // this projection re-runs on every live poll, so drop non-JSON lines here
  // instead of warning about each of them every couple of seconds.
  const envelopeLines = output.split('\n').filter(line => line.trimStart().startsWith('{'));
  const stampedLines = withSyntheticEnvelopeTimestamps(envelopeLines, options.executionStartTimestamp);
  const result = parseClaudeOutputToConversationResult(stampedLines.join('\n'));
  const events = result.events as unknown as ConversationEvent[];
  return {
    events: options.limitEvents !== false && events.length > MAX_LIVE_EVENTS ? events.slice(-MAX_LIVE_EVENTS) : events,
    todos: result.todos,
    currentTask: result.currentTask,
    tokenUsage: result.tokenUsage,
    totalEventCount: events.length,
    nativeGoal: projectClaudeNativeGoal(envelopeLines, result.tokenUsage),
  };
}

interface ClaudeNativeGoalRecord {
  objective?: unknown;
  status?: unknown;
  setAt?: unknown;
  updatedAt?: unknown;
}

/**
 * Claude reports its `/goal` verdicts only in the session transcript, so the
 * worker writes `propr_native_goal` snapshots into the live stream at each
 * goal boundary. Project the latest one like Codex's thread/goal/updated.
 */
function projectClaudeNativeGoal(
  lines: string[],
  tokenUsage: ReturnType<typeof parseClaudeOutputToConversationResult>['tokenUsage'],
): NativeGoalProjection | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"propr_native_goal"')) continue;
    let envelope: { type?: string; subtype?: string; goal?: ClaudeNativeGoalRecord };
    try { envelope = JSON.parse(lines[index]) as typeof envelope; } catch { continue; }
    const goal = envelope.goal;
    if (envelope.type !== 'system' || envelope.subtype !== 'propr_native_goal') continue;
    if (typeof goal?.objective !== 'string' || typeof goal.status !== 'string') continue;
    const setAt = Number(goal.setAt);
    const until = goal.status === 'active' ? Date.now() : Number(goal.updatedAt);
    return {
      objective: goal.objective,
      status: goal.status,
      tokenBudget: null,
      tokensUsed: tokenUsage
        ? tokenUsage.input_tokens + tokenUsage.output_tokens
          + tokenUsage.cache_creation_input_tokens + tokenUsage.cache_read_input_tokens
        : 0,
      timeUsedSeconds: Number.isFinite(setAt) && Number.isFinite(until) ? Math.max(0, Math.round((until - setAt) / 1000)) : 0,
    };
  }
  return null;
}

/**
 * Claude stream-json envelopes carry no timestamps (conversation-file
 * transcripts do), so the Claude parser would stamp every event with the
 * parse time - a value that shifts on each poll. Synthesize monotonic
 * timestamps from the execution start instead, mirroring the Redis parser's
 * synthetic timestamps for the other providers.
 */
function withSyntheticEnvelopeTimestamps(lines: string[], executionStartTimestamp?: string | null): string[] {
  const startMs = executionStartTimestamp ? new Date(executionStartTimestamp).getTime() : NaN;
  if (Number.isNaN(startMs)) return lines;
  return lines.map((line, index) => {
    try {
      const envelope = JSON.parse(line) as { timestamp?: unknown };
      if (envelope.timestamp) return line;
      envelope.timestamp = new Date(startMs + index * SYNTHETIC_TIMESTAMP_STEP_MS).toISOString();
      return JSON.stringify(envelope);
    } catch {
      return line;
    }
  });
}
