import { parseStructuredReview } from './reviewOutputParser.js';

const MAX_RECAP_CHARACTERS = 260;

function truncateAtWord(text: string, maximum = MAX_RECAP_CHARACTERS): string {
    const characters = Array.from(text);
    if (characters.length <= maximum) return text;
    const shortened = characters.slice(0, maximum - 1).join('');
    const lastSpace = shortened.lastIndexOf(' ');
    return `${shortened.slice(0, lastSpace >= maximum * 0.6 ? lastSpace : undefined).trimEnd()}…`;
}

const FENCE_RE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const BACKTICK_RUN_RE = /`+/y;
const INDENTED_CODE_RE = /^(?: {4}| {0,3}\t)/;
const INDENTED_CODE_FOLLOWS_RE = /^(?:[ \t]*| {0,3}#{1,6}(?:[ \t].*)?)$/;
const BLOCK_INDENT_RE = /^ {0,3}$/;

/** Where the code span opened by the backtick run at `start` ends, or -1 when the run is literal. */
function codeSpanEnd(text: string, start: number, length: number): number {
    const closer = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, 'g');
    closer.lastIndex = start + length;
    const match = closer.exec(text);
    // A code span cannot cross a blank line, which ends its paragraph.
    if (!match || /\n[ \t]*\n/.test(text.slice(start, match.index))) return -1;
    return match.index + length;
}

/** A blockquote, or a list item whose content is indented `width` columns. */
type Container = { quote: true } | { quote: false; width: number };

const QUOTE_MARKER_RE = /^ {0,3}> ?/;
const LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])( +)(?=\S)/;

function lineAt(text: string, from: number): string {
    const lineEnd = text.indexOf('\n', from);
    return text.slice(from, lineEnd === -1 ? undefined : lineEnd);
}

/** The blockquotes and list items a line opens, and its content inside them. */
function openContainers(line: string): { containers: Container[]; rest: string } {
    const containers: Container[] = [];
    let rest = line;
    for (;;) {
        const quote = QUOTE_MARKER_RE.exec(rest);
        if (quote) {
            containers.push({ quote: true });
            rest = rest.slice(quote[0].length);
            continue;
        }
        const item = LIST_MARKER_RE.exec(rest);
        if (!item) return { containers, rest };
        // Five or more spaces after the marker start indented code one space in.
        const width = item[0].length - (item[1].length > 4 ? item[1].length - 1 : 0);
        containers.push({ quote: false, width });
        rest = rest.slice(width);
    }
}

/** A later line's content inside `containers`, or null when the line falls outside them. */
function containedRest(line: string, containers: readonly Container[]): string | null {
    let rest = line;
    for (const container of containers) {
        if (container.quote) {
            const quote = QUOTE_MARKER_RE.exec(rest);
            if (!quote) return null;
            rest = rest.slice(quote[0].length);
        } else if (!rest.trim()) {
            rest = '';
        } else if (rest.startsWith(' '.repeat(container.width))) {
            rest = rest.slice(container.width);
        } else {
            return null;
        }
    }
    return rest;
}

/**
 * Where the fenced code block opening at `start` ends: after its closing
 * fence, before the first line outside its containers, or at the end of the text.
 */
function fenceEnd(text: string, start: number, containers: readonly Container[], fence: string): number {
    const closer = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*$`);
    let end = text.indexOf('\n', start);
    if (end === -1) return text.length;
    end += 1;
    while (end < text.length) {
        const line = lineAt(text, end);
        const rest = containedRest(line, containers);
        if (rest === null) return end;
        if (closer.test(rest)) return end + line.length;
        end += line.length + 1;
    }
    return text.length;
}

/**
 * Where the indented code block opening at `start` ends: at the first
 * non-blank line indented less than four columns inside its containers, or
 * outside them, or at the end of the text. Returns -1 when the line cannot
 * open one, because it is blank, not indented enough, or continues a paragraph.
 */
