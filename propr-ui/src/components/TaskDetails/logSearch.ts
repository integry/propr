/**
 * Log search treats what the user types as plain text, matched without regard
 * to case: `[`, `(`, `\` and `.*` find themselves rather than forming a
 * pattern. Counting and highlighting share one expression, so the match total
 * and the highlighted spans always agree.
 */
const literalPattern = (query: string): RegExp =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

/** Every match of `query` in `content`; none for an empty query. */
export function findLogMatches(content: string, query: string): RegExpMatchArray[] {
  if (!query) return [];
  return [...content.matchAll(literalPattern(query))];
}

export interface LogSegment {
  text: string;
  /** The match's position among all matches; absent for text between matches. */
  matchIndex?: number;
}

/** Splits `content` into the text between matches and the matches themselves. */
export function splitLogMatches(content: string, query: string): LogSegment[] {
  const segments: LogSegment[] = [];
  let offset = 0;
  findLogMatches(content, query).forEach((match, matchIndex) => {
    const start = match.index ?? 0;
    if (start > offset) segments.push({ text: content.slice(offset, start) });
    segments.push({ text: match[0], matchIndex });
    offset = start + match[0].length;
  });
  if (offset < content.length || segments.length === 0) segments.push({ text: content.slice(offset) });
  return segments;
}

/** The text log search runs over: JSON logs as they are displayed. */
export function logSearchText(content: string | object, isJson: boolean): string {
  if (isJson || typeof content !== 'string') return JSON.stringify(content, null, 2) ?? '';
  return content;
}
