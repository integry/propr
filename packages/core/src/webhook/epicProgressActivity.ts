/**
 * The "In progress" and "Up next" lines of an open epic's progress comment
 * (buildEpicProgressComment), kept apart from the merge progress update.
 */

/** What an open epic is doing, for its progress comment. */
export interface EpicProgressActivity {
    /** Open child PRs (`prNumber`) and plan issues started without one (`prNumber` null). */
    inProgress: Array<{ prNumber: number | null; issueNumber: number | null; title: string | null; state?: string | null }>;
    /** Plan issues that have not started, in queue order. */
    upNext: Array<{ issueNumber: number; title: string | null }>;
}

const ACTIVITY_LINE_PATTERN = /^(?:In progress|Up next): /;
const ACTIVITY_LINE_PARTS_PATTERN = /^((?:In progress|Up next): )(.*)$/;
const MAX_ACTIVITY_TITLE_LENGTH = 120;
/** Between the entries of an activity line; titles lose theirs so a line can be split into its entries again. */
const ENTRY_SEPARATOR = '; ';
/** The last entry of a line whose other entries did not fit the comment (fitEpicProgressActivityLines). */
const OMITTED_ENTRIES_PATTERN = /^and (\d+) more$/;
/** GitHub rejects issue comments above this many characters; a progress comment is kept within it. */
export const EPIC_PROGRESS_COMMENT_MAX_LENGTH = 65536;
/** An activity line is its own paragraph: the blank line before it costs this much in the joined comment. */
const PARAGRAPH_BREAK_LENGTH = 2;

