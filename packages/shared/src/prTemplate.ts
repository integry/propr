/**
 * Repository pull request templates (`.propr/pr-template.md`).
 *
 * The file is a list of named sections, each introduced by a level-2 heading
 * (`## summary`). A section body is plain Markdown with `{{placeholder}}`
 * substitutions. Nothing else is evaluated: there are no conditionals, loops,
 * helpers or partials, and substituted values are never scanned again.
 *
 * Browser-safe and dependency-free so the worker, the API and the CLI validate
 * templates identically.
 */

export const PR_TEMPLATE_PATH = '.propr/pr-template.md';
export const PR_TEMPLATE_MAX_BYTES = 64 * 1024;
/** GitHub rejects pull request titles above this many characters. */
export const PR_TITLE_MAX_LENGTH = 256;
/** GitHub rejects pull request bodies above this many characters. */
export const PR_BODY_MAX_LENGTH = 65536;

/** Section names in the order they appear in a rendered pull request description. */
export const PR_TEMPLATE_SECTIONS = [
  'title', 'summary', 'run', 'commits', 'files_changed', 'prompt', 'review_guidelines', 'commands', 'trailer',
] as const;
export type PrTemplateSection = typeof PR_TEMPLATE_SECTIONS[number];
export type PrTemplateBodySection = Exclude<PrTemplateSection, 'title'>;
export const PR_TEMPLATE_BODY_SECTIONS = PR_TEMPLATE_SECTIONS.filter(
  (section): section is PrTemplateBodySection => section !== 'title',
);

export const PR_TEMPLATE_PLACEHOLDERS = {
  issue_number: 'Number of the issue the pull request resolves',
  issue_title: 'Title of that issue (untrusted; sanitized)',
  model: 'Display name of the model that implemented the change',
  agent: 'Agent type (claude, codex, antigravity, opencode or vibe)',
  cost: 'API cost of the run, for example $0.42',
  tokens: 'Total tokens used by the run',
  execution_time: 'Wall-clock execution time, for example 4m 12s',
  branch: 'Head branch of the pull request',
  commits: 'Markdown list of commits published by the run',
  files_changed: 'Markdown list of changed files',
  summary: "The agent's summary of the change (untrusted; sanitized)",
  session_id: 'Agent session identifier',
  repository: 'owner/repository',
} as const;
export type PrTemplatePlaceholder = keyof typeof PR_TEMPLATE_PLACEHOLDERS;
export type PrTemplateValues = Record<PrTemplatePlaceholder, string>;

/** Values that come from issue authors or agent output rather than from ProPR. */
const UNTRUSTED_PLACEHOLDERS: ReadonlySet<PrTemplatePlaceholder> = new Set(['issue_title', 'summary', 'commits']);

export type PrTemplateProblemKind = 'unknown_section' | 'duplicate_section' | 'unknown_placeholder' | 'too_large';

export interface PrTemplateProblem {
  kind: PrTemplateProblemKind;
  message: string;
  /** 1-based line in the template file, when the problem has one. */
  line?: number;
}

export interface ParsedPrTemplate {
  /** Present sections. An empty string removes the section from the output. */
  sections: Partial<Record<PrTemplateSection, string>>;
  problems: PrTemplateProblem[];
}

export class PrTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrTemplateError';
  }
}

// Capture the raw contents and trim in code: optional whitespace around a lazy
// group backtracks polynomially on long runs of whitespace.
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const HEADING_PATTERN = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence { char: string; length: number }

/**
 * The fenced code block open after `line`, following CommonMark: a fence closes
 * only on a line of the same character, at least as long, with nothing after it.
 */
function advanceFence(open: Fence | undefined, line: string): Fence | undefined {
  const match = FENCE_PATTERN.exec(line);
  if (!match) return open;
  const [, marker, rest] = match;
  if (open) return marker[0] === open.char && marker.length >= open.length && !rest.trim() ? undefined : open;
  // A backtick fence's info string cannot contain backticks; such a line is inline code.
  if (marker[0] === '`' && rest.includes('`')) return undefined;
  return { char: marker[0], length: marker.length };
}

function isKnownPlaceholder(name: string): name is PrTemplatePlaceholder {
  return Object.prototype.hasOwnProperty.call(PR_TEMPLATE_PLACEHOLDERS, name);
}

function isKnownSection(name: string): name is PrTemplateSection {
  return (PR_TEMPLATE_SECTIONS as readonly string[]).includes(name);
}

