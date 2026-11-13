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
const MAX_ACTIVITY_TITLE_LENGTH = 120;

/** Titles come from people; keep them on one line and from closing the comment's markup. */
function inlineTitle(title: string | null | undefined): string {
    const text = (title ?? '').replace(/<!--|-->/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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
    if (inProgress.length > 0) lines.push(`In progress: ${inProgress.join('; ')}`);
    lines.push(`Up next: ${upNext.length > 0 ? upNext.join('; ') : 'none'}`);
    return lines;
}

/** The "In progress" and "Up next" lines of an existing progress comment, so a writer without them keeps them. */
export function extractEpicProgressActivityLines(body: string | null | undefined): string[] {
    return (body ?? '').split('\n').filter(line => ACTIVITY_LINE_PATTERN.test(line));
}


const MERGED_CHILDREN_LINE_PATTERN = /^Merged child PRs: /;
const PROGRESS_BAR_LINE_PATTERN = /^`[█░]*` \d+%$/;

/**
 * `body` (a progress comment by buildEpicProgressComment) with its "In
 * progress" and "Up next" lines replaced by `lines`, every other line kept as
 * its writer left it; null when `body` has no line they can follow.
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
    let anchor = kept.findIndex(line => MERGED_CHILDREN_LINE_PATTERN.test(line));
    if (anchor < 0) anchor = kept.findIndex(line => PROGRESS_BAR_LINE_PATTERN.test(line));
    if (anchor < 0) return null;
    kept.splice(anchor + 1, 0, ...lines.flatMap(line => ['', line]));
    return kept.join('\n');
}
