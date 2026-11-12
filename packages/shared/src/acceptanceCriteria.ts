/**
 * Acceptance criteria as a checklist. Pure: parses the criteria list out of an
 * issue or plan-item body, and the agent's per-criterion statements out of its
 * final report. Both are read from a CommonMark/GFM syntax tree, so code, HTML
 * and block quotes are told apart by the parser. No heading means no criteria.
 */

import type { Heading, List, ListItem, Nodes, Parent, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';

export interface AcceptanceCriterion {
    /** Stable id by position: AC1, AC2, ... */
    id: string;
    text: string;
}

export type AcceptanceCriterionStatus = 'met' | 'not_met' | 'not_applicable' | 'not_addressed';

export interface AcceptanceCriterionResult extends AcceptanceCriterion {
    status: AcceptanceCriterionStatus;
    /** The agent's file, test or reason for its statement; absent when not addressed. */
    evidence?: string;
}

export const MAX_ACCEPTANCE_CRITERIA = 20;
export const MAX_ACCEPTANCE_CRITERION_LENGTH = 300;
export const MAX_ACCEPTANCE_EVIDENCE_LENGTH = 300;
/**
 * Input bounds that keep parsing fast: micromark is quadratic in some inputs,
 * such as many lazy continuation lines or table rows, and in containers nested
 * on one line (`- - - …`, `> > …`), which also overflow the stack when deep
 * enough. Only the text before the first line past a bound is parsed.
 * 65,536 characters is GitHub's limit for an issue body.
 */
const MAX_PARSED_LENGTH = 65_536;
const MAX_PARSED_LINES = 2_000;
/** A line opening more block quotes and list items than this, as in `- > - > …`. */
const TOO_DEEP = /^[ \t]*(?:(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])[ \t]+)){9}/;
/** `- - - -` and the like are a thematic break, not nested lists. */
const THEMATIC_BREAK = /^[ \t]*([-*_])(?:[ \t]*\1)*[ \t]*$/;

export const ACCEPTANCE_CRITERION_STATUS_LABEL: Record<AcceptanceCriterionStatus, string> = {
    met: 'met',
    not_met: 'not met',
    not_applicable: 'not applicable',
    not_addressed: 'not addressed',
};

/** Nodes that are never a source of criteria or statements. */
const HIDDEN = new Set<string>(['code', 'html', 'blockquote']);

/** A parsed document with its source, which node positions index into. */
interface Document { source: string; tree: Root }

/** `markdown` up to the first line past the parse bounds. */
function parsedSource(markdown: string): string {
    const source = markdown.slice(0, MAX_PARSED_LENGTH);
    let start = 0;
    for (let line = 0; start < source.length; line++) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        const text = source.slice(start, end);
        if (line >= MAX_PARSED_LINES || (TOO_DEEP.test(text) && !THEMATIC_BREAK.test(text))) return source.slice(0, start);
        start = end + 1;
    }
    return source;
}

function parse(markdown: string): Document {
    const source = parsedSource(markdown);
    return { source, tree: fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) };
}

function bound(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function hasChildren(node: Nodes): node is Nodes & Parent {
    return 'children' in node;
}

/**
 * The source of `node`'s inline content, as written, without its inline HTML
 * (such as `<!-- comments -->`): from its first child to its last, so a
 * heading's `#`s and a task item's checkbox are not part of it.
 */
function inlineSource(document: Document, node: Parent): string {
    const first = node.children[0]?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    if (first === undefined || last === undefined) return '';
    const cuts: Array<[number, number]> = [];
    const collectHtml = (parent: Parent) => {
        for (const child of parent.children) {
            if (child.type === 'html' && child.position?.start.offset !== undefined && child.position.end.offset !== undefined) {
                cuts.push([child.position.start.offset, child.position.end.offset]);
            } else if (hasChildren(child)) collectHtml(child);
        }
    };
    collectHtml(node);
    let text = '';
    let position = first;
    for (const [start, end] of cuts) {
        text += `${document.source.slice(position, start)} `;
        position = end;
    }
    return text + document.source.slice(position, last);
}

/** `Acceptance criteria`, optionally emphasised and followed by a colon. */
function isAcceptanceHeading(heading: Heading): boolean {
    const plain = toString(heading).replace(/:\s*$/, '').trim().replace(/\s+/g, ' ');
    return plain.toLowerCase() === 'acceptance criteria';
}

/** The first "Acceptance criteria" heading in document order, at top level or in a list item, with the parent holding it. */
function findAcceptanceHeading(parent: Parent): { parent: Parent; index: number } | null {
    for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index] as Nodes;
        if (child.type === 'heading' && isAcceptanceHeading(child)) return { parent, index };
        if (child.type === 'list' || child.type === 'listItem') {
            const found = findAcceptanceHeading(child);
            if (found) return found;
        }
    }
    return null;
}

/** The nodes after the heading, up to the next heading of the same or a higher level among them. */
function criteriaSection(parent: Parent, index: number): RootContent[] {
    const level = (parent.children[index] as Heading).depth;
    const section: RootContent[] = [];
    for (const node of parent.children.slice(index + 1)) {
        if (node.type === 'heading' && node.depth <= level) break;
        section.push(node);
    }
    return section;
}

/** The text of an item's paragraphs and headings, including those of nested items, in order. */
function itemParts(document: Document, item: ListItem | List, parts: string[] = []): string[] {
    for (const child of item.children as Nodes[]) {
        if (child.type === 'paragraph' || child.type === 'heading') parts.push(inlineSource(document, child));
        else if (child.type === 'list' || child.type === 'listItem') itemParts(document, child, parts);
    }
    return parts;
}