/** HTML comments are template comments; a scaffold with everything commented out is empty. */
function stripComments(source: string): string {
  // Keep the line structure so reported line numbers match the file.
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\n]/g, ''));
}

/** Unknown `{{...}}` expressions in one section body, including Handlebars helpers and blocks. */
function findUnknownPlaceholders(body: string, firstLine: number): PrTemplateProblem[] {
  const problems: PrTemplateProblem[] = [];
  body.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
      const name = match[1].trim();
      if (!isKnownPlaceholder(name)) {
        problems.push({
          kind: 'unknown_placeholder',
          message: `Unknown placeholder {{${name}}}; supported placeholders: ${Object.keys(PR_TEMPLATE_PLACEHOLDERS).join(', ')}`,
          line: firstLine + index,
        });
      }
    }
  });
  return problems;
}

/**
 * Split a template into sections. Never throws: everything that cannot be used
 * is returned as a problem, and unknown sections are ignored.
 */
export function parsePrTemplate(source: string): ParsedPrTemplate {
  const problems: PrTemplateProblem[] = [];
  const sections: Partial<Record<PrTemplateSection, string>> = {};
  if (new TextEncoder().encode(source).length > PR_TEMPLATE_MAX_BYTES) {
    return { sections, problems: [{ kind: 'too_large', message: `${PR_TEMPLATE_PATH} exceeds ${PR_TEMPLATE_MAX_BYTES / 1024} KiB` }] };
  }
  const lines = stripComments(source.replace(/\r\n?/g, '\n')).split('\n');
  let current: { name: string; known: boolean; line: number; body: string[] } | undefined;
  let fence: Fence | undefined;
  const finish = () => {
    if (!current?.known) return;
    const body = current.body.join('\n');
    problems.push(...findUnknownPlaceholders(body, current.line + 1));
    sections[current.name as PrTemplateSection] = body.trim() ? body.replace(/^(?:[ \t]*\n)+/, '').trimEnd() : '';
  };
  lines.forEach((line, index) => {
    const wasInFence = fence !== undefined;
    fence = advanceFence(fence, line);
    const heading = wasInFence || fence ? null : HEADING_PATTERN.exec(line);
    if (!heading) {
      current?.body.push(line);
      return;
    }
    finish();
    const name = (heading[1] ?? '').trim().toLowerCase();
    const known = isKnownSection(name);
    if (!known) {
      problems.push({ kind: 'unknown_section', message: `Unknown section "## ${(heading[1] ?? '').trim()}" is ignored; supported sections: ${PR_TEMPLATE_SECTIONS.join(', ')}`, line: index + 1 });
    } else if (name in sections) {
      problems.push({ kind: 'duplicate_section', message: `Section "## ${name}" appears more than once; the last one is used`, line: index + 1 });
    }
    current = { name, known, line: index + 1, body: [] };
  });
  finish();
  return { sections, problems };
}

/** Text with the origin of every UTF-16 unit: untrusted units come from issue authors or agent output. */
interface MarkedText { text: string; untrusted: boolean[] }

function marked(text: string, untrusted: boolean): MarkedText {
  // CommonMark treats a lone CR as a line ending; normalize so line analysis matches GitHub's.
  const normalized = text.replace(/\r\n?/g, '\n');
  return { text: normalized, untrusted: new Array<boolean>(normalized.length).fill(untrusted) };
}

function concatMarked(parts: readonly MarkedText[]): MarkedText {
  return { text: parts.map(part => part.text).join(''), untrusted: parts.flatMap(part => part.untrusted) };
}

