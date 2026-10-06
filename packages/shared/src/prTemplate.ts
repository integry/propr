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

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const HEADING_PATTERN = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

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
      if (!isKnownPlaceholder(match[1])) {
        problems.push({
          kind: 'unknown_placeholder',
          message: `Unknown placeholder {{${match[1]}}}; supported placeholders: ${Object.keys(PR_TEMPLATE_PLACEHOLDERS).join(', ')}`,
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
  let fence: string | undefined;
  const finish = () => {
    if (!current?.known) return;
    const body = current.body.join('\n');
    problems.push(...findUnknownPlaceholders(body, current.line + 1));
    sections[current.name as PrTemplateSection] = body.trim() ? body.replace(/^(?:[ \t]*\n)+/, '').trimEnd() : '';
  };
  lines.forEach((line, index) => {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = undefined;
    }
    const heading = fence || fenceMatch ? null : HEADING_PATTERN.exec(line);
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

/** Escape tag-like `<` outside code so untrusted text cannot inject raw HTML. */
export function neutralizeHtml(text: string): string {
  let inFence = false;
  return text.split('\n').map(line => {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.split(/(`+[^`]*`+)/).map((part, index) => index % 2 === 1 ? part : part.replace(/<(?=[A-Za-z!/?])/g, '&lt;')).join('');
  }).join('\n');
}

/**
 * Substitute placeholders in one section. Throws PrTemplateError on an unknown
 * placeholder; callers fall back to the default description.
 */
export function renderPrTemplateSection(text: string, values: PrTemplateValues, context: 'title' | 'body' = 'body'): string {
  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    if (!isKnownPlaceholder(name)) throw new PrTemplateError(`Unknown placeholder {{${name}}}`);
    const value = values[name] ?? '';
    if (context === 'title') return value.replace(/\s+/g, ' ').trim();
    return UNTRUSTED_PLACEHOLDERS.has(name) ? neutralizeHtml(value) : value;
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
  return PR_TEMPLATE_BODY_SECTIONS.map(section => {
    const override = template.sections[section];
    return override === undefined ? defaultSectionText(pieces, section) : renderPrTemplateSection(override, values).trim();
  }).filter(Boolean).join('\n\n');
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
