import type { LiveEvent } from './types';

// A placeholder the server writes in place of content it redacted, e.g. `[local preview omitted]`.
const INTERNAL_PLACEHOLDER = /^\[[^[\]\n]{1,80}\]$/;

// `{"content":[…` or `[{"type":…`: a serialized tool response or content-block list.
const WIRE_PAYLOAD = /^(?:\{\s*"content"\s*:\s*\[|\[\s*\{\s*"type"\s*:)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of an MCP/API content-block list: `[{ type: 'text', text }]`, or `null` when it is not one. */
const contentBlockText = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(block => isRecord(block) && typeof block.type === 'string')) return null;
  return value
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n');
};

/** Unwraps a serialized tool response (`{"content":[…]}` or a bare block list); anything else stays as written. */
const unwrapWirePayload = (content: string): string => {
  const trimmed = content.trim();
  // Only the content-block shapes are worth parsing; other JSON (e.g. checkpoints) is parsed downstream.
  if (!WIRE_PAYLOAD.test(trimmed)) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return content;
  }
  const text = contentBlockText(isRecord(parsed) ? parsed.content : parsed);
  return text ?? content;
};

/**
 * The human-readable form of a thought: wire-format tool responses give up their text, and
 * what is left of a redacted or empty payload is dropped (`null`) instead of shown.
 */
export const readableThoughtContent = (content: string | undefined): string | null => {
  if (!content) return null;
  const unwrapped = unwrapWirePayload(content);
  const text = unwrapped.trim();
  if (!text || INTERNAL_PLACEHOLDER.test(text)) return null;
  return unwrapped === content ? content : text;
};

/** Thoughts as a reader should see them; other events pass through untouched. */
export const readableThoughts = <T extends LiveEvent>(events: T[]): T[] => events.flatMap(event => {
  if (event.type !== 'thought') return [event];
  const content = readableThoughtContent(event.content);
  if (content === null) return [];
  return [content === event.content ? event : { ...event, content }];
});
