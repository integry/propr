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

function withoutHtmlComments(text: string): string {
    let result = '';
    let position = 0;
    for (;;) {
        const start = text.indexOf('<!--', position);
        if (start < 0) return result + text.slice(position);
        const end = text.indexOf('-->', start + 4);
        result += `${text.slice(position, start)} `;
        if (end < 0) return result;
        position = end + 3;
    }
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
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function indentWidth(whitespace: string): number {
    let width = 0;
    for (const char of whitespace) width += char === '\t' ? 4 - (width % 4) : 1;
    return width;
}

function cleanItemText(text: string): string {
    return withoutHtmlComments(text)
        .replace(/^\s*\[[ xX]\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function bound(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A line inside the criteria section; null marks a break such as a code fence that ends the current item. */
type SectionLine = string | null;

/** Whether `line` opens or closes a fence; returns the fence still open after it. */
function nextFence(line: string, fence: string | null): { fence: string | null; isFence: boolean } {
    const match = FENCE.exec(line);
    if (fence) return { fence: match && match[1][0] === fence[0] && match[1].length >= fence.length ? null : fence, isFence: true };
    return match ? { fence: match[1], isFence: true } : { fence: null, isFence: false };
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
 * heading of the same or a higher level. Fenced code becomes one break.
 */
function criteriaSection(lines: readonly string[]): SectionLine[] {
    const section: SectionLine[] = [];
    let sectionLevel = 0;
    let fence: string | null = null;
    for (let index = 0; index < lines.length; index++) {
        const fenced = nextFence(lines[index], fence);
        fence = fenced.fence;
        if (fenced.isFence) {
            if (sectionLevel) section.push(null);
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
            const indent = indentWidth(item[1]);
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
 * and continuation lines are folded into it. Checkboxes are dropped. At most
 * MAX_ACCEPTANCE_CRITERIA criteria of at most MAX_ACCEPTANCE_CRITERION_LENGTH
 * characters each.
 */
export function extractAcceptanceCriteria(body: string | null | undefined): AcceptanceCriterion[] {
    if (!body) return [];
    return listItems(criteriaSection(body.slice(0, MAX_SCANNED_LENGTH).split(/\r?\n/)))
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
 * without a statement is `not_addressed`.
 */
export function evaluateAcceptanceCriteria(
    criteria: readonly AcceptanceCriterion[],
    agentReport: string | null | undefined,
): AcceptanceCriterionResult[] {
    const statements = new Map<string, { status: AcceptanceCriterionStatus; evidence: string }>();
    const known = new Set(criteria.map(criterion => criterion.id));
    for (const line of (agentReport ?? '').slice(0, MAX_SCANNED_LENGTH).split(/\r?\n/)) {
        const statement = parseStatementLine(line);
        if (statement && known.has(statement.id)) statements.set(statement.id, statement);
    }
    return criteria.map(criterion => {
        const statement = statements.get(criterion.id);
        if (!statement) return { ...criterion, status: 'not_addressed' };
        return { ...criterion, status: statement.status, ...(statement.evidence && { evidence: statement.evidence }) };
    });
}