function indentedCodeEnd(text: string, start: number, containers: readonly Container[], rest: string): number {
    if (!INDENTED_CODE_RE.test(rest) || !rest.trim()) return -1;
    if (start > 0) {
        // A line outside these containers ends its paragraph; one inside must be blank or a heading.
        const previous = containedRest(text.slice(text.lastIndexOf('\n', start - 2) + 1, start - 1), containers);
        if (previous !== null && !INDENTED_CODE_FOLLOWS_RE.test(previous)) return -1;
    }
    let end = start;
    while (end < text.length) {
        const line = lineAt(text, end);
        const next = containedRest(line, containers);
        if (next === null || (next.trim() && !INDENTED_CODE_RE.test(next))) return end;
        end += line.length + 1;
    }
    return text.length;
}

/**
 * One pass over Markdown, removing the HTML comments it hides while keeping
 * comment syntax that code spans, fenced blocks and indented blocks show,
 * including those inside blockquotes and list items. An unclosed comment
 * opening a line, indented at most three spaces, hides the rest, as Markdown's
 * HTML block does; one elsewhere stays visible text.
 */
function stripHtmlCommentsOnce(text: string, replacement: string): string {
    let result = '';
    let index = 0;
    while (index < text.length) {
        const atLineStart = index === 0 || text[index - 1] === '\n';
        const opened = atLineStart ? openContainers(lineAt(text, index)) : null;
        const fence = opened ? FENCE_RE.exec(opened.rest) : null;
        if (opened && fence) {
            const end = fenceEnd(text, index, opened.containers, fence[1]);
            result += text.slice(index, end);
            index = end;
            continue;
        }
        const indentedEnd = opened ? indentedCodeEnd(text, index, opened.containers, opened.rest) : -1;
        if (indentedEnd !== -1) {
            result += text.slice(index, indentedEnd);
            index = indentedEnd;
            continue;
        }
        const character = text[index];
        if (character === '\\') {
            result += text.slice(index, index + 2);
            index += 2;
            continue;
        }
        if (character === '`') {
            BACKTICK_RUN_RE.lastIndex = index;
            const run = BACKTICK_RUN_RE.exec(text)![0].length;
            const end = codeSpanEnd(text, index, run);
            result += text.slice(index, end === -1 ? index + run : end);
            index = end === -1 ? index + run : end;
            continue;
        }
        if (text.startsWith('<!--', index)) {
            const close = text.indexOf('-->', index + 4);
            if (close !== -1) {
                result += replacement;
                index = close + 3;
                continue;
            }
            if (BLOCK_INDENT_RE.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index))) return result + replacement;
        }
        result += character;
        index += 1;
    }
    return result;
}

/**
 * Drop HTML comments until none remain, since one pass can splice a new
 * `<!--` together (`<!<!---->--`).
 */
function stripHtmlComments(text: string, replacement = ''): string {
    let previous: string;
    do {
        previous = text;
        text = stripHtmlCommentsOnce(text, replacement);
    } while (text !== previous);
    return text;
}

