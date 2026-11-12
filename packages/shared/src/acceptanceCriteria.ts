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
 * A line inside the criteria section; null marks a break, such as a sub-heading
 * or a top-level code fence, that ends the current item.
 */
type SectionLine = string | null;

const LEADING_WHITESPACE = /^[ \t]*/;
const LIST_MARKER = /^([ \t]*(?:[-*+]|\d{1,9}[.)]))([ \t]*)/;

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

interface OpenFence {
    marker: string;
    /** Content column of the list item holding the fence; 0 at top level. */
    column: number;
}

/**
 * Tracks fenced code, including fences inside list items, whose indentation is
 * relative to the item's content column rather than the line start.
 */
class FenceTracker {
    private containers: number[] = [];
    private fence: OpenFence | null = null;
    private previousBlank = true;

    /**
     * The content column of the list item holding the fence when `line` is a
     * fence delimiter or fenced code (0 for a top-level fence), otherwise -1.
     */
    fenceColumn(line: string): number {
        const blank = !line.trim();
        const indent = columnWidth(LEADING_WHITESPACE.exec(line)?.[0] ?? '');
        const held = this.fence?.column;
        const fenced = this.fence ? this.continueFence(line, blank, indent) : this.openFence(line, blank, indent);
        this.previousBlank = blank;
        if (!fenced) return -1;
        // A closing delimiter clears the fence, and a less-indented line can end it and open another.
        return this.fence?.column ?? held ?? 0;
    }

    private continueFence(line: string, blank: boolean, indent: number): boolean {
        const fence = this.fence as OpenFence;
        // A line indented less than the holding list item ends the item and its fence.
        if (!blank && indent < fence.column) {
            this.fence = null;
            return this.openFence(line, blank, indent);
        }
        const run = this.delimiterAt(line, indent, fence.column);
        if (run && run[0] === fence.marker[0] && run.length >= fence.marker.length) this.fence = null;
        return true;
    }

    private openFence(line: string, blank: boolean, indent: number): boolean {
        if (blank) return false;
        // The list items this line can still belong to: those it is indented into.
        let depth = this.containers.length;
        while (depth && this.containers[depth - 1] > indent) depth--;
        const content = listContentColumn(line);
        const column = depth ? this.containers[depth - 1] : 0;
        const marker = content < 0 ? this.delimiterAt(line, indent, column) : null;
        // Only paragraph text continues a less-indented item lazily; a list item or fence ends it.
        if (content >= 0 || marker || this.previousBlank) this.containers.length = depth;
        if (content >= 0) this.containers.push(content);
        if (!marker) return false;
        this.fence = { marker, column };
        return true;
    }

    /** The fence run starting `line`, when its indentation is within three columns of `column`. */
    private delimiterAt(line: string, indent: number, column: number): string | null {
        if (indent < column || indent - column > 3) return null;
        return /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    }
}

interface VisibleLine {
    text: string;
    /** A code fence delimiter or a line inside fenced code. */
    fenced: boolean;
    /** Fenced code held by a list item, which the fence does not end. */
    inListItem: boolean;
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
    const fences = new FenceTracker();
    let inComment = false;
    for (const line of lines) {
        const fenceColumn = inComment ? -1 : fences.fenceColumn(line);
        if (fenceColumn >= 0) {
            visible.push({ text: line, fenced: true, inListItem: fenceColumn > 0 });
            continue;
        }
        const stripped = stripLineComments(line, inComment);
        inComment = stripped.inComment;
        // A line that was only comment reads as blank, like the rendered output.
        visible.push({ text: stripped.text.trim() ? stripped.text : '', fenced: false, inListItem: false });
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
 */
function criteriaSection(visible: readonly VisibleLine[]): SectionLine[] {
    const lines = visible.map(line => line.text);
    const section: SectionLine[] = [];
    let sectionLevel = 0;
    for (let index = 0; index < lines.length; index++) {
        if (visible[index].fenced) {
            if (sectionLevel) section.push(visible[index].inListItem ? '' : null);
            continue;
        }
        const found = headingAt(lines, index);
        if (found) {
            if (sectionLevel && found.heading.level <= sectionLevel) break;
            if (sectionLevel) section.push(null);
            else if (isAcceptanceHeading(found.heading.text)) sectionLevel = found.heading.level;
            index += found.span - 1;
            continue;
        }
        if (sectionLevel) section.push(lines[index]);
    }
    return section;
}

/**
 * Groups section lines into items: each top-level list item starts one, nested
 * items become further parts, and continuation lines extend the last part.
 */
function listItems(section: readonly SectionLine[]): string[][] {
    const items: string[][] = [];
    let current: string[] | null = null;
    let topIndent = -1;
    let previousBlank = true;
    for (const line of section) {
        if (line === null || !line.trim()) {
            if (line === null) current = null;
            previousBlank = true;
            continue;
        }
        const item = LIST_ITEM.exec(line);
        if (item) {
            const indent = columnWidth(item[1]);
            if (topIndent < 0) topIndent = indent;
            if (indent <= topIndent) {
                if (items.length >= MAX_ACCEPTANCE_CRITERIA) break;
                current = [item[2] ?? ''];
                items.push(current);
            } else current?.push(item[2] ?? '');
        } else if (current && (/^[ \t]/.test(line) || !previousBlank)) {
            // Indented or lazy continuation; a plain paragraph after a blank line ends the item.
            current[current.length - 1] += ` ${line.trim()}`;
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
 * same or a higher level. Each top-level item is one criterion; nested items
 * and continuation lines are folded into it. Checkboxes and HTML comments are dropped. At most
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
 * as a format example) or HTML comments are not the agent's report and are ignored.
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
