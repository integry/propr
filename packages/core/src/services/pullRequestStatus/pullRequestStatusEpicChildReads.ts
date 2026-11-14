import type { EpicChildPullRequest } from '../../webhook/epicMergeProgress.js';
import type { PullRequestStatus } from './pullRequestStatus.js';

/**
 * Which open sub-PRs of an epic have their status read in one update, and the
 * statuses earlier updates read that still hold. One update reads at most
 * MAX_EPIC_CHILD_STATUSES sub-PRs; an epic with more converges over several
 * updates: the sub-PRs without a status that still holds are read first, and
 * every status read is kept for the next update, so each update reads sub-PRs
 * the last one left unread until every one is known.
 *
 * A kept status holds while the sub-PR keeps the head commit and the GitHub
 * update time the list showed when it was read: the sub-PR's own status sync
 * rewrites its block (and title) whenever its status changes, which changes
 * that time and signals the epic, so a kept status is never used past the
 * change that made it stale. The list is read before the sub-PR's status, so
 * a status is never kept under an update time older than what it describes.
 * A status also expires after RETAINED_STATUS_TTL_MS, for a change whose
 * sub-PR write failed. Kept in this process: after a restart the first
 * updates read the sub-PRs again.
 */

/** Open sub-PRs whose status is read for one epic update; the rest come from earlier updates, or stay unread. */
export const MAX_EPIC_CHILD_STATUSES = 10;
const RETAINED_STATUS_TTL_MS = 10 * 60_000;
const MAX_RETAINED_EPICS = 500;
/**
 * Updates in a row, each leaving sub-PRs unread, that read no sub-PR not
 * already read since the last update that left none unread, after which no
 * further update is scheduled to read them. An update that reads a sub-PR not
 * read since then makes progress, however many updates came before it: those
 * are read before the sub-PRs read since (planEpicChildReads, longest unread
 * first), so a stable epic of any size is read to the end. Only sub-PRs whose
 * statuses stop holding again (changed, or expired) faster than they are read
 * stall it; a change signals the epic again anyway.
 */
export const MAX_STALLED_EPIC_CHILD_READ_PASSES = 20;

interface RetainedChildStatus {
    status: PullRequestStatus;
    headSha: string;
    updatedAt: string;
    readAt: number;
}

interface RetainedEpic {
    children: Map<number, RetainedChildStatus>;
    /** Open sub-PRs read since the last update that left none unread. */
    readSinceComplete: Set<number>;
    /** Updates in a row that left a sub-PR unread and read only sub-PRs in readSinceComplete. */
    stalledPasses: number;
}

const retainedEpics = new Map<string, RetainedEpic>();

function epicOf(epicKey: string): RetainedEpic {
    const epic = retainedEpics.get(epicKey) ?? { children: new Map(), readSinceComplete: new Set(), stalledPasses: 0 };
    // Most recently used last, so the oldest epic is the one forgotten.
    retainedEpics.delete(epicKey);
    retainedEpics.set(epicKey, epic);
    while (retainedEpics.size > MAX_RETAINED_EPICS) retainedEpics.delete(retainedEpics.keys().next().value as string);
    return epic;
}

function holds(kept: RetainedChildStatus | undefined, child: EpicChildPullRequest, now: number): kept is RetainedChildStatus {
    return !!kept && !!child.updatedAt && !!child.headSha && kept.updatedAt === child.updatedAt && kept.headSha === child.headSha
        && now - kept.readAt < RETAINED_STATUS_TTL_MS;
}

export interface EpicChildReadPlan {
    /** Sub-PRs whose status this update reads. */
    read: Set<number>;
    /** Statuses earlier updates read that still hold, for sub-PRs this update does not read. */
    kept: Map<number, PullRequestStatus>;
}

/**
 * The sub-PRs of `children` (open, readable) this update reads: those without
 * a status that holds first, then the longest-held ones while the budget lasts,
 * so an epic within the budget has every sub-PR read on every update. Sub-PRs
 * no longer open are forgotten.
 */
export function planEpicChildReads(epicKey: string, children: EpicChildPullRequest[], now = Date.now()): EpicChildReadPlan {
    const epic = epicOf(epicKey);
    const open = new Set(children.map(child => child.number));
    for (const number of [...epic.children.keys()]) if (!open.has(number)) epic.children.delete(number);
    for (const number of [...epic.readSinceComplete]) if (!open.has(number)) epic.readSinceComplete.delete(number);
    const readAt = (child: EpicChildPullRequest) => epic.children.get(child.number)?.readAt ?? -Infinity;
    const stale = children.filter(child => !holds(epic.children.get(child.number), child, now)).sort((a, b) => readAt(a) - readAt(b));
    const held = children.filter(child => holds(epic.children.get(child.number), child, now)).sort((a, b) => readAt(a) - readAt(b));
    const read = new Set([...stale, ...held].slice(0, MAX_EPIC_CHILD_STATUSES).map(child => child.number));
    const kept = new Map(held.filter(child => !read.has(child.number)).map(child => [child.number, epic.children.get(child.number)!.status]));
    return { read, kept };
}

/** Keeps a status this update read, under the head and update time the list showed for the sub-PR. */
export function retainEpicChildStatus(epicKey: string, child: EpicChildPullRequest, status: PullRequestStatus, readAt: number): void {
    const epic = retainedEpics.get(epicKey);
    if (!epic || !child.updatedAt || !child.headSha) return;
    epic.children.set(child.number, { status, headSha: child.headSha, updatedAt: child.updatedAt, readAt });
}

/**
 * Records the sub-PRs this update read and how many it left unread; true when
 * another update should be scheduled to read them: while updates read sub-PRs
 * not read since the last one that left none unread, and then for at most
 * MAX_STALLED_EPIC_CHILD_READ_PASSES updates in a row that read none.
 */
export function noteEpicChildReadPass(epicKey: string, pass: { read: ReadonlySet<number>; unread: number }): boolean {
    const epic = retainedEpics.get(epicKey);
    if (!epic) return false;
    if (pass.unread === 0) {
        epic.readSinceComplete.clear();
        epic.stalledPasses = 0;
        return false;
    }
    const before = epic.readSinceComplete.size;
    for (const number of pass.read) epic.readSinceComplete.add(number);
    epic.stalledPasses = epic.readSinceComplete.size > before ? 0 : epic.stalledPasses + 1;
    return epic.stalledPasses <= MAX_STALLED_EPIC_CHILD_READ_PASSES;
}

/** Test hook: forgets every kept sub-PR status. */
export function resetEpicChildReadsForTests(): void {
    retainedEpics.clear();
}