/** Convert an agent-authored Markdown summary into one safe, scannable Inbox line. */
export function compactNotificationRecap(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const lines = stripHtmlComments(value, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/```[^\n]*\n?/g, ' ')
        .split(/\r?\n/)
        .map(line => line
            .replace(/^\s{0,3}#{1,6}\s+/, '')
            .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, '')
            .replace(/^\s*>+\s?/, '')
            // Unwrap paired emphasis only, so snake_case identifiers keep their underscores.
            .replace(/`/g, '')
            .replace(/(\*{1,2}|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
            .replace(/(^|\W)(_{1,2})(?=\S)(.+?)(?<=\S)\2(?!\w)/g, '$1$3')
            .replace(/^summary(?: of changes)?\s*:?\s*/i, '')
            .trim())
        .filter(line => line && !/^[-=:|\s]+$/.test(line));
    const compact = lines.join(' · ').replace(/\s+/g, ' ').trim();
    return compact ? truncateAtWord(compact) : undefined;
}

/**
 * The agent-authored Markdown summary in full, for the Inbox's detail pane:
 * the one-line recap abridges it, this keeps it. Only hidden comments are
 * dropped.
 */
export function fullNotificationSummary(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    // Trim whole blank lines only, so a leading indented code block stays code.
    return stripHtmlComments(value).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() || undefined;
}

/** The review as posted, without the model, cost and `/fix` details GitHub shows below it. */
const REVIEW_DETAILS_RE = /\n+---\n+### 🤖 Review Details[^]*$/;

/** Every posted review in full, one after another, for the Inbox's detail pane. */
export function buildReviewNotificationSummary(results: readonly { commentBody?: string; analysisResult: { success: boolean } }[]): string | undefined {
    const reviews = results
        .filter(result => result.analysisResult.success && result.commentBody)
        .map(result => result.commentBody!.replace(REVIEW_DETAILS_RE, '').trim())
        .filter(Boolean);
    return fullNotificationSummary(reviews.join('\n\n'));
}

/** Task history metadata for a review that moved to its continuation pull request. */
export function stoppedReviewRecap(reason: string): { notificationRecap: string | undefined } {
    return { notificationRecap: compactNotificationRecap(reason) };
}

/** Task history metadata for an ultrafix review waiting on exact-head checks. */
export const deferredUltrafixReviewRecap = {
    notificationRecap: 'Review deferred until the continuation pull request passes its exact-head checks.',
} as const;

interface ReviewRecapResult {
    analysisResult: { success: boolean; response: string };
    findingCount?: number;
}

export function buildReviewNotificationRecap(results: readonly ReviewRecapResult[]): string {
    const successful = results.filter(result => result.analysisResult.success);
    const parsed = successful.map(result => ({
        result,
        review: parseStructuredReview(result.analysisResult.response),
    }));
    const valid = parsed.filter(item => item.review.status !== 'invalid');
    const scores = valid.flatMap(item => item.review.score === null ? [] : [item.review.score]);
    const issueCount = parsed.reduce((total, item) => total + (
        item.result.findingCount ?? item.review.actionableFindings.length
    ), 0);
    const issueTitles = valid.flatMap(item => item.review.actionableFindings.map(finding => finding.title));
    const scoreText = scores.length === 1
        ? `Score ${scores[0]}/10`
        : scores.length > 1
            ? `Scores ${scores.map(score => `${score}/10`).join(', ')}`
            : undefined;
    const issueText = `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'} found`;
    const titleText = issueTitles.length > 0 ? `: ${issueTitles.slice(0, 2).join('; ')}` : '';
    const failedCount = results.length - successful.length;
    const failureText = failedCount > 0
        ? `${failedCount} ${failedCount === 1 ? 'reviewer failed' : 'reviewers failed'}`
        : undefined;
    const details = [scoreText, successful.length > 0 ? `${issueText}${titleText}` : undefined, failureText]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
    return truncateAtWord(details || 'The review run finished without a published result.');
}

export function buildWorkNotificationRecap(
    summary: unknown,
    options: {
        commandMode?: string;
        filesChanged?: number;
        createdPullRequest?: boolean;
        noChanges?: boolean;
        partial?: boolean;
    } = {},
): string {
    const compact = compactNotificationRecap(summary);
    if (compact) return options.partial ? truncateAtWord(`Partial result: ${compact}`) : compact;
    if (options.noChanges) return 'Analyzed the request; no code changes were needed.';
    const files = options.filesChanged && options.filesChanged > 0
        ? ` across ${options.filesChanged} ${options.filesChanged === 1 ? 'file' : 'files'}`
        : '';
    switch (options.commandMode) {
        case 'fix': return `Applied the requested review fixes${files}.`;
        case 'merge': return `Updated the pull request branch and resolved merge conflicts${files}.`;
        default: return options.createdPullRequest
            ? `Implemented the requested work${files} and opened a pull request.`
            : `Implemented the requested work${files}.`;
    }
}

export function buildMergeNotificationRecap(options: {
    baseBranch: string;
    headBranch: string;
    conflictedFiles?: readonly string[];
    summary?: unknown;
}): string {
    const conflicts = options.conflictedFiles?.length ?? 0;
    const outcome = conflicts === 0
        ? `Merged ${options.baseBranch} into ${options.headBranch} cleanly.`
        : `Merged ${options.baseBranch} into ${options.headBranch} and resolved conflicts in ${conflicts} ${conflicts === 1 ? 'file' : 'files'}.`;
    const detail = compactNotificationRecap(options.summary);
    return truncateAtWord(detail ? `${outcome} ${detail}` : outcome);
}
