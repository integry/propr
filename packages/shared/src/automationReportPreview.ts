import { truncateAtWord } from './text.js';

/** Longest report preview the run history shows, ellipsis included. */
export const AUTOMATION_REPORT_PREVIEW_MAX_CHARS = 160;

/** Leading Markdown block markers: headings, quotes, list bullets, numbers and task boxes. */
const BLOCK_MARKERS = /^(?:(?:#{1,6}(?=\s|$)|>|[-*+](?=\s)|\d+[.)](?=\s)|\[[ xX]\](?=\s))\s*)+/u;
/** A rule or a table divider: lines that carry no words. */
const STRUCTURE_ONLY = /^(?:[-*_=\s]{3,}|[|:\-\s]+)$/u;
/**
 * A code fence, bare or with an info string such as a language label. A
 * backtick fence's info string has no backticks, so inline code that merely
 * starts with three backticks is not mistaken for a fence.
 */
const FENCE = /^(?:`{3,}[^`]*|~{3,}.*)$/u;

/**
 * First index of `char` in `line` at or after `from`, or `line.length` when
 * there is none. `cache` holds the previous answer: callers only ask with a
 * `from` that never decreases, so an answer at or past `from` is still the
 * first one and each scan of the line happens at most once.
 */
const nextIndex = (line: string, char: string, from: number, cache: number): number => {
  if (cache >= from) return cache;
  const found = line.indexOf(char, from);
  return found === -1 ? line.length : found;
};

/**
 * Markdown links (`[label](url)`, label required) or images (`![alt](url)`,
 * alt may be empty) reduced to their label. A single left-to-right scan with
 * cached lookahead, so its cost stays linear however the brackets nest or
 * repeat; an unmatched bracket is kept as text.
 */
const stripLinks = (line: string, image: boolean): string => {
  let out = '';
  let close = -1;
  let paren = -1;
  let i = 0;
  while (i < line.length) {
    const open = image ? i + 1 : i;
    const starts = image ? line[i] === '!' && line[open] === '[' : line[i] === '[';
    if (starts) {
      close = nextIndex(line, ']', open + 1, close);
      if (close < line.length && line[close + 1] === '(' && (image || close > open + 1)) {
        paren = nextIndex(line, ')', close + 2, paren);
        if (paren < line.length) {
          out += line.slice(open + 1, close);
          i = paren + 1;
          continue;
        }
      }
    }
    out += line[i];
    i += 1;
  }
  return out;
};

/**
 * HTML tags removed in one linear scan: each `<` that has a later `>` with
 * something between them drops through that `>`. A `<` that survives has no
 * `>` after it (or is an empty `<>`), so no tag can be left in or reassembled
 * from the result.
 */
const stripTags = (line: string): string => {
  let out = '';
  let close = -1;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '<') {
      close = nextIndex(line, '>', i + 1, close);
      if (close < line.length && close > i + 1) {
        i = close + 1;
        continue;
      }
    }
    out += line[i];
    i += 1;
  }
  return out;
};

/** Markdown inline syntax reduced to its text. */
const stripInline = (line: string): string => stripTags(stripLinks(stripLinks(line, true), false))
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
    if (!line || FENCE.test(line) || STRUCTURE_ONLY.test(line)) continue;
    const text = stripInline(line.replace(BLOCK_MARKERS, ''));
    if (text) return truncateAtWord(text, max);
  }
  return null;
}
