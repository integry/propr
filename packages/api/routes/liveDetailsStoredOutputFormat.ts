export type StoredOutputFormat = 'claude' | 'codex' | 'antigravity' | 'vibe' | 'unknown';

interface StoredExecutionOutputLine {
  type?: string;
  role?: string;
  session_id?: string;
  conversation_id?: string;
  model?: string;
  stats?: unknown;
  item?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export function detectStoredOutputFormat(output: string): StoredOutputFormat {
  const wholeDocumentFormat = detectParsedStoredOutputFormat(output.trim());
  if (wholeDocumentFormat !== 'unknown') return wholeDocumentFormat;

  const lines = output.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (lines.some(line => detectParsedStoredOutputFormat(line) === 'antigravity')) {
    return 'antigravity';
  }

  const firstLine = lines[0];
  if (!firstLine) return 'unknown';
  return detectParsedStoredOutputFormat(firstLine);
}

function detectParsedStoredOutputFormat(jsonText: string): StoredOutputFormat {
  try {
    const parsed = JSON.parse(jsonText) as StoredExecutionOutputLine | StoredExecutionOutputLine[];
    if (isVibeTranscript(parsed)) return 'vibe';
    if (Array.isArray(parsed)) return 'unknown';
    if (isAntigravityStreamEvent(parsed)) return 'antigravity';
    if (parsed.type === 'message'
      || parsed.type === 'tool_use'
      || parsed.type === 'tool_result'
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

function isAntigravityStreamEvent(parsed: StoredExecutionOutputLine): boolean {
  return (parsed.type === 'init' || parsed.type === 'message' || parsed.type === 'result')
    && hasAntigravityModel(parsed);
}

function hasAntigravityModel(parsed: StoredExecutionOutputLine): boolean {
  return typeof parsed.model === 'string' && parsed.model.trim().length > 0;
}

function isVibeTranscript(parsed: StoredExecutionOutputLine | StoredExecutionOutputLine[]): boolean {
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (!events.length) return false;
  return events.some(event => event.role === 'system' || event.role === 'tool' || event.reasoning_content !== undefined || event.tool_calls !== undefined || event.tool_call_id !== undefined)
    && events.some(event => event.role === 'assistant' || event.role === 'user' || event.role === 'tool');
}
