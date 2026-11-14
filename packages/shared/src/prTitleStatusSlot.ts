/**
 * The status slot at the start of a ProPR pull request title: one emoji for
 * the persistent state of the pull request (and, beside ⚠️ and ✅, the latest
 * review score as one circled digit), then a single space, then the title.
 *
 *     🔨 [3475 by Claude Opus 5.5] Let an automation run when …
 *     ⚠️⑥ [3475 by Claude Opus 5.5] …
 *     ✅⑧ [3510 by Claude Opus 5.5] Apply library extensions automatically …
 *
 * An epic pull request follows its emoji with how many of its issues are
 * merged into the epic branch, and shows no score:
 *
 *     🔨 3/5 [Epic] Scheduler primitives
 *
 * The API, the worker and the UI share these helpers: the slot is recognised
 * only by the strict pattern below, anchored at the start of the title, and
 * only that slot is ever replaced or removed.
 */

import { PR_TITLE_MAX_LENGTH } from './prTemplate.js';

export type TitleStatusState = 'working' | 'needs_attention' | 'ready';

export interface TitleStatus {
    state: TitleStatusState;
    /** Latest review score; shown beside ⚠️ and ✅ when it is a whole number from 1 to 10. */
    score?: number | null;
    /** Epic pull requests: issues merged into the epic branch out of all of them, shown as ` merged/total` after the emoji. */
    progress?: { merged: number; total: number } | null;
}

const WORKING = '\u{1F528}';
/** ⚠️ is U+26A0 followed by the emoji variation selector U+FE0F; the slot is written with both. */
const NEEDS_ATTENTION = '⚠️';
const READY = '✅';
/** ① (U+2460) to ⑩ (U+2469). */
const CIRCLED_ONE = 0x2460;

/**
 * The slot, anchored at the start of the title and followed by exactly one
 * space. ⚠ is accepted with and without its variation selector. The score is
 * only recognised beside ⚠️ and ✅. An epic's ` merged/total` may follow.
 */
export const PR_TITLE_STATUS_SLOT_PATTERN = /^(?:\u{1F528}|(?:⚠️?|✅)[①-⑩]?)(?: \d{1,6}\/\d{1,6})? /u;

function circledScore(score: number | null | undefined): string {
    if (typeof score !== 'number' || !Number.isFinite(score)) return '';
    const rounded = Math.round(score);
    if (rounded < 1 || rounded > 10) return '';
    return String.fromCodePoint(CIRCLED_ONE + rounded - 1);
}

const MAX_COUNT = 999_999;

/** ` merged/total` for an epic, or nothing when the counts are not whole numbers the slot pattern reads back. */
function progressText(progress: TitleStatus['progress']): string {
    if (!progress) return '';
    const { merged, total } = progress;
    const valid = (count: number) => Number.isSafeInteger(count) && count >= 0 && count <= MAX_COUNT;
    return valid(merged) && valid(total) && total > 0 ? ` ${merged}/${total}` : '';
}

/** The slot for a status, without the trailing space; null for no slot. */
export function renderStatusSlot(status: TitleStatus | null | undefined): string | null {
    if (!status) return null;
    const progress = progressText(status.progress);
    if (status.state === 'working') return `${WORKING}${progress}`;
    const emoji = status.state === 'ready' ? READY : NEEDS_ATTENTION;
    // An epic shows its progress and no review score.
    return progress ? `${emoji}${progress}` : `${emoji}${circledScore(status.score)}`;
}

/** The slot at the start of `title` (without its trailing space), or null when it has none. */
export function readStatusSlot(title: string | null | undefined): string | null {
    const match = typeof title === 'string' ? PR_TITLE_STATUS_SLOT_PATTERN.exec(title) : null;
    return match ? match[0].slice(0, -1) : null;
}

export function hasStatusSlot(title: string | null | undefined): boolean {
    return readStatusSlot(title) !== null;
}

/** The title without its status slot; any other title is returned unchanged. */
export function stripStatusSlot(title: string): string;
export function stripStatusSlot(title: string | null | undefined): string | null | undefined;
export function stripStatusSlot(title: string | null | undefined): string | null | undefined {
    if (typeof title !== 'string') return title;
    return title.replace(PR_TITLE_STATUS_SLOT_PATTERN, '');
}

/**
 * The title with its slot set for `status` (removed for null). Only the slot is
 * replaced: the rest of the title is kept exactly. When the result would exceed
 * GitHub's title limit the title is returned unchanged.
 */
export function withStatusSlot(title: string, status: TitleStatus | null | undefined): string {
    const slot = renderStatusSlot(status);
    const rest = stripStatusSlot(title);
    if (slot === null) return rest;
    const next = `${slot} ${rest}`;
    return next.length > PR_TITLE_MAX_LENGTH ? title : next;
}

export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * The commit title (and, for merge commits, the message) ProPR passes when it
 * merges a pull request, so the status slot never reaches the history:
 * `<title without slot> (#N)` for squash merges, GitHub's own
 * `Merge pull request #N from <head>` with the clean title as the message for
 * merge commits. Rebase merges keep each commit as it is and take no title.
 */
export function mergeCommitTitleFields(
    pull: { number: number; title?: string | null; headLabel?: string | null },
    method: PullRequestMergeMethod,
): { commit_title?: string; commit_message?: string } {
    const title = (stripStatusSlot(pull.title) ?? '').trim();
    // Without a title there is no slot to keep out: GitHub's default is clean.
    if (method === 'rebase' || !title) return {};
    if (method === 'squash') return { commit_title: `${title} (#${pull.number})` };
    const head = pull.headLabel ? ` from ${pull.headLabel.replace(':', '/')}` : '';
    return { commit_title: `Merge pull request #${pull.number}${head}`, commit_message: title };
}