function trimMarked({ text, untrusted }: MarkedText): MarkedText {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return start >= end ? { text: '', untrusted: [] } : { text: text.slice(start, end), untrusted: untrusted.slice(start, end) };
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
type HtmlBlockEnd = (text: string) => boolean;
/**
 * CommonMark HTML blocks that may span blank lines, with the test for the line
 * that ends each. These mirror GitHub's Markdown parser, not a browser: a
 * comment block ends only at `-->`, even though browsers also close a comment
 * at `--!>`. Lines inside a block are never treated as code, so a block that
 * stays open longer than the browser's comment only escapes more.
 */
const HTML_BLOCK_STARTS: ReadonlyArray<[RegExp, HtmlBlockEnd]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, text => /<\/(?:script|pre|style|textarea)>/i.test(text)],
  [/^ {0,3}<!--/, text => text.includes('-->')],
  [/^ {0,3}<\?/, text => text.includes('?>')],
  [/^ {0,3}<![A-Za-z]/, text => text.includes('>')],
  [/^ {0,3}<!\[CDATA\[/, text => text.includes(']]>')],
];

/**
 * Code spans on one line following CommonMark: an opening backtick string
 * closes at the next backtick string of exactly the same length, and outside
 * spans a backslash escapes the next punctuation character. `balanced` is
 * false when an opening backtick string has no closer on the line.
 */
function lineCodeSpans(line: string): { spans: Array<[number, number]>; balanced: boolean } {
  const runsByLength = new Map<number, number[]>();
  for (const run of line.matchAll(/`+/g)) {
    const starts = runsByLength.get(run[0].length) ?? [];
    starts.push(run.index);
    runsByLength.set(run[0].length, starts);
  }
  const spans: Array<[number, number]> = [];
  let balanced = true;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '\\' && ASCII_PUNCTUATION.test(line[index + 1] ?? '')) {
      index += 2;
      continue;
    }
    if (char !== '`') {
      index++;
      continue;
    }
    let end = index;
    while (line[end] === '`') end++;
    const length = end - index;
    const closer = (runsByLength.get(length) ?? []).find(start => start >= end);
    if (closer === undefined) {
      balanced = false;
      index = end;
      continue;
    }
    spans.push([index, closer + length]);
    index = closer + length;
  }
  return { spans, balanced };
}

/**
 * Units of `text` that GitHub certainly renders as code. Only fences and code
 * spans whose boundaries cannot be reinterpreted by their surroundings count:
 * a fence must open at column 0 at the start of the document, after a blank
 * line or after another fence, outside multi-paragraph HTML blocks; a code
 * span must sit in a block whose lines all close their own spans, without
 * raw HTML from the template and without crossing a table cell. Anything else
 * is treated as text, so the worst case is a visible `&lt;` inside code.
 */
function certainCode({ text, untrusted }: MarkedText): boolean[] {
  const code = new Array<boolean>(text.length).fill(false);
  let fence: Fence | undefined;
  let htmlEnd: HtmlBlockEnd | undefined;
  let blockStart = true;
  let blockHasHtml = false;
  let blockUnbalanced = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    const markCode = (start: number, end: number) => code.fill(true, lineOffset + start, lineOffset + end);
    if (fence) {
      markCode(0, line.length);
      fence = advanceFence(fence, line);
      if (!fence) [blockStart, blockHasHtml, blockUnbalanced] = [true, false, false];
      continue;
    }
    if (htmlEnd) {
      if (htmlEnd(line)) htmlEnd = undefined;
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      [blockStart, blockHasHtml, blockUnbalanced] = [true, false, false];
      continue;
    }
    if (blockStart && /^(?:`{3}|~{3})/.test(line)) {
      fence = advanceFence(undefined, line);
      if (fence) {
        markCode(0, line.length);
        continue;
      }
    }
    blockStart = false;
    const trustedTag = [...line.matchAll(/</g)].some(match => !untrusted[lineOffset + match.index]);
    if (trustedTag) {
      blockHasHtml = true;
      for (const [startPattern, isEnd] of HTML_BLOCK_STARTS) {
        const start = startPattern.exec(line);
        if (!start) continue;
        if (!isEnd(line.slice(start[0].length))) htmlEnd = isEnd;
        break;
      }
      continue;
    }
    const { spans, balanced } = lineCodeSpans(line);
    if (!balanced) blockUnbalanced = true;
    if (blockHasHtml || blockUnbalanced) continue;
    for (const [start, end] of spans) {
      if (!line.slice(start, end).includes('|')) markCode(start, end);
    }
  }
  return code;
}

/** Escape tag-like `<` in untrusted units unless the composed Markdown certainly renders them as code. */
function neutralizeMarked(input: MarkedText): string {
  const code = certainCode(input);
  return input.text.replace(/<(?=[A-Za-z!/?])/g, (match, index: number) => input.untrusted[index] && !code[index] ? '&lt;' : match);
}

/** Escape tag-like `<` outside code so untrusted text cannot inject raw HTML. */
export function neutralizeHtml(text: string): string {
  return neutralizeMarked(marked(text, true));
}

function renderMarked(text: string, values: PrTemplateValues): MarkedText {
  const parts: MarkedText[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = (match[1] ?? '').trim();
    if (!isKnownPlaceholder(name)) throw new PrTemplateError(`Unknown placeholder {{${name}}}`);
    parts.push(marked(text.slice(last, match.index), false), marked(values[name] ?? '', UNTRUSTED_PLACEHOLDERS.has(name)));
    last = match.index + match[0].length;
  }
  parts.push(marked(text.slice(last), false));
  return concatMarked(parts);
}

/**
 * Substitute placeholders in one section. Throws PrTemplateError on an unknown
 * placeholder; callers fall back to the default description.
 */
export function renderPrTemplateSection(text: string, values: PrTemplateValues, context: 'title' | 'body' = 'body'): string {
  if (context === 'body') return neutralizeMarked(renderMarked(text, values));
  return text.replace(PLACEHOLDER_PATTERN, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!isKnownPlaceholder(name)) throw new PrTemplateError(`Unknown placeholder {{${name}}}`);
    return (values[name] ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * One fragment of ProPR's default description, attributed to the section that
 * owns it. Layout-only fragments (separators between sections) have no section
 * and appear only in the default description.
 */
export interface PrBodyPiece {
  section: PrTemplateBodySection | null;
  text: string;
}

/** Concatenate the default fragments exactly as ProPR has always written them. */
export function defaultPrBody(pieces: readonly PrBodyPiece[]): string {
  return pieces.map(piece => piece.text).join('');
}

function defaultSectionText(pieces: readonly PrBodyPiece[], section: PrTemplateBodySection): string {
  return pieces.filter(piece => piece.section === section).map(piece => piece.text.trim()).filter(Boolean).join('\n\n');
}

/**
 * Compose a description from a parsed template: present sections replace the
 * default content (whitespace-only removes it), absent sections keep it.
 */
export function composePrBody(pieces: readonly PrBodyPiece[], template: ParsedPrTemplate, values: PrTemplateValues): string {
  const sections = PR_TEMPLATE_BODY_SECTIONS.map(section => {
    const override = template.sections[section];
    return override === undefined ? marked(defaultSectionText(pieces, section), false) : trimMarked(renderMarked(override, values));
  }).filter(section => section.text);
  // Neutralize the composed description: where substituted text lands decides
  // whether its backticks really open code.
  return neutralizeMarked(concatMarked(sections.flatMap((section, index) => index ? [marked('\n\n', false), section] : [section])));
}

/** GitHub template fallback: ProPR's summary and run block, then the repository's own template. */
export function composeWithRepositoryTemplate(pieces: readonly PrBodyPiece[], repositoryTemplate: string): string {
  return [
    defaultSectionText(pieces, 'summary'),
    defaultSectionText(pieces, 'run'),
    repositoryTemplate.replace(/\r\n?/g, '\n').trim(),
  ].filter(Boolean).join('\n\n');
}

/** Render the title section; an empty result keeps the default title. */
export function composePrTitle(defaultTitle: string, template: ParsedPrTemplate | undefined, values: PrTemplateValues): string {
  const pattern = template?.sections.title;
  if (!pattern?.trim()) return defaultTitle;
  const title = renderPrTemplateSection(pattern, values, 'title').replace(/\s+/g, ' ').trim();
  if (!title) return defaultTitle;
  return title.length > PR_TITLE_MAX_LENGTH ? title.slice(0, PR_TITLE_MAX_LENGTH - 1).trimEnd() + '…' : title;
}

/** Commented example scaffolded by `propr init`; every section is commented out, so it changes nothing until edited. */
export const PR_TEMPLATE_SCAFFOLD = `<!--
ProPR pull request template. ProPR reads this file from the task's base branch.

Each "## <section>" heading below replaces ProPR's default content for that
section. Delete a section to keep the default; leave a section empty to remove it.
HTML comments like this one are ignored.

Sections: ${PR_TEMPLATE_SECTIONS.join(', ')}
Placeholders: ${Object.keys(PR_TEMPLATE_PLACEHOLDERS).map(name => `{{${name}}}`).join(', ')}

Only placeholder substitution is supported; there are no conditionals or loops.
Docs: https://docs.propr.dev/docs/features/pr-templates

Uncomment and edit the examples you want:

## title
[{{issue_number}}] {{issue_title}}

## summary
Closes #{{issue_number}}

{{summary}}

## run

## review_guidelines
### Checklist
- [ ] Tests cover the change
- [ ] Documentation is updated
-->
`;
