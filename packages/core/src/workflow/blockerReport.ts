import { redactSecrets } from '../utils/secretRedaction.js';

/**
 * The machine-readable line an agent ends its final message with when the
 * repository workflow sets `on_blocker: report` and the task cannot be
 * completed as specified. Everything after it is the agent's explanation.
 */
export const BLOCKER_MARKER = 'PROPR_BLOCKED:';

/** Upper bound on the explanation ProPR quotes in comments, history and notifications. */
export const BLOCKER_EXPLANATION_MAX_LENGTH = 2000;

const MISSING_EXPLANATION = 'The agent reported a blocker without an explanation.';

export interface BlockerReport {
    /** Bounded, secret-redacted explanation of what blocked the run and what is needed. */
    explanation: string;
}

function boundExplanation(text: string): string {
    const redacted = redactSecrets(text.trim()).trim();
    if (!redacted) return MISSING_EXPLANATION;
    if (redacted.length <= BLOCKER_EXPLANATION_MAX_LENGTH) return redacted;
    return `${redacted.slice(0, BLOCKER_EXPLANATION_MAX_LENGTH - 1).trimEnd()}…`;
}

const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}(?! )|(?=\s*$)| {5,})/;

function indentWidth(line: string): number {
    let width = 0;
    for (const char of line) {
        if (char === ' ') width += 1;
        else if (char === '\t') width += 4 - (width % 4);
        else break;
    }
    return width;
}

interface ListItemContent {
    /** The column the item's content starts at. */
    column: number;
    /** The line's text from that column on. */
    content: string;
}

/**
 * The content of the list item a line opens, or null when the line does not
 * open a list item. A marker followed by five or more spaces starts an
 * indented code block inside the item, so its content column is one space past
 * the marker.
 */
function listItemContent(line: string): ListItemContent | null {
    const expanded = line.replace(/\t/g, '    ');
    const match = LIST_ITEM.exec(expanded);
    if (!match) return null;
    const [, indent, marker, spacing] = match;
    const gap = spacing.length >= 1 && spacing.length <= 4 ? spacing.length : 1;
    const column = indent.length + marker.length + gap;
    return { column, content: expanded.slice(column) };
}

/** The innermost item a line opens, following nested markers such as `- 1. text`. */
function innermostListItem(line: string): ListItemContent | null {
    let item = listItemContent(line);
    if (!item) return null;
    for (let nested = listItemContent(item.content); nested; nested = listItemContent(item.content)) {
        item = { column: item.column + nested.column, content: nested.content };
    }
    return item;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** An open fenced code block and the content column of the container it was opened in. */
interface OpenFence {
    marker: string;
    column: number;
}

function openFence(content: string, column: number): OpenFence | null {
    const match = FENCE_OPEN.exec(content);
    return match ? { marker: match[1], column } : null;
}

/** The line relative to a container's content column (the line must be indented at least that far). */
function relativeTo(line: string, column: number): string {
    return ' '.repeat(Math.max(0, indentWidth(line) - column)) + line.trimStart();
}

/**
 * Finds the blocker marker in an agent's final message. Only a marker that
 * starts a top-level line counts: a marker inside a fenced code block, a
 * blockquote, an indented code block, a list item (including its indented
 * continuation lines and nested blocks, and fences opened on the item's own
 * marker line) or the middle of a sentence (for example, quoted tool output or
 * the agent restating its instructions) is ignored. A list, and any fence
 * opened inside it, ends at the first non-blank line indented less than its
 * items' content. When several markers qualify, the last one wins.
 */
export function parseBlockerReport(finalMessage: string | null | undefined): BlockerReport | null {
    if (!finalMessage?.includes(BLOCKER_MARKER)) return null;
    const lines = finalMessage.replace(/\r\n?/g, '\n').split('\n');
    let fence: OpenFence | null = null;
    // Content column of the open top-level list item; null outside lists.
    let listColumn: number | null = null;
    let markerLine = -1;
    lines.forEach((line, index) => {
        const blank = !line.trim();
        const indent = indentWidth(line);
        if (fence !== null) {
            // A fence inside a list item also ends when the item does.
            if (blank || indent >= fence.column) {
                const close = FENCE_CLOSE.exec(relativeTo(line, fence.column));
                if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
                return;
            }
            fence = null;
        }
        if (blank) return;
        const item = innermostListItem(line);
        if (listColumn !== null && indent >= listColumn) {
            // Continuation or nested item of the open list: never a blocker, but it may open a fence.
            fence = item ? openFence(item.content, item.column) : openFence(relativeTo(line, listColumn), listColumn);
            return;
        }
        listColumn = null;
        if (item) {
            listColumn = listItemContent(line)!.column;
            fence = openFence(item.content, item.column);
            return;
        }
        fence = openFence(line, 0);
        if (fence !== null) return;
        if (/^ {0,3}\S/.test(line) && line.trimStart().startsWith(BLOCKER_MARKER)) markerLine = index;
    });
    if (markerLine < 0) return null;
    const first = lines[markerLine].trimStart().slice(BLOCKER_MARKER.length);
    return { explanation: boundExplanation([first, ...lines.slice(markerLine + 1)].join('\n')) };
}

/** The agent's final message, as the coding agents report it. */
export function agentFinalMessage(result: { summary?: string | null; finalResult?: { result?: string | null } | null }): string {
    return result.summary || result.finalResult?.result || '';
}

/**
 * Detects a reported blocker only when the run's workflow enables it and the
 * agent ended normally; failed and interrupted runs keep their own handling.
 */
export function detectBlockerReport(
    result: { success?: boolean; summary?: string | null; finalResult?: { result?: string | null } | null } | null | undefined,
    enabled: boolean,
): BlockerReport | null {
    if (!enabled || !result?.success) return null;
    return parseBlockerReport(agentFinalMessage(result));
}

/** Appended to implementation and follow-up prompts when `on_blocker: report` is set. */
export function blockerReportPrompt(): string {
    return [
        '**IF YOU ARE BLOCKED:**',
        'If the task cannot be completed as specified, do not deliver a reduced, partial or placeholder version of it.',
        '- Leave the workspace without partial changes: revert any edits you made for this task.',
        `- End your final message with a line that starts with \`${BLOCKER_MARKER}\` (at the start of the line, not inside a code block or quote), followed by a short explanation of what blocked you and what is needed to continue.`,
        `- Example final line: \`${BLOCKER_MARKER} The payment API credentials are not available in this environment; a sandbox key is needed to run the integration tests.\``,
        `Use the marker only for a real blocker. If you completed the task, do not include \`${BLOCKER_MARKER}\` anywhere at the start of a line.`,
    ].join('\n');
}