const EMPTY_TASK = /^\[[ xX]\]$/;

function joinParts(parts: readonly string[]): string {
    return parts
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .reduce((text, part) => (text ? `${text}${/[:;,.]$/.test(text) ? ' ' : '; '}${part}` : part), '');
}

/**
 * The top-level list items under the first heading matching "Acceptance
 * criteria" (case-insensitive, any ATX or setext level), up to the next heading
 * of the same or a higher level. Each item is one criterion, worded as in the
 * source; nested items and headings inside the item are folded into it. Code,
 * HTML (including comments) and block quotes are dropped. At most
 * MAX_ACCEPTANCE_CRITERIA criteria of at most MAX_ACCEPTANCE_CRITERION_LENGTH
 * characters each.
 */
export function extractAcceptanceCriteria(body: string | null | undefined): AcceptanceCriterion[] {
    if (!body) return [];
    const document = parse(body);
    const heading = findAcceptanceHeading(document.tree);
    if (!heading) return [];
    const items = criteriaSection(heading.parent, heading.index).flatMap(node => (node.type === 'list' ? node.children : []));
    return items
        .map(item => joinParts(itemParts(document, item)))
        // GitHub renders `- [ ]` alone as an empty checkbox; micromark reads it as the text `[ ]`.
        .filter(text => !EMPTY_TASK.test(text))
        .filter(Boolean)
        .slice(0, MAX_ACCEPTANCE_CRITERIA)
        .map((text, index) => ({ id: `AC${index + 1}`, text: bound(text, MAX_ACCEPTANCE_CRITERION_LENGTH) }));
}

/** `- AC1: text` lines for prompts; empty without criteria. */
export function formatAcceptanceCriteriaList(criteria: readonly AcceptanceCriterion[]): string {
    return criteria.map(criterion => `- ${criterion.id}: ${criterion.text}`).join('\n');
}

const STATUS_PATTERNS: ReadonlyArray<[AcceptanceCriterionStatus, RegExp]> = [
    ['not_applicable', /^(?:not[ \t]+applicable|n\/a|na)\b/i],
    ['not_met', /^(?:not[ \t]+met|unmet|partially[ \t]+met|partial)\b/i],
    ['met', /^met\b/i],
];

function trimTrailing(text: string, characters: string): string {
    let end = text.length;
    while (end > 0 && characters.includes(text[end - 1])) end--;
    return text.slice(0, end);
}

/**
 * One per-criterion statement, e.g. `**AC2:** met — \`src/a.ts\``,
 * `AC2 - not met: reason` or `| AC2 | met | test/a.test.ts |`.
 */
function parseStatementLine(line: string): { id: string; status: AcceptanceCriterionStatus; evidence: string } | null {
    const idMatch = /\bAC(\d{1,3})\b/.exec(line);
    if (!idMatch) return null;
    // Only list markers, emphasis, brackets, checkboxes and table pipes may precede the id.
    if (!/^[\s\-*+>|#_[\]x\d.)]*$/i.test(line.slice(0, idMatch.index))) return null;
    let rest = line.slice(idMatch.index + idMatch[0].length).replace(/^[\s*_\]`)]*[:\-–—|.]?[\s*_`|]*/, '');
    let found: [AcceptanceCriterionStatus, string] | null = null;
    for (const [status, pattern] of STATUS_PATTERNS) {
        const match = pattern.exec(rest);
        if (match) {
            found = [status, rest.slice(match[0].length)];
            break;
        }
    }
    if (!found) return null;
    rest = trimTrailing(found[1].replace(/^[\s*_`]*(?:[:\-–—|,;.(]\s*)?/, ''), ' \t|*_').trim();
    return { id: `AC${Number(idMatch[1])}`, status: found[0], evidence: bound(rest.replace(/\s+/g, ' '), MAX_ACCEPTANCE_EVIDENCE_LENGTH) };
}

/**
 * The report's visible text lines in document order: each line of each
 * paragraph and heading, and each table row, outside code, HTML and block quotes.
 */
function statementLines(document: Document, parent: Parent, lines: string[] = []): string[] {
    for (const child of parent.children as Nodes[]) {
        if (HIDDEN.has(child.type)) continue;
        if (child.type === 'paragraph' || child.type === 'heading') lines.push(...inlineSource(document, child).split(/\r?\n/));
        else if (child.type === 'tableRow') {
            const { start, end } = child.position ?? {};
            if (start?.offset !== undefined && end?.offset !== undefined) lines.push(document.source.slice(start.offset, end.offset));
        } else if (hasChildren(child)) statementLines(document, child, lines);
    }
    return lines;
}

/**
 * Pair each criterion with the agent's last statement about it. A criterion
 * without a statement is `not_addressed`. Statements in code (such as a format
 * example), HTML comments or block quotes are not the agent's report and are
 * ignored.
 */
export function evaluateAcceptanceCriteria(
    criteria: readonly AcceptanceCriterion[],
    agentReport: string | null | undefined,
): AcceptanceCriterionResult[] {
    const statements = new Map<string, { status: AcceptanceCriterionStatus; evidence: string }>();
    const known = new Set(criteria.map(criterion => criterion.id));
    if (agentReport && known.size) {
        const document = parse(agentReport);
        for (const line of statementLines(document, document.tree)) {
            const statement = parseStatementLine(line);
            if (statement && known.has(statement.id)) statements.set(statement.id, statement);
        }
    }
    return criteria.map(criterion => {
        const statement = statements.get(criterion.id);
        if (!statement) return { ...criterion, status: 'not_addressed' };
        return { ...criterion, status: statement.status, ...(statement.evidence && { evidence: statement.evidence }) };
    });
}
