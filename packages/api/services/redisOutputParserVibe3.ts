import type { VibeTranscriptEvent } from './redisOutputParserVibe.js';

/**
 * Vibe 3 `--output streaming` / `--output json` generation entry. Unlike Vibe 2
 * transcripts, tool activity arrives as `type: "effect"` records with no `role`.
 */
export interface Vibe3GenerationEntry {
  id?: string;
  type?: string;
  role?: string;
  turnId?: string;
  createdAt?: number;
  toolCallId?: string;
  generationStatus?: string;
  outcome?: { type?: string } | null;
  text?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  detail?: { toolName?: string; input?: unknown } | null;
  state?: {
    status?: string;
    outputText?: unknown;
    output?: unknown;
    reason?: unknown;
    error?: { message?: unknown } | null;
  } | null;
}

const VIBE3_ENTRY_TYPES = new Set(['message', 'effect', 'reasoning']);
const VIBE3_SUCCESS_STATUSES = new Set(['completed', 'success', 'succeeded']);
const REASONING_PART_TYPES = new Set(['reasoning', 'thinking']);

/** Vibe 3 generation entries carry `turnId` plus `generationStatus`, and either a role-based message or a `toolCallId` effect. */
export function isVibe3GenerationEntry(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const entry = event as Vibe3GenerationEntry;
  if (typeof entry.type !== 'string' || !VIBE3_ENTRY_TYPES.has(entry.type)) return false;
  if (typeof entry.turnId !== 'string' || typeof entry.generationStatus !== 'string') return false;
  if (entry.type === 'effect') return typeof entry.toolCallId === 'string' || typeof entry.detail?.toolName === 'string';
  return true;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  for (const value of values) {
    if (value && typeof value === 'object') return JSON.stringify(value);
  }
  return undefined;
}

function splitMessageContent(content: unknown): { text: unknown; reasoning: string[] } {
  if (!Array.isArray(content)) return { text: content, reasoning: [] };
  const reasoning: string[] = [];
  const text: unknown[] = [];
  for (const part of content) {
    const record = part && typeof part === 'object' ? part as Record<string, unknown> : null;
    if (record && typeof record.type === 'string' && REASONING_PART_TYPES.has(record.type)) {
      const value = firstText(record.text, record.reasoning, record.thinking, record.content);
      if (value) reasoning.push(value);
    } else {
      text.push(part);
    }
  }
  return { text, reasoning };
}

/** Map one Vibe 3 entry onto the Vibe 2 transcript shape consumed by `processVibeEvent`. */
export function vibe3EntryToTranscriptEvents(entry: Vibe3GenerationEntry): VibeTranscriptEvent[] {
  // Partial entries are re-emitted once settled; discarded drafts never landed.
  if (entry.generationStatus !== 'completed' || entry.outcome?.type === 'discarded') return [];
  if (entry.type === 'reasoning') {
    return [{ role: 'assistant', reasoning_content: firstText(entry.text, entry.content) }];
  }
  if (entry.type === 'effect') {
    const id = entry.toolCallId || entry.id;
    const state = entry.state || {};
    const failed = !VIBE3_SUCCESS_STATUSES.has(state.status ?? '');
    const result = firstText(state.outputText, state.error?.message, state.reason, state.output)
      ?? (failed ? state.status || 'failed' : undefined);
    return [
      { role: 'assistant', tool_calls: [{ id, function: { name: entry.detail?.toolName || 'tool', arguments: entry.detail?.input } }] },
      { role: 'tool', tool_call_id: id, content: result, error: failed ? (state.status || 'failed') : undefined }
    ];
  }
  if (entry.role !== 'assistant') return [];
  const { text, reasoning } = splitMessageContent(entry.content);
  const reasoningContent = [firstText(entry.reasoning_content), ...reasoning].filter(Boolean).join('\n');
  return [{ role: 'assistant', content: text, reasoning_content: reasoningContent || undefined }];
}
