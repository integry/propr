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

/** A heading line: one to six `#` followed by a space or the end of the line. */
const HEADING = /^#{1,6}(?=\s|$)/u;
/** A list item or quote: a body block that does not continue onto the next line. */
const ITEM = /^(?:>|[-*+](?=\s)|\d+[.)](?=\s))/u;
const SENTENCE_PUNCTUATION = new Set(['.', '!', '?']);
const SENTENCE_CLOSERS = new Set(['"', "'", ')', ']']);

/**
 * The end of the first sentence: `.`, `!` or `?` (and any closing quotes or
 * brackets) followed by whitespace, as an index just past the closing
 * punctuation, or -1 when there is none. A full stop inside a token, as in
 * `v0.9.2` or `example.com`, has no space after it and does not end the
 * sentence. One linear scan: a run of punctuation and closers not followed by
 * whitespace is skipped whole, as no later start inside it can end differently.
 */
const sentenceEnd = (text: string): number => {
  let i = 0;
  while (i < text.length) {
    if (!SENTENCE_PUNCTUATION.has(text[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < text.length && SENTENCE_PUNCTUATION.has(text[j])) j += 1;
    while (j < text.length && SENTENCE_CLOSERS.has(text[j])) j += 1;
    if (j < text.length && /\s/u.test(text[j])) return j;
    i = j;
  }
  return -1;
};

/** The first sentence of `text`, its closing punctuation kept. */
const firstSentence = (text: string): string => {
  const end = sentenceEnd(text);
  return end >= 0 ? text.slice(0, end) : text;
};

/**
 * A run report's one-line preview for the run history, which tells runs of
 * the same automation apart: the first sentence of the report body after its
 * heading, Markdown stripped. A body that starts with a list or a quote
 * previews its first item. Headings (the title every run of an automation
 * repeats, and section headings) are skipped; a report that is only headings
 * previews its first one. The result is cut at a word boundary with `…` past
 * `max` characters. Null for no report or a report with nothing to show.
 */
export function automationReportPreview(report: string | null | undefined, max = AUTOMATION_REPORT_PREVIEW_MAX_CHARS): string | null {
  if (!report) return null;
  let title: string | null = null;
  const paragraph: string[] = [];
  for (const raw of report.split(/\r?\n/u)) {
    const line = raw.trim();
    const breaks = !line || FENCE.test(line) || STRUCTURE_ONLY.test(line) || HEADING.test(line);
    if (paragraph.length > 0 && (breaks || ITEM.test(line))) break;
    if (!line || FENCE.test(line) || STRUCTURE_ONLY.test(line)) continue;
    const text = stripInline(line.replace(BLOCK_MARKERS, ''));
    if (!text) continue;
    if (HEADING.test(line)) {
      title ??= text;
      continue;
    }
    paragraph.push(text);
    // A list item or quote is a block of its own; a plain paragraph runs on to its next line.
    if (ITEM.test(line)) break;
    // Earlier lines had no sentence end, so one on this line completes the first sentence.
    if (sentenceEnd(`${text} `) >= 0) break;
  }
  const body = paragraph.length > 0 ? firstSentence(paragraph.join(' ')) : title;
  return body ? truncateAtWord(body, max) : null;
}
