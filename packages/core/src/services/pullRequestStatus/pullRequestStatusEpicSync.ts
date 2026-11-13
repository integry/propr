import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import {
    buildEpicProgressComment, renderEpicProgressActivity, syncOpenEpicProgressComment, type EpicProgressActivity,
} from '../../webhook/epicMergeProgress.js';
import type { EpicStatusFacts } from './pullRequestStatus.js';
import { describeChildStatus } from './pullRequestStatusBlock.js';
import { paginatingGitHub } from './pullRequestStatusEpicFacts.js';
import type { PullRequestStatusGitHub } from './pullRequestStatusFacts.js';
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
            ...(epic.startedIssues ?? []).map(issue => ({ prNumber: null, issueNumber: issue.issueNumber, title: issue.title })),
        ],
        upNext: (epic.upNext ?? []).map(issue => ({ issueNumber: issue.issueNumber, title: issue.title })),
    };
}

/** The progress comment for an open epic, as the merge progress update renders it, with its activity lines. */
export function renderOpenEpicProgressComment(epic: EpicStatusFacts): string | null {
    if (!epic.progress) return null;
    return buildEpicProgressComment(epic.progress, epic.planName || 'Untitled Plan', undefined, renderEpicProgressActivity(epicProgressActivity(epic)));
}

/**
 * Updates the open epic's progress comment, whatever prTitleStatus says;
 * no GitHub write when the rendered comment is unchanged. Never throws: the
 * next transition of the epic writes it again.
 */
export async function syncEpicProgressCommentForStatus(
    github: PullRequestStatusGitHub, target: { repository: string; prNumber: number }, epic: EpicStatusFacts,
): Promise<void> {
    const body = renderOpenEpicProgressComment(epic);
    if (body === null) return;
    const [owner, repo] = target.repository.split('/');
    try {
        const result = await syncOpenEpicProgressComment(paginatingGitHub(github), { owner, repo, epicPrNumber: target.prNumber }, () => body);
        if (result === 'updated') logger.debug(target, 'Updated the epic progress comment');
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

/**
 * After the block: an open epic's progress comment is updated from the same
 * facts, and a sub-PR whose rendered status changed (or that closed) has its
 * epic PR updated, since the epic's state depends on it.
 */
export async function syncEpicSideOfStatus(
    github: PullRequestStatusGitHub, target: { repository: string; prNumber: number }, notes: EpicSyncNotes,
): Promise<void> {
    if (notes.epic) await syncEpicProgressCommentForStatus(github, target, notes.epic);
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
