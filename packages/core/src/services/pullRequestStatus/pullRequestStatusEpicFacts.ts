import type { Knex } from 'knex';
import { stripStatusSlot } from '@propr/shared';
import type { PlanIssue } from '../../config/planIssueManager.js';
import { EPIC_BRANCH_PATTERN } from '../epicPRService.js';
import { agentBlockedIssueNumber, isAgentBlockedReason } from '../taskPlanning/epicQueueBlockedHead.js';
import {
    computeEpicMergeProgress, listChildPullRequests, listChildrenShippedBeforeOpenEpic, type EpicChildPullRequest,
} from '../../webhook/epicMergeProgress.js';
import type { EpicProgressOctokit } from '../../webhook/epicMergeEvidence.js';
import type { EpicChildStatus, EpicIssueRef, EpicStatusFacts, PullRequestStatus } from './pullRequestStatus.js';
import type { PullRequestStatusGitHub, PullRequestStatusPull } from './pullRequestStatusFacts.js';

/**
 * The facts of an epic pull request: how many of its issues are merged into
 * the epic branch (computeEpicMergeProgress, the one count), its open sub-PRs
 * with their own status, the issues started without a sub-PR, the issues not
 * started yet in queue order, and whether the plan's queue is about to start
 * the next one or is paused.
 */

/** Pages read of one GitHub list; more is an unusual epic. */
const MAX_LIST_PAGES = 10;
const PAGE_SIZE = 100;
/** Open sub-PRs whose status is read for one epic update; the rest are listed without it. */
export const MAX_EPIC_CHILD_STATUSES = 10;

const STARTED = new Set(['processing', 'under_review', 'in_refinement', 'refinement_processing']);
const RUNNING = new Set(['processing', 'refinement_processing']);

export interface EpicStatusSources {
    github: PullRequestStatusGitHub;
    db: Knex;
    /** The status of one sub-PR, by the shared status computation. */
    loadChildStatus: (prNumber: number, pull: PullRequestStatusPull) => Promise<PullRequestStatus>;
}

/** Lists every page of a GitHub list through `request` alone, as the status reads take the caller's credential. */
export function paginatingGitHub(github: PullRequestStatusGitHub): EpicProgressOctokit {
    return {
        request: async (route, parameters) => await github.request(route, parameters),
        paginate: async (route, parameters) => {
            const items: unknown[] = [];
            const perPage = Number(parameters.per_page ?? PAGE_SIZE);
            for (let page = 1; page <= MAX_LIST_PAGES; page++) {
                const { data } = await github.request(route, { ...parameters, page });
                const list: unknown[] = Array.isArray(data) ? data : [];
                items.push(...list);
                if (list.length < perPage) break;
            }
            return items;
        },
    };
}

