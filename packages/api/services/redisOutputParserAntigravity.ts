/**
 * Live projection of the agy 1.1.12+ `--output-format stream-json` envelope
 * (`event: init | step_update | result`), which task runs and native goals
 * stream to Redis.
 *
 * AGENT_RESPONSE text deltas buffer into one narration thought per step.
 * Only `tool` steps are tool activity, keyed by step index: a tool_use named
 * by `tool_name` with `tool_info.parameters` when the step first appears, and
 * a tool_result with `tool_info.output` once it reaches a terminal state.
 * USER_INPUT and other step types are not tools. The terminal result
 * contributes its response only when no narration streamed, and its usage.
 */
import type { ConversationEvent } from '@propr/shared';

interface StreamUsage { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number }
type RedisTokenUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };

export interface AntigravityStreamParseState {
  events: ConversationEvent[];
  tokenUsage: RedisTokenUsage;
  pendingAssistantMessage: string;
  pendingAssistantTimestamp: string | null;
  antigravityStream: AntigravityStreamProjectionState;
}

export interface AntigravityStreamProjectionState {
  /** The AGENT_RESPONSE step whose deltas are buffered, `conversation:step`. */
  pendingStep: string | null;
  /** Narration streamed per conversation since its latest init. */
  streamedText: Map<string, string>;
  toolSteps: Set<string>;
  finishedToolSteps: Set<string>;
  /** Latest usage snapshot per step, and the largest cumulative result usage. */
  stepUsage: Map<string, StreamUsage>;
  resultUsage: RedisTokenUsage;
  /** The usage this stream has already added to the shared token totals. */
  appliedUsage: RedisTokenUsage;
}

interface StreamEnvelope {
  event?: unknown;
  conversation_id?: unknown;
  init?: { model?: unknown };
  step_update?: { conversation_id?: unknown; step_index?: unknown; state?: unknown; step_type?: unknown; text_delta?: unknown; usage?: StreamUsage; tool_name?: unknown; tool_info?: unknown };
  result?: { conversation_id?: unknown; status?: unknown; response?: unknown; usage?: StreamUsage };
}

const TERMINAL_STEP_STATES = new Set(['DONE', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED']);
const MAX_CONTENT_LENGTH = 2000;
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
const COMMAND_EXIT_CODE = /Command exited with code (-?\d+)/;

export function createAntigravityStreamProjectionState(): AntigravityStreamProjectionState {
  return {
    pendingStep: null, streamedText: new Map(), toolSteps: new Set(), finishedToolSteps: new Set(),
    stepUsage: new Map(), resultUsage: emptyUsage(), appliedUsage: emptyUsage(),
  };
}

function emptyUsage(): RedisTokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(content: string): string {
  return content.length <= MAX_CONTENT_LENGTH ? content : `${content.substring(0, MAX_CONTENT_LENGTH)}... [truncated]`;
}

/** Whether a record is an agy stream-json envelope this module projects. */
export function isAntigravityStreamEnvelope(event: unknown): event is StreamEnvelope {
  if (!isRecord(event) || typeof event.event !== 'string') return false;
  if (event.event === 'init') return typeof event.conversation_id === 'string' && isRecord(event.init);
  if (event.event === 'step_update') {
    const update = event.step_update;
    return isRecord(update) && typeof update.conversation_id === 'string' && Number.isInteger(update.step_index) && typeof update.step_type === 'string';
  }
  return event.event === 'result' && isRecord(event.result) && typeof event.result.conversation_id === 'string';
}

function toRedisUsage(usage: StreamUsage | undefined): RedisTokenUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage?.cache_read_tokens ?? 0,
  };
}

/**
 * Step usage is per model call and result usage is cumulative over the
 * conversation, so the run's usage is the larger of the step sum and the
 * largest result; only the change since the last record joins the totals.
 */
function applyUsage(state: AntigravityStreamParseState): void {
  const stream = state.antigravityStream;
  const stepSum = emptyUsage();
  for (const usage of stream.stepUsage.values()) {
    const normalized = toRedisUsage(usage);
    for (const key of USAGE_KEYS) stepSum[key] += normalized[key];
  }
  for (const key of USAGE_KEYS) {
    const target = Math.max(stepSum[key], stream.resultUsage[key]);
    state.tokenUsage[key] += target - stream.appliedUsage[key];
    stream.appliedUsage[key] = target;
  }
}

