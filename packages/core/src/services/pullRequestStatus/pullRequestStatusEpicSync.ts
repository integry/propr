import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    buildEpicProgressComment, renderEpicProgressActivity, syncOpenEpicProgressComment, type EpicProgressActivity,
} from '../../webhook/epicMergeProgress.js';
import { withEpicProgressLeaseIfFree } from '../../webhook/epicMergeProgressRetry.js';
import { PR_BODY_MAX_LENGTH, readStatusSlot } from '@propr/shared';
import type { EpicStatusFacts, PullRequestStatus } from './pullRequestStatus.js';
import { applyPullRequestStatusBlock, describeChildStatus, extractPullRequestStatusBlock } from './pullRequestStatusBlock.js';
import { paginatingGitHub } from './pullRequestStatusEpicFacts.js';
import type { PullRequestStatusGitHub, PullRequestStatusPull } from './pullRequestStatusFacts.js';
import type { PullRequestTitleDecision } from './pullRequestStatusTitle.js';
import {
    requestEpicPullRequestStatusSync, setPullRequestStatusEpicSyncRunner, type PullRequestStatusEpicSyncRunner,
} from './pullRequestStatusSignal.js';

/**
 * The epic side of the status sync: the epic progress comment is brought up
 * to date in the same update as the epic PR's status block, and a change on
 * a sub-PR, or on a plan issue, schedules the update of its epic PR.
 */

/** What an open epic is doing, as its progress comment lists it. */
export function epicProgressActivity(epic: EpicStatusFacts): EpicProgressActivity {
    return {
        inProgress: [
            ...(epic.children ?? []).map(child => ({
                prNumber: child.prNumber, issueNumber: child.issueNumber, title: child.title, state: describeChildStatus(child.status, 'comment') || null,
            })),
            ...(epic.startedIssues ?? []).map(issue => ({
                prNumber: null, issueNumber: issue.issueNumber, title: issue.title, state: issue.blocked ? 'stopped on a blocker' : null,
            })),
        ],
        upNext: (epic.upNext ?? []).map(issue => ({ issueNumber: issue.issueNumber, title: issue.title })),
    };
}

/** The progress comment for an open epic, as the merge progress update renders it, with its activity lines. */
export function renderOpenEpicProgressComment(epic: EpicStatusFacts): string | null {
    if (!epic.progress) return null;
    return buildEpicProgressComment(epic.progress, epic.planName || 'Untitled Plan', undefined, renderEpicProgressActivity(epicProgressActivity(epic)));
}

/** The epic progress lease needs set/eval (withEpicProgressLeaseIfFree); null runs unguarded, as in tests. */
export type EpicProgressLeaseRedis = Pick<Redis, 'set' | 'eval'>;

/**
 * Updates the activity lines of the open epic's progress comment, whatever
 * prTitleStatus says; no GitHub write when they are unchanged. The write is
 * serialized with the merge progress update on the epic's progress lease, and
 * the epic and its comment are read again under it (syncOpenEpicProgressComment),
 * so a merge, or a finalized comment, written while this pass read its facts
 * is never overwritten. A lease the merge progress update keeps is left to it:
 * it signals a status sync once it is done. Never throws: the next transition
 * of the epic writes it again.
 */
export async function syncEpicProgressCommentForStatus(
    github: PullRequestStatusGitHub, redis: EpicProgressLeaseRedis | null, target: { repository: string; prNumber: number }, epic: EpicStatusFacts,
): Promise<void> {
    if (!epic.progress || !epic.epicBranch) return;
    const activity = renderEpicProgressActivity(epicProgressActivity(epic));
    const [owner, repo] = target.repository.split('/');
    const write = async (assertOwned: () => Promise<void>) =>
        await syncOpenEpicProgressComment(paginatingGitHub(github), { owner, repo, epicPrNumber: target.prNumber }, { activity, assertOwned });
    try {
        const outcome = redis
            ? await withEpicProgressLeaseIfFree({ owner, repo, epicBranch: epic.epicBranch }, redis, async lease => await write(lease.assertOwned))
            : { acquired: true as const, value: await write(async () => undefined) };
        if (!outcome.acquired) logger.debug(target, 'The epic progress update holds the epic; it signals the status sync that refreshes the comment');
        else if (outcome.value === 'updated') logger.debug(target, 'Updated the epic progress comment');
    } catch (error) {
        logger.warn({ ...target, error: (error as Error).message }, 'Failed to update the epic progress comment; the next epic update writes it');
    }
}