function parseJson(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

interface EpicPlan {
    draftId: string;
    name: string | null;
    paused: boolean;
    issues: PlanIssue[];
    queue: { issues: number[]; cursor: number; status: string; ready: boolean; parallel: boolean; blockedReason: string | null } | null;
}

/** The plan ProPR recorded `epicBranch` for: its draft holds the branch's first issue and the branch's `base-` label. */
async function loadEpicPlan(db: Knex, repository: string, epicBranch: string, firstIssue: number): Promise<EpicPlan | null> {
    const draftIds = db('plan_issues').where({ repository, issue_number: firstIssue }).whereNotNull('draft_id').select('draft_id');
    const drafts: Array<{ draft_id: string; name?: string | null; paused?: unknown; context_config: unknown }> = await db('task_drafts')
        .where({ repository }).whereIn('draft_id', draftIds).select('draft_id', 'name', 'paused', 'context_config');
    const draft = drafts.find(candidate => parseJson(candidate.context_config).epicLabel === `base-${epicBranch}`);
    if (!draft) return null;
    const [issues, queueRow] = await Promise.all([
        db('plan_issues').where({ draft_id: draft.draft_id }).orderBy('created_at', 'asc').orderBy('id', 'asc') as Promise<PlanIssue[]>,
        db('epic_execution_queues').where({ draft_id: draft.draft_id })
            .first('issues', 'cursor', 'status', 'ready', 'parallel', 'blocked_reason') as Promise<Record<string, unknown> | undefined>,
    ]);
    let queue: EpicPlan['queue'] = null;
    if (queueRow) {
        let queued: unknown = [];
        try { queued = JSON.parse(String(queueRow.issues ?? '[]')); } catch { queued = []; }
        queue = {
            issues: Array.isArray(queued) ? queued.filter((issue): issue is number => typeof issue === 'number') : [],
            cursor: Number(queueRow.cursor ?? 0), status: String(queueRow.status ?? ''), ready: Boolean(queueRow.ready),
            parallel: Boolean(queueRow.parallel), blockedReason: typeof queueRow.blocked_reason === 'string' ? queueRow.blocked_reason : null,
        };
    }
    return { draftId: draft.draft_id, name: draft.name ?? null, paused: Boolean(draft.paused), issues, queue };
}

/** Issue titles from the epic body's issue list (`- #123: Title`, written by the epic body builder). */
export function epicIssueTitles(body: string | null | undefined): Map<number, string> {
    const titles = new Map<number, string>();
    for (const match of (body ?? '').matchAll(/^- #(\d+): (.+)$/gm)) titles.set(Number(match[1]), match[2].trim());
    return titles;
}

/** A sub-PR's title without its status slot and its `[issue by model]` prefix. */
function childTitle(title: string | undefined): string | null {
    const text = stripStatusSlot(title ?? '').replace(/^\[[^\]]*\]\s*/, '').trim();
    return text || null;
}

/**
 * The queue is about to start its next issue: it is active and not paused or
 * held on a blocker, and its head has not started (or has merged and the queue
 * is about to advance to an issue still to start).
 */
function nextIssueQueued(plan: EpicPlan, pending: Set<number>): boolean {
    const queue = plan.queue;
    if (!queue || queue.status !== 'active' || plan.paused || isAgentBlockedReason(queue.blockedReason)) return false;
    if (queue.parallel) return queue.issues.some(issue => pending.has(issue));
    const head = queue.issues[queue.cursor];
    if (head === undefined) return false;
    if (pending.has(head)) return true;
    const headStatus = plan.issues.find(issue => issue.issue_number === head)?.status;
    return headStatus === 'merged' && queue.issues.slice(queue.cursor + 1).some(issue => pending.has(issue));
}

/** Plan issues not started, in queue order, then in plan order. */
function upNextIssues(plan: EpicPlan, excluded: Set<number>, titles: Map<number, string>): EpicIssueRef[] {
    const pending = plan.issues.filter(issue => issue.status === 'pending' && !excluded.has(issue.issue_number));
    const order = new Map((plan.queue?.issues ?? []).map((issue, index) => [issue, index]));
    return pending
        .map((issue, index) => ({ issue, rank: order.get(issue.issue_number) ?? order.size + index }))
        .sort((a, b) => a.rank - b.rank)
        .map(({ issue }) => ({ issueNumber: issue.issue_number, title: titles.get(issue.issue_number) ?? null }));
}

async function childStatuses(
    sources: EpicStatusSources, target: { owner: string; repo: string }, open: EpicChildPullRequest[],
    context: { plan: EpicPlan; titles: Map<number, string> },
): Promise<EpicChildStatus[]> {
    const planIssueNumbers = new Set(context.plan.issues.map(issue => issue.issue_number));
    const issueOf = (child: EpicChildPullRequest): number | null => {
        const linked = context.plan.issues.find(issue => issue.pr_number === child.number);
        if (linked) return linked.issue_number;
        const fromBranch = Number(child.headRef?.match(/^(\d+)[/-]/)?.[1]);
        return planIssueNumbers.has(fromBranch) ? fromBranch : null;
    };
    return await Promise.all(open.map(async (child, index) => {
        const issueNumber = issueOf(child);
        const title = (issueNumber !== null ? context.titles.get(issueNumber) : undefined) ?? childTitle(child.title);
        // A pull request from another epic branch into this one is not a sub-PR whose status is read (no epic reads another).
        if (EPIC_BRANCH_PATTERN.test(child.headRef ?? '')) return { prNumber: child.number, issueNumber, title, status: null };
        // Beyond the read budget the status is unknown, which is not the same as no ProPR status (computeEpicStatus).
        if (index >= MAX_EPIC_CHILD_STATUSES) return { prNumber: child.number, issueNumber, title, status: null, statusUnread: true };
        const pull = (await sources.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...target, pull_number: child.number })).data as PullRequestStatusPull;
        return { prNumber: child.number, issueNumber, title, status: await sources.loadChildStatus(child.number, pull) };
    }));
}

