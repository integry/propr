/**
 * Acceptance criteria as a checklist. Pure: parses the criteria list out of an
 * issue or plan-item body, and the agent's per-criterion statements out of its
 * final report. No heading means no criteria.
 */

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
/** Longest body scanned; longer bodies are cut, never parsed slowly. */
const MAX_SCANNED_LENGTH = 200_000;

export const ACCEPTANCE_CRITERION_STATUS_LABEL: Record<AcceptanceCriterionStatus, string> = {
    met: 'met',
    not_met: 'not met',
    not_applicable: 'not applicable',
    not_addressed: 'not addressed',
};

interface Heading { level: number; text: string }

function atxHeading(line: string): Heading | null {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (!match) return null;
    return { level: match[1].length, text: withoutClosingHashes((match[2] ?? '').trim()) };
}

/** Drops an ATX heading's optional closing sequence of #s. */
function withoutClosingHashes(text: string): string {
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end--;
    if (end === 0) return '';
    return end < text.length && /[ \t]/.test(text[end - 1]) ? text.slice(0, end).trim() : text;
}

function trimTrailing(text: string, characters: string): string {
    let end = text.length;
    while (end > 0 && characters.includes(text[end - 1])) end--;
    return text.slice(0, end);
}

function setextLevel(line: string): number {
    if (/^ {0,3}=+[ \t]*$/.test(line)) return 1;
    if (/^ {0,3}-+[ \t]*$/.test(line)) return 2;
    return 0;
}