const LOOKUP_DEBOUNCE_MS = 1_000;

export interface EpicSyncRunnerDeps {
    github: () => Promise<PullRequestStatusGitHub>;
    db: Knex;
    schedule: (repository: string, prNumber: number) => void;
    enabled: () => boolean;
}

/** Open epic pull requests of `epicBranch`: those whose head is the branch, in the repository itself. */
async function openEpicPullRequests(github: PullRequestStatusGitHub, repository: string, epicBranch: string): Promise<number[]> {
    const [owner, repo] = repository.split('/');
    const { data } = await github.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, head: `${owner}:${epicBranch}`, state: 'open', per_page: 10 });
    return (Array.isArray(data) ? data : [])
        .filter(pull => pull?.head?.ref === epicBranch && typeof pull.number === 'number')
        .map(pull => pull.number as number);
}

/** The repository and epic branch ProPR recorded for a plan (its `base-<branch>` label), when it has one. */
async function epicBranchOfPlan(db: Knex, draftId: string): Promise<{ repository: string; epicBranch: string } | null> {
    const draft = await db('task_drafts').where({ draft_id: draftId }).first('repository', 'context_config') as
        { repository?: string; context_config?: unknown } | undefined;
    if (!draft?.repository) return null;
    let config: unknown = draft.context_config;
    if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch { return null; }
    }
    const label = config && typeof config === 'object' ? (config as { epicLabel?: unknown }).epicLabel : undefined;
    return typeof label === 'string' && label.startsWith('base-') ? { repository: draft.repository, epicBranch: label.slice('base-'.length) } : null;
}

/**
 * The runner behind requestEpicPullRequestStatusSync: a burst of signals for
 * one epic branch costs one lookup of its open epic pull request, whose
 * update is then scheduled like any other.
 */
export function createEpicSyncRunner(deps: EpicSyncRunnerDeps): PullRequestStatusEpicSyncRunner & { stop: () => void } {
    const lookups = new Map<string, NodeJS.Timeout>();
    const forBranch = (repository: string, epicBranch: string): void => {
        if (!deps.enabled()) return;
        const key = `${repository.toLowerCase()}@${epicBranch}`;
        if (lookups.has(key)) return;
        const timer = setTimeout(() => {
            lookups.delete(key);
            void deps.github()
                .then(github => openEpicPullRequests(github, repository, epicBranch))
                .then(numbers => { for (const number of numbers) deps.schedule(repository, number); })
                .catch(error => logger.warn({ repository, epicBranch, error: (error as Error).message },
                    'Failed to find the epic pull request of a branch; the next transition updates its status'));
        }, LOOKUP_DEBOUNCE_MS);
        timer.unref?.();
        lookups.set(key, timer);
    };
    return {
        forBranch,
        forPlan: (draftId: string) => {
            if (!deps.enabled()) return;
            void epicBranchOfPlan(deps.db, draftId)
                .then(epic => { if (epic) forBranch(epic.repository, epic.epicBranch); })
                .catch(error => logger.debug({ draftId, error: (error as Error).message }, 'Could not read the epic branch of a plan'));
        },
        stop: () => {
            for (const timer of lookups.values()) clearTimeout(timer);
            lookups.clear();
        },
    };
}

/** What the update read and changed, for the epic side of the sync (syncEpicSideOfStatus). */
export interface EpicSyncNotes {
    epic: EpicStatusFacts | null;
    /** The branch the pull request merges into. */
    baseRef: string | null;
    /** The rendered status (block or title slot) changed. */
    statusChanged: boolean;
}

/** How long after an update that left sub-PRs unread the next one reads them (pullRequestStatusEpicChildReads). */
const DEFAULT_EPIC_CHILD_READ_CONTINUE_MS = 5_000;
let epicChildReadContinueMs = DEFAULT_EPIC_CHILD_READ_CONTINUE_MS;

/** Test hook: shortens the wait before unread sub-PRs are read; null restores it. */
export function setEpicChildReadContinueMsForTests(ms: number | null): void {
    epicChildReadContinueMs = ms ?? DEFAULT_EPIC_CHILD_READ_CONTINUE_MS;
}