/**
 * Reads the facts of the epic pull request `pull`, whose head is the epic
 * branch `epicBranch`; null when ProPR recorded no plan for the branch. A
 * failed read rejects, so the status keeps its previous block.
 */
export async function loadEpicStatusFacts(
    sources: EpicStatusSources, target: { repository: string; prNumber: number; epicBranch: string; firstIssue: number; pull: PullRequestStatusPull },
): Promise<EpicStatusFacts | null> {
    const { repository, prNumber, epicBranch, firstIssue, pull } = target;
    const plan = await loadEpicPlan(sources.db, repository, epicBranch, firstIssue);
    if (!plan) return null;
    const [owner, repo] = repository.split('/');
    const github = paginatingGitHub(sources.github);
    const listed = await listChildPullRequests(github, owner, repo, epicBranch);
    const shipped = await listChildrenShippedBeforeOpenEpic(github, { owner, repo, epicBranch, epicPrNumber: prNumber, baseBranch: pull.base?.ref }, listed);
    const children = listed.filter(child => !shipped.has(child.number));
    const issues = plan.issues.filter(issue => issue.pr_number == null || !shipped.has(issue.pr_number));
    const progress = computeEpicMergeProgress(children, null, issues);

    const titles = epicIssueTitles(pull.body);
    const open = children.filter(child => child.open);
    const openNumbers = new Set(open.map(child => child.number));
    const mergedNumbers = new Set(children.filter(child => child.merged).map(child => child.number));
    // An issue whose run stopped on a reported blocker stays in progress (epicQueueBlockedHead), but nothing runs for it.
    const blockedIssue = plan.queue?.status === 'active' ? agentBlockedIssueNumber(plan.queue.blockedReason) : null;
    const startedIssues: EpicIssueRef[] = issues
        .filter(issue => STARTED.has(issue.status) && !(issue.pr_number != null && (openNumbers.has(issue.pr_number) || mergedNumbers.has(issue.pr_number))))
        .map(issue => {
            const blocked = issue.issue_number === blockedIssue;
            return {
                issueNumber: issue.issue_number, title: titles.get(issue.issue_number) ?? null,
                working: RUNNING.has(issue.status) && !blocked, ...(blocked ? { blocked } : {}),
            };
        });
    const excluded = new Set(plan.issues.filter(issue => !issues.includes(issue)).map(issue => issue.issue_number));
    const pending = new Set(issues.filter(issue => issue.status === 'pending').map(issue => issue.issue_number));
    return {
        merged: progress.merged,
        total: progress.total,
        children: await childStatuses(sources, { owner, repo }, open, { plan, titles }),
        startedIssues,
        upNext: upNextIssues(plan, excluded, titles),
        nextIssueQueued: nextIssueQueued(plan, pending),
        queuePaused: plan.paused && plan.queue?.status === 'active',
        progress,
        planName: plan.name,
        epicBranch,
    };
}