/** Titles come from people; keep them on one line, from closing the comment's markup, and from splitting an entry. */
function inlineTitle(title: string | null | undefined): string {
    const text = (title ?? '').replace(/<!--|-->/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/;/g, ',').trim();
    return text.length > MAX_ACTIVITY_TITLE_LENGTH ? `${text.slice(0, MAX_ACTIVITY_TITLE_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * The "In progress" and "Up next" lines of an open epic's progress comment,
 * for example `In progress: #3523 (issue #3475, Let an automation run …) - review 6/10`.
 * "In progress" is left out when nothing is; "Up next" reads "none" once the
 * last issue is in progress, and both are left out when nothing is either.
 */
export function renderEpicProgressActivity(activity: EpicProgressActivity | null | undefined): string[] {
    if (!activity || (activity.inProgress.length === 0 && activity.upNext.length === 0)) return [];
    const inProgress = activity.inProgress.map(item => {
        const title = inlineTitle(item.title);
        const state = inlineTitle(item.state);
        const subject = item.prNumber !== null
            ? `#${item.prNumber} (${[item.issueNumber !== null ? `issue #${item.issueNumber}` : null, title || null].filter(Boolean).join(', ') || 'no linked issue'})`
            : `#${item.issueNumber}${title ? ` (${title})` : ''}`;
        return state ? `${subject} - ${state}` : subject;
    });
    const upNext = activity.upNext.map(issue => {
        const title = inlineTitle(issue.title);
        return `#${issue.issueNumber}${title ? ` (${title})` : ''}`;
    });
    const lines: string[] = [];
    if (inProgress.length > 0) lines.push(`In progress: ${inProgress.join(ENTRY_SEPARATOR)}`);
    lines.push(`Up next: ${upNext.length > 0 ? upNext.join(ENTRY_SEPARATOR) : 'none'}`);
    return lines;
}

interface ActivityLineParts { prefix: string; entries: string[]; omitted: number }

function parseActivityLine(line: string): ActivityLineParts | null {
    const match = ACTIVITY_LINE_PARTS_PATTERN.exec(line);
    if (!match) return null;
    const entries = match[2].split(ENTRY_SEPARATOR);
    const omitted = Number(OMITTED_ENTRIES_PATTERN.exec(entries.at(-1) ?? '')?.[1] ?? 0);
    if (omitted > 0) entries.pop();
    return { prefix: match[1], entries, omitted };
}

function renderActivityLine({ prefix, entries, omitted }: ActivityLineParts): string {
    return prefix + [...entries, ...(omitted > 0 ? [`and ${omitted} more`] : [])].join(ENTRY_SEPARATOR);
}

/** `line` with as many of its leading entries as `budget` characters hold, the rest counted; null when not even the count fits. */
function fitActivityLine(line: string, budget: number): string | null {
    if (line.length <= budget) return line;
    const parts = parseActivityLine(line);
    if (!parts) return null;
    // The prefix and every shown entry with a separator after it; the last separator is dropped or followed by the count.
    let shownLength = parts.prefix.length + parts.entries.reduce((sum, entry) => sum + entry.length + ENTRY_SEPARATOR.length, 0);
    for (let shown = parts.entries.length; shown >= 0; shown--) {
        const omitted = parts.omitted + parts.entries.length - shown;
        const length = shownLength + (omitted > 0 ? `and ${omitted} more`.length : -ENTRY_SEPARATOR.length);
        if (length <= budget) return renderActivityLine({ prefix: parts.prefix, entries: parts.entries.slice(0, shown), omitted });
        if (shown > 0) shownLength -= parts.entries[shown - 1].length + ENTRY_SEPARATOR.length;
    }
    return null;
}

/**
 * `lines` (renderEpicProgressActivity, or extracted from a comment) as a
 * comment with `budget` characters left holds them, each costing its length
 * and its paragraph break: a line that does not fit lists as many of its
 * entries as its share holds and counts the rest (`and 897 more`). The "In
 * progress" line comes first and takes what the "Up next" line has no use for.
 * Both writers of the progress comment pass their final comment's remaining
 * space, so an epic of any supported size keeps a writable comment. A count
 * stands for entries no longer in the lines; the status sync renders them
 * again from the epic's facts.
 */
export function fitEpicProgressActivityLines(lines: string[], budget: number): string[] {
    const cost = (line: string): number => line.length + PARAGRAPH_BREAK_LENGTH;
    if (lines.reduce((sum, line) => sum + cost(line), 0) <= budget) return lines;
    const fitted: string[] = [];
    let remaining = budget;
    lines.forEach((line, index) => {
        const others = lines.slice(index + 1).reduce((sum, other) => sum + cost(other), 0);
        const share = Math.max(Math.floor(remaining / (lines.length - index)), remaining - others);
        const kept = fitActivityLine(line, share - PARAGRAPH_BREAK_LENGTH);
        if (kept === null) return;
        fitted.push(kept);
        remaining -= cost(kept);
    });
    return fitted;
}

/** The "In progress" and "Up next" lines of an existing progress comment, so a writer without them keeps them. */
export function extractEpicProgressActivityLines(body: string | null | undefined): string[] {
    return (body ?? '').split('\n').filter(line => ACTIVITY_LINE_PATTERN.test(line));
}


const MERGED_CHILDREN_LINE_PATTERN = /^Merged child PRs: /;
const PROGRESS_BAR_LINE_PATTERN = /^`[█░]*` \d+%$/;

/**
 * Inserts `activity` into `lines`, a progress comment's lines without
 * activity (joined by newlines), below "Merged child PRs" (or the progress
 * bar), each its own paragraph, fitted to the space the other lines leave
 * within GitHub's comment limit (fitEpicProgressActivityLines): the comment's
 * counts, merged child PRs, markers and merge line are never what gives.
 * False, inserting nothing, when `lines` has no line the activity can follow.
 */
export function insertEpicProgressActivityLines(lines: string[], activity: string[]): boolean {
    let anchor = lines.findIndex(line => MERGED_CHILDREN_LINE_PATTERN.test(line));
    if (anchor < 0) anchor = lines.findIndex(line => PROGRESS_BAR_LINE_PATTERN.test(line));
    if (anchor < 0) return false;
    const fitted = fitEpicProgressActivityLines(activity, EPIC_PROGRESS_COMMENT_MAX_LENGTH - lines.join('\n').length);
    lines.splice(anchor + 1, 0, ...fitted.flatMap(line => ['', line]));
    return true;
}

/**
 * `body` (a progress comment by buildEpicProgressComment) with its "In
 * progress" and "Up next" lines replaced by `lines`, fitted to the space the
 * other lines leave within GitHub's comment limit (insertEpicProgressActivityLines),
 * every other line kept as its writer left it; null when `body` has no line
 * they can follow.
 */
export function replaceEpicProgressActivityLines(body: string, lines: string[]): string | null {
    const kept: string[] = [];
    for (const line of body.split('\n')) {
        if (ACTIVITY_LINE_PATTERN.test(line)) {
            // Each activity line is its own paragraph: drop its blank line with it.
            if (kept.at(-1) === '') kept.pop();
            continue;
        }
        kept.push(line);
    }
    return insertEpicProgressActivityLines(kept, lines) ? kept.join('\n') : null;
}