const TITLE_SLOT_STATE: Array<[RegExp, PullRequestStatus['state']]> = [[/^\u{1F528}/u, 'working'], [/^⚠/u, 'needs_attention'], [/^✅/u, 'ready']];
const BLOCK_COUNT_PATTERN = /^(\*\*ProPR\*\* (?:\u{1F528}|⚠️?|✅) )\d+ of \d+( issues merged)/mu;
const BLOCK_STAMP_PATTERN = / · updated \d{2}:\d{2} UTC/;

function utcTime(now: Date): string {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * The update of an epic whose status is undetermined (isUndeterminedPullRequestStatus):
 * unread sub-PRs may be working, so no state is claimed and the published one
 * stays, but the merged count, known without them, is brought up to date: in
 * the published block's headline, and in the title slot with the state it
 * already shows (left alone when the title has no slot). The sub-PRs left
 * unread are read by the continuation the sync adds to every epic update
 * (withEpicChildReadContinuation).
 */
export async function undeterminedEpicUpdate(
    target: { pull: PullRequestStatusPull; status: PullRequestStatus }, now: Date,
    decideTitle: (status: PullRequestStatus) => Promise<PullRequestTitleDecision>,
): Promise<{ body: string; title: PullRequestTitleDecision }> {
    const { pull, status } = target;
    const epic = status.detail.epic;
    const current = pull.body ?? '';
    logger.debug({ baseRef: pull.base?.ref }, 'The epic status is undetermined (sub-PRs unread); only the merged count of the published status is updated');
    let body = current;
    const block = extractPullRequestStatusBlock(current);
    if (epic && block && BLOCK_COUNT_PATTERN.test(block)) {
        const recounted = block.replace(BLOCK_COUNT_PATTERN, `$1${epic.merged} of ${epic.total}$2`);
        const stamped = recounted === block ? block : recounted.replace(BLOCK_STAMP_PATTERN, ` · updated ${utcTime(now)}`);
        const next = applyPullRequestStatusBlock(current, stamped);
        if (next.length <= PR_BODY_MAX_LENGTH) body = next;
    }
    const slot = readStatusSlot(pull.title);
    const state = slot ? TITLE_SLOT_STATE.find(([pattern]) => pattern.test(slot))?.[1] : undefined;
    const title = epic && state
        ? await decideTitle({ state, detail: { ...status.detail, reason: null, epic: { merged: epic.merged, total: epic.total, focus: null } } })
        : { title: null, settleInMs: null };
    return { body, title };
}

/**
 * When an epic update runs again (the title decision's settleInMs): soon,
 * when it left sub-PRs unread (pullRequestStatusEpicChildReads), whatever
 * state it computed. A working sub-PR among those read establishes 🔨 without
 * the rest, and a working title has no settle of its own to bring the rest's
 * statuses to the progress comment. The earlier of the continuation and the
 * title's own settle runs first.
 */
export function withEpicChildReadContinuation(
    settleInMs: number | null, desired: { status: PullRequestStatus | null; epic: EpicStatusFacts | null },
): number | null {
    if (!desired.status || !desired.epic?.continueChildReads) return settleInMs;
    return settleInMs === null ? epicChildReadContinueMs : Math.min(settleInMs, epicChildReadContinueMs);
}

/**
 * After the block: an open epic's progress comment is updated from the same
 * facts, and a sub-PR whose rendered status changed (or that closed) has its
 * epic PR updated, since the epic's state depends on it.
 */
export async function syncEpicSideOfStatus(
    github: PullRequestStatusGitHub, redis: EpicProgressLeaseRedis | null, target: { repository: string; prNumber: number }, notes: EpicSyncNotes,
): Promise<void> {
    if (notes.epic) await syncEpicProgressCommentForStatus(github, redis, target, notes.epic);
    if (notes.statusChanged && notes.baseRef) requestEpicPullRequestStatusSync(target.repository, notes.baseRef);
}

let activeRunner: ReturnType<typeof createEpicSyncRunner> | null = null;

/** Registers the epic signal runner of a process that maintains the status (enablePullRequestStatusSync). */
export function startEpicSyncRunner(deps: EpicSyncRunnerDeps): void {
    activeRunner?.stop();
    activeRunner = createEpicSyncRunner(deps);
    setPullRequestStatusEpicSyncRunner(activeRunner);
}

export function stopEpicSyncRunner(): void {
    setPullRequestStatusEpicSyncRunner(null);
    activeRunner?.stop();
    activeRunner = null;
}
