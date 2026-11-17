import { truncateAtWord } from './text.js';

/** Longest report preview the run history shows, ellipsis included. */
export const AUTOMATION_REPORT_PREVIEW_MAX_CHARS = 160;

/** Leading Markdown block markers: headings, quotes, list bullets, numbers and task boxes. */
const BLOCK_MARKERS = /^(?:(?:#{1,6}(?=\s|$)|>|[-*+](?=\s)|\d+[.)](?=\s)|\[[ xX]\](?=\s))\s*)+/u;
/** A fence, a rule or a table divider: lines that carry no words. */
const STRUCTURE_ONLY = /^(?:`{3,}|~{3,}|[-*_=\s]{3,}|[|:\-\s]+)$/u;

/** Markdown inline syntax reduced to its text. */
const stripInline = (line: string): string => line
  .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
  .replace(/<[^>]+>/gu, '')
  .replace(/[*_`~]+/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

/**
 * A run report's one-line preview for the run history: the first line with
 * words in it, Markdown markers stripped, cut at a word boundary with `…` past
 * `max` characters. Null for no report or a report with nothing to show.
 */
export function automationReportPreview(report: string | null | undefined, max = AUTOMATION_REPORT_PREVIEW_MAX_CHARS): string | null {
  if (!report) return null;
  for (const raw of report.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || STRUCTURE_ONLY.test(line)) continue;
    const text = stripInline(line.replace(BLOCK_MARKERS, ''));
    if (text) return truncateAtWord(text, max);
  }
  return null;
}