/** A tool step failed when agy says so, or when its command reported a non-zero exit code. */
function isToolStepError(stepState: string, output: string): boolean {
  if (stepState !== 'DONE') return true;
  const exit = COMMAND_EXIT_CODE.exec(output);
  return exit !== null && Number(exit[1]) !== 0;
}

function toolStepDetails(update: NonNullable<StreamEnvelope['step_update']>): { name: string; input: Record<string, unknown>; output: string } {
  const info = isRecord(update.tool_info) ? update.tool_info : {};
  const name = typeof update.tool_name === 'string' && update.tool_name ? update.tool_name : typeof info.name === 'string' && info.name ? info.name : 'tool';
  return { name, input: isRecord(info.parameters) ? info.parameters : {}, output: typeof info.output === 'string' ? info.output : '' };
}

function flushNarration(state: AntigravityStreamParseState, timestamp: string, flush: (timestamp: string) => void): void {
  state.antigravityStream.pendingStep = null;
  flush(timestamp);
}

function processStepUpdate(update: NonNullable<StreamEnvelope['step_update']>, timestamp: string, state: AntigravityStreamParseState, flush: (timestamp: string) => void): void {
  const stream = state.antigravityStream;
  const conversationId = update.conversation_id as string;
  const key = `${conversationId}:${update.step_index}`;
  const stepType = update.step_type as string;
  const stepState = typeof update.state === 'string' ? update.state.toUpperCase() : '';
  const text = typeof update.text_delta === 'string' ? update.text_delta : '';
  if (update.usage) { stream.stepUsage.set(key, update.usage); applyUsage(state); }
  if (stepType.toUpperCase() === 'AGENT_RESPONSE') {
    if (stream.pendingStep !== key) flushNarration(state, timestamp, flush);
    if (!text) return;
    stream.pendingStep = key;
    state.pendingAssistantMessage += text;
    state.pendingAssistantTimestamp ??= timestamp;
    stream.streamedText.set(conversationId, (stream.streamedText.get(conversationId) ?? '') + text);
    return;
  }
  if (stepType.toUpperCase() !== 'TOOL') return;
  const id = `antigravity-step-${key}`;
  const tool = toolStepDetails(update);
  if (!stream.toolSteps.has(key)) {
    flushNarration(state, timestamp, flush);
    stream.toolSteps.add(key);
    state.events.push({ type: 'tool_use', toolName: tool.name, input: tool.input, id, timestamp });
  }
  if (TERMINAL_STEP_STATES.has(stepState) && !stream.finishedToolSteps.has(key)) {
    flushNarration(state, timestamp, flush);
    stream.finishedToolSteps.add(key);
    const output = tool.output || text;
    state.events.push({ type: 'tool_result', toolUseId: id, result: truncate(output || stepState.toLowerCase()), isError: isToolStepError(stepState, output), timestamp });
  }
}

function processResult(result: NonNullable<StreamEnvelope['result']>, timestamp: string, state: AntigravityStreamParseState, flush: (timestamp: string) => void): void {
  const stream = state.antigravityStream;
  flushNarration(state, timestamp, flush);
  const conversationId = result.conversation_id as string;
  const response = typeof result.response === 'string' ? result.response : '';
  // Streamed narration already shows the answer; the response stands in only when none streamed.
  if (response.trim() && !stream.streamedText.get(conversationId)?.trim()) {
    state.events.push({ type: 'thought', content: truncate(response), timestamp });
  }
  stream.streamedText.set(conversationId, '');
  const usage = toRedisUsage(result.usage);
  for (const key of USAGE_KEYS) stream.resultUsage[key] = Math.max(stream.resultUsage[key], usage[key]);
  applyUsage(state);
}

/** Projects one stream-json envelope; `flush` completes the buffered assistant message. */
export function processAntigravityStreamEnvelope(event: StreamEnvelope, timestamp: string, state: AntigravityStreamParseState, flush: (timestamp: string) => void): void {
  if (event.event === 'init') {
    flushNarration(state, timestamp, flush);
    state.antigravityStream.streamedText.set(event.conversation_id as string, '');
    return;
  }
  if (event.event === 'step_update' && event.step_update) processStepUpdate(event.step_update, timestamp, state, flush);
  else if (event.event === 'result' && event.result) processResult(event.result, timestamp, state, flush);
}