/** `Acceptance criteria`, optionally emphasised and followed by a colon. */
function isAcceptanceHeading(text: string): boolean {
    const plain = text.replace(/[*_`]/g, '').replace(/:\s*$/, '').trim().replace(/\s+/g, ' ');
    return plain.toLowerCase() === 'acceptance criteria';
}

const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

function cleanItemText(text: string): string {
    return text
        .replace(/^\s*\[[ xX]\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function bound(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A line inside the criteria section: text, with whether a list item that opened
 * inside the section holds it (so it is a nested item or a continuation, never a
 * criterion of its own); a heading held by such an item, which is a part of it;
 * or null for a break, such as a sub-heading or a top-level code fence, that
 * ends the current item.
 */
type SectionLine = { text: string; inItem: boolean } | { heading: string } | null;

const LEADING_WHITESPACE = /^[ \t]*/;
/** Most list items one line is read as opening, as in `- 1. text`; keeps long marker runs linear. */
const MAX_ITEMS_PER_LINE = 8;
/** Most block quotes read as nested, as in `> > text`; deeper ones read as fenced code, keeping each line's scan linear. */
const MAX_QUOTE_DEPTH = 8;
const LIST_MARKER = /^([ \t]*(?:[-*+]|\d{1,9}[.)]))([ \t]*)/;
const QUOTE_MARKER = /^[ \t]*>[ \t]?/;

/** Width of `text` in columns, with tab stops every four columns. */
function columnWidth(text: string): number {
    let width = 0;
    for (const char of text) width += char === '\t' ? 4 - (width % 4) : 1;
    return width;
}

/** The column where a list item's content starts, or -1 when `line` is not a list item. */
function listContentColumn(line: string): number {
    const match = LIST_MARKER.exec(line);
    if (!match || !LIST_ITEM.test(line)) return -1;
    const markerEnd = columnWidth(match[1]);
    const spacing = columnWidth(match[1] + match[2]) - markerEnd;
    // An empty item, or one followed by 5+ columns (indented code), starts content one column on.
    return spacing < 1 || spacing > 4 || !line.slice(match[0].length).trim() ? markerEnd + 1 : markerEnd + spacing;
}

/**
 * The list item's content as a line of its own, padded to its content column,
 * when the content starts on the item's line; otherwise null.
 */
function itemContentLine(line: string, column: number): string | null {
    const match = LIST_MARKER.exec(line) as RegExpExecArray;
    const text = line.slice(match[0].length);
    return text.trim() && column === columnWidth(match[0]) ? ' '.repeat(column) + text : null;
}

/** The fence run `text` opens with; a backtick run followed by another backtick is inline code. */
function fenceRun(text: string): string | null {
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(text);
    return match && !(match[1][0] === '`' && match[2].includes('`')) ? match[1] : null;
}

/** The fence run of a closing delimiter, which only whitespace may follow: `~~~ text` is fenced code. */
function closingFenceRun(text: string): string | null {
    return /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text)?.[1] ?? null;
}

/** A block quote line's content, after its `>` and one optional space; null when `text` is not quoted. */
function quotedText(text: string): string | null {
    const match = QUOTE_MARKER.exec(text);
    return match ? text.slice(match[0].length) : null;
}

interface OpenFence {
    marker: string;
    /** Content column of the list item holding the fence; 0 at top level. */
    column: number;
}

interface OpenQuote {
    /** Reads the quote's content, without its `>` markers, as a document of its own. */
    content: FenceTracker;
    /** Content column of the list item holding the quote; 0 at top level. */
    column: number;
}

/** How a line relates to the list items holding it and to fenced code. */
interface TrackedLine {
    /** Content column of the list item holding the line; 0 at top level. */
    column: number;
    /** A code fence delimiter or a line inside fenced code, including fenced code in a block quote. */
    fenced: boolean;
    /**
     * Set when the fence opens on a list item's own line, as in `- \`\`\`md`
     * or `- > \`\`\`md`: the item's marker, which starts the item although its
     * content is fenced.
     */
    itemMarker?: string;
}

/**
 * Tracks the list items holding each line, and fenced code, including fences
 * inside list items, whose indentation is relative to the item's content column
 * rather than the line start, and fences inside block quotes, whose lines start
 * with the quote's `>` markers.
 */
class FenceTracker {
    private containers: number[] = [];
    private fence: OpenFence | null = null;
    private quote: OpenQuote | null = null;
    /** True after a line that no paragraph text continues lazily: a blank line or a heading. */
    private previousBlank = true;
    /** Content column of the list item holding the current line. */
    private column = 0;

    constructor(private readonly quoteDepth = 0) {}

    /** How `line`, the next line of the document, relates to its list items and to fenced code. */
    track(line: string): TrackedLine {
        const blank = !line.trim();
        const indent = columnWidth(LEADING_WHITESPACE.exec(line)?.[0] ?? '');
        const fenced = this.fence ? this.continueFence(line, blank, indent) : this.openFence(line, blank, indent);
        this.previousBlank = blank || (!fenced && atxHeading(line) !== null);
        const tracked: TrackedLine = { column: this.column, fenced: fenced !== false };
        if (typeof fenced === 'string') tracked.itemMarker = fenced;
        return tracked;
    }

    private continueFence(line: string, blank: boolean, indent: number): boolean | string {
        const fence = this.fence as OpenFence;
        // A line indented less than the holding list item ends the item and its fence.
        if (!blank && indent < fence.column) {
            this.fence = null;
            return this.openFence(line, blank, indent);
        }
        this.column = fence.column;
        const run = this.startAt(line, indent, fence.column, closingFenceRun);
        if (run && run[0] === fence.marker[0] && run.length >= fence.marker.length) this.fence = null;
        return true;
    }

    /**
     * True when `line` opens a fence, or is fenced code in a block quote; the
     * item marker when that starts on a list item's line.
     */
    private openFence(line: string, blank: boolean, indent: number): boolean | string {
        if (blank) {
            // A blank line ends a block quote, and any fence inside it.
            this.quote = null;
            return false;
        }
        // The list items this line can still belong to: those it is indented into.
        let depth = this.containers.length;
        while (depth && this.containers[depth - 1] > indent) depth--;
        const content = listContentColumn(line);
        const column = depth ? this.containers[depth - 1] : 0;
        this.column = column;
        const quoted = content < 0 ? this.startAt(line, indent, column, quotedText) : null;
        const marker = content < 0 && quoted === null ? this.startAt(line, indent, column, fenceRun) : null;
        // Only paragraph text continues a less-indented item lazily; a list item, block quote, fence or heading ends it.
        if (content >= 0 || quoted !== null || marker || this.previousBlank || atxHeading(line)) this.containers.length = depth;
        if (quoted !== null) return this.quoteLine(quoted, column);
        this.quote = null;
        if (content >= 0) return this.openItems(line, content);
        if (!marker) return false;
        this.fence = { marker, column };
        return true;
    }

    /**
     * Records the list items starting on `line`, such as `- 1. text`, and opens
     * the fence, or the block quote, that their content starts with, if any.
     */
    private openItems(line: string, firstColumn: number): boolean | string {
        let itemLine: string | null = line;
        let column = firstColumn;
        for (let opened = 0; itemLine !== null && column >= 0 && opened < MAX_ITEMS_PER_LINE; opened++) {
            this.containers.push(column);
            itemLine = itemContentLine(itemLine, column);
            if (itemLine === null) return false;
            const quoted = this.startAt(itemLine, column, column, quotedText);
            const marker = quoted === null ? fenceRun(itemLine.slice(column)) : null;
            if (marker) this.fence = { marker, column };
            if (marker || (quoted !== null && this.quoteLine(quoted, column))) return (LIST_MARKER.exec(line) as RegExpExecArray)[0];
            if (quoted !== null) return false;
            column = listContentColumn(itemLine);
        }
        return false;
    }

    /**
     * Reads a block quote line's content with the quote's own tracker; true when
     * that content is fenced code, or is nested too deep to read.
     */
    private quoteLine(text: string, column: number): boolean {
        if (this.quoteDepth >= MAX_QUOTE_DEPTH) return true;
        if (this.quote?.column !== column) this.quote = { content: new FenceTracker(this.quoteDepth + 1), column };
        return this.quote.content.track(text).fenced;
    }

    /**
     * What `start` reads from `line` (a fence run, or a block quote's content),
     * when its indentation is within three columns of `column`.
     */
    private startAt(line: string, indent: number, column: number, start: (text: string) => string | null): string | null {
        return indent < column || indent - column > 3 ? null : start(line);
    }
}

interface VisibleLine {
    text: string;
    /** A code fence delimiter or a line inside fenced code, including fenced code in a block quote. */
    fenced: boolean;
    /** Content column of the list item holding the line; 0 at top level and inside HTML comments. */
    column: number;
}

/** Removes `<!-- ... -->` comments from one line, given whether a comment is already open at its start. */
function stripLineComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
    let text = '';
    let position = 0;
    let open = inComment;
    for (;;) {
        if (open) {
            const end = line.indexOf('-->', position);
            if (end < 0) return { text, inComment: true };
            position = end + 3;
            open = false;
            text += ' ';
        }
        const start = line.indexOf('<!--', position);
        if (start < 0) return { text: text + line.slice(position), inComment: false };
        text += line.slice(position, start);
        position = start + 4;
        open = true;
    }
}

/**
 * The lines as rendered: HTML comment contents, including comments spanning
 * lines, are dropped (each line kept, so line boundaries hold), and fenced code
 * is marked. Comment delimiters inside fenced code are literal text.
 */
function visibleLines(lines: readonly string[]): VisibleLine[] {
    const visible: VisibleLine[] = [];
    const tracker = new FenceTracker();
    let inComment = false;
    for (const line of lines) {
        const tracked = inComment ? null : tracker.track(line);
        if (tracked?.itemMarker !== undefined) {
            // The item starts here, but its content is the fence's opening delimiter.
            visible.push({ text: tracked.itemMarker, fenced: false, column: tracked.column });
            continue;
        }
        if (tracked?.fenced) {
            visible.push({ text: line, fenced: true, column: tracked.column });
            continue;
        }
        const stripped = stripLineComments(line, inComment);
        inComment = stripped.inComment;
        // A line that was only comment reads as blank, like the rendered output.
        visible.push({ text: stripped.text.trim() ? stripped.text : '', fenced: false, column: tracked?.column ?? 0 });
    }
    return visible;
}

/** The heading `lines[index]` starts, and how many lines it spans. */
function headingAt(lines: readonly string[], index: number): { heading: Heading; span: number } | null {
    const line = lines[index];
    const atx = atxHeading(line);
    if (atx) return { heading: atx, span: 1 };
    const previousBlank = index === 0 || !lines[index - 1].trim();
    const level = line.trim() && previousBlank && !LIST_ITEM.test(line) ? setextLevel(lines[index + 1] ?? '') : 0;
    return level ? { heading: { level, text: line.trim() }, span: 2 } : null;
}

/**
 * The lines under the first "Acceptance criteria" heading, up to the next
 * heading of the same or a higher level. A top-level code fence is a break; a
 * fence inside a list item reads as blank lines, so the item continues after it.
 * A heading inside a list item is part of that item, and never ends the section.
 */
function criteriaSection(visible: readonly VisibleLine[]): SectionLine[] {
    const lines = visible.map(line => line.text);
    const section: SectionLine[] = [];
    let sectionLevel = 0;
    // Content column of the list item holding the section's heading; 0 at top level.
    let sectionColumn = 0;
    for (let index = 0; index < lines.length; index++) {
        // Held by a list item that opened inside the section, so part of a criterion.
        const inItem = sectionLevel > 0 && visible[index].column > sectionColumn;
        if (visible[index].fenced) {
            if (sectionLevel) section.push(inItem ? { text: '', inItem } : null);
            continue;
        }
        const found = headingAt(lines, index);
        if (found) {
            if (inItem) section.push({ heading: found.heading.text });
            else if (sectionLevel && found.heading.level <= sectionLevel) break;
            else if (sectionLevel) section.push(null);
            else if (isAcceptanceHeading(found.heading.text)) [sectionLevel, sectionColumn] = [found.heading.level, visible[index].column];
            index += found.span - 1;
            continue;
        }
        if (sectionLevel) section.push({ text: lines[index], inItem });
    }
    return section;
}

/**
 * Groups section lines into items: each list item not held by another item
 * opened in the section starts one, items and headings held by one become
 * further parts, and continuation lines extend the last part. Whether an item
 * holds a line follows the list structure: a marker left of the previous item's
 * content column starts a sibling, however the two markers are indented.
 */
function listItems(section: readonly SectionLine[]): string[][] {
    const items: string[][] = [];
    let current: string[] | null = null;
    let previousBlank = true;
    for (const line of section) {
        if (line !== null && 'heading' in line) {
            // As after a blank line, nothing continues the heading lazily.
            current?.push(line.heading);
            previousBlank = true;
            continue;
        }
        if (line === null || !line.text.trim()) {
            if (line === null) current = null;
            previousBlank = true;
            continue;
        }
        const item = LIST_ITEM.exec(line.text);
        if (item) {
            if (line.inItem) current?.push(item[2] ?? '');
            else {
                if (items.length >= MAX_ACCEPTANCE_CRITERIA) break;
                current = [item[2] ?? ''];
                items.push(current);
            }
        } else if (current && (/^[ \t]/.test(line.text) || !previousBlank)) {
            // Indented or lazy continuation; a plain paragraph after a blank line ends the item.
            current[current.length - 1] += ` ${line.text.trim()}`;
        } else current = null;
        previousBlank = false;
    }
    return items;
}

function joinParts(parts: readonly string[]): string {
    return parts.map(cleanItemText).filter(Boolean).reduce((text, part) => (text ? `${text}${/[:;,.]$/.test(text) ? ' ' : '; '}${part}` : part), '');
}

/**
 * The list items under the first heading matching "Acceptance criteria"
 * (case-insensitive, any ATX or setext level), up to the next heading of the
 * same or a higher level outside a list item. Each top-level item is one
 * criterion; nested items, headings inside the item and continuation lines are
 * folded into it. Checkboxes, HTML comments and fenced code, including fenced
 * code in a block quote, are dropped. At most
 * MAX_ACCEPTANCE_CRITERIA criteria of at most MAX_ACCEPTANCE_CRITERION_LENGTH
 * characters each.
 */
export function extractAcceptanceCriteria(body: string | null | undefined): AcceptanceCriterion[] {
    if (!body) return [];
    return listItems(criteriaSection(visibleLines(body.slice(0, MAX_SCANNED_LENGTH).split(/\r?\n/))))
        .map(joinParts)
        .filter(Boolean)
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

/**
 * One per-criterion statement, e.g. `- **AC2:** met — \`src/a.ts\``,
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
 * Pair each criterion with the agent's last statement about it. A criterion
 * without a statement is `not_addressed`. Statements inside fenced code (such
 * as a format example, including one in a block quote) or HTML comments are
 * not the agent's report and are ignored.
 */
export function evaluateAcceptanceCriteria(
    criteria: readonly AcceptanceCriterion[],
    agentReport: string | null | undefined,
): AcceptanceCriterionResult[] {
    const statements = new Map<string, { status: AcceptanceCriterionStatus; evidence: string }>();
    const known = new Set(criteria.map(criterion => criterion.id));
    for (const line of visibleLines((agentReport ?? '').slice(0, MAX_SCANNED_LENGTH).split(/\r?\n/))) {
        if (line.fenced) continue;
        const statement = parseStatementLine(line.text);
        if (statement && known.has(statement.id)) statements.set(statement.id, statement);
    }
    return criteria.map(criterion => {
        const statement = statements.get(criterion.id);
        if (!statement) return { ...criterion, status: 'not_addressed' };
        return { ...criterion, status: statement.status, ...(statement.evidence && { evidence: statement.evidence }) };
    });
}
