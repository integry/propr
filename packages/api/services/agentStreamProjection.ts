import type { ConversationEvent } from '@propr/shared';
import { parseClaudeOutputToConversationResult } from '../routes/liveDetailsCodexParser.js';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';
import { parseRedisOutput, type ParsedRedisOutput, type RedisOutputParseOptions } from './redisOutputParser.js';

/** Matches the conversation-file watcher budget so live payloads stay bounded. */
const MAX_LIVE_EVENTS = 100;

/**
 * Project raw agent stdout streamed through Redis into live events.
 *
 * Claude emits `stream-json` envelopes that the Codex/OpenCode/Antigravity
 * parser silently mangles - tool calls disappear and only a few assistant
 * texts survive - so route that format to the Claude transcript parser and
 * leave every other provider on the generic Redis parser.
 */
export function parseAgentStreamOutput(output: string, options: RedisOutputParseOptions = {}): ParsedRedisOutput {
  if (detectStoredOutputFormat(output) === 'claude') return projectClaudeStreamOutput(output);
  return parseRedisOutput(output.split('\n').filter(line => line.trim()), options);
}

function projectClaudeStreamOutput(output: string): ParsedRedisOutput {
  // Container entrypoints print plain text before Claude's first envelope, and
  // this projection re-runs on every live poll, so drop non-JSON lines here
  // instead of warning about each of them every couple of seconds.
  const envelopeLines = output.split('\n').filter(line => line.trimStart().startsWith('{'));
  const result = parseClaudeOutputToConversationResult(envelopeLines.join('\n'));
  const events = result.events as unknown as ConversationEvent[];
  return {
    events: events.length > MAX_LIVE_EVENTS ? events.slice(-MAX_LIVE_EVENTS) : events,
    todos: result.todos,
    currentTask: result.currentTask,
    tokenUsage: result.tokenUsage,
    totalEventCount: events.length,
    nativeGoal: null,
  };
}
