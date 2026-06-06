import { isOpenCodeJsonlEvent } from '@propr/core';

interface StoredExecutionOutputLine {
  type?: string;
  role?: string;
  message?: { parts?: unknown[] } | unknown;
  response?: unknown;
  sessionID?: string;
  sessionId?: string;
  session_id?: string;
  conversation_id?: string;
  item?: unknown;
  part?: unknown;
  parts?: unknown[];
  reasoning_content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export type StoredOutputFormat = 'claude' | 'codex' | 'opencode' | 'vibe' | 'unknown';

const CODEX_STORED_OUTPUT_TYPES = new Set([
  'message',
  'tool_use',
  'error',
  'result',
  'turn.started',
  'turn.completed',
  'item.started',
  'item.updated',
  'item.completed'
]);
const CLAUDE_STORED_OUTPUT_TYPES = new Set(['assistant', 'user']);

export function detectStoredOutputFormat(output: string): StoredOutputFormat {
  const wholeDocumentFormat = detectVibeTranscriptFormat(output.trim());
  if (wholeDocumentFormat !== 'unknown') return wholeDocumentFormat;

  let detectedFormat: StoredOutputFormat = 'unknown';
  for (const line of output.split('\n')) {
    const parsed = parseStoredOutputLine(line);
    if (!parsed) continue;
    const immediateFormat = getImmediateStoredOutputFormat(parsed);
    if (immediateFormat) return immediateFormat;
    const deferredFormat = getDeferredStoredOutputFormat(parsed);
    if (deferredFormat === 'opencode') return 'opencode';
    if (detectedFormat === 'unknown') detectedFormat = deferredFormat;
  }
  return detectedFormat;
}

function detectVibeTranscriptFormat(jsonText: string): StoredOutputFormat {
  try {
    const parsed = JSON.parse(jsonText) as StoredExecutionOutputLine | StoredExecutionOutputLine[];
    if (isVibeTranscript(parsed)) return 'vibe';
  } catch {
    // Not valid JSON, ignore
  }
  return 'unknown';
}

function parseStoredOutputLine(line: string): StoredExecutionOutputLine | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as StoredExecutionOutputLine;
  } catch {
    return null;
  }
}

function getImmediateStoredOutputFormat(parsed: StoredExecutionOutputLine): StoredOutputFormat | null {
  if (isClaudeStoredOutputLine(parsed)) return 'claude';
  return isStrongOpenCodeStoredOutputLine(parsed) && !isCodexStoredOutputLine(parsed) ? 'opencode' : null;
}

function getDeferredStoredOutputFormat(parsed: StoredExecutionOutputLine): StoredOutputFormat {
  if (isStrongOpenCodeStoredOutputLine(parsed)) return 'opencode';
  return isCodexStoredOutputLine(parsed) ? 'codex' : 'unknown';
}

function isStrongOpenCodeStoredOutputLine(parsed: StoredExecutionOutputLine): boolean {
  if (!isOpenCodeJsonlEvent(parsed)) return false;
  if (parsed.sessionID || parsed.sessionId) return true;
  return Boolean(parsed.session_id && hasOpenCodeSpecificShape(parsed))
    || hasOpenCodeAssistantPartsShape(parsed);
}

function hasOpenCodeSpecificShape(parsed: StoredExecutionOutputLine): boolean {
  const type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
  return Boolean(parsed.part || parsed.parts || parsed.response || type.startsWith('tool_'));
}

function hasOpenCodeAssistantPartsShape(parsed: StoredExecutionOutputLine): boolean {
  if (!parsed.message || typeof parsed.message !== 'object') return false;
  const message = parsed.message as { role?: unknown; parts?: unknown[] };
  return message.role === 'assistant' && Array.isArray(message.parts) && message.parts.length > 0;
}

function isCodexStoredOutputLine(parsed: StoredExecutionOutputLine): boolean {
  return Boolean((parsed.type && CODEX_STORED_OUTPUT_TYPES.has(parsed.type)) || parsed.item !== undefined);
}

function isClaudeStoredOutputLine(parsed: StoredExecutionOutputLine): boolean {
  return Boolean((parsed.type && CLAUDE_STORED_OUTPUT_TYPES.has(parsed.type)) || isClaudeConversationEnvelope(parsed));
}

function isClaudeConversationEnvelope(parsed: StoredExecutionOutputLine): boolean {
  if (!parsed.conversation_id || parsed.type) return false;
  if (parsed.role === 'assistant' || parsed.role === 'user') return true;
  const message = parsed.message as { role?: unknown; content?: unknown } | undefined;
  return Boolean(
    message
    && (message.role === 'assistant' || message.role === 'user' || Array.isArray(message.content))
  );
}

function isVibeTranscript(parsed: StoredExecutionOutputLine | StoredExecutionOutputLine[]): boolean {
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (!events.length) return false;
  return events.some(event => event.role === 'system' || event.role === 'tool' || event.reasoning_content !== undefined || event.tool_calls !== undefined || event.tool_call_id !== undefined)
    && events.some(event => event.role === 'assistant' || event.role === 'user' || event.role === 'tool');
}
