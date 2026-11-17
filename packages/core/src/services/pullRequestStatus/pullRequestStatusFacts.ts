import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { summarizeCheckSignals } from '../../webhook/checkRunHelpers.js';
import { isNonBlockingCheck } from '../../webhook/nonBlockingChecks.js';
import { EPIC_BRANCH_PATTERN } from '../epicPRService.js';
import { latestReviewRound, loadPullRequestScoreHistory } from '../reviewScoreStore.js';
import { headChecksWaitMs } from './pullRequestStatusCheckWait.js';
import { loadEpicStatusFacts } from './pullRequestStatusEpicFacts.js';
import {
    computePullRequestStatus,
    TERMINAL_TASK_STATES,
    type PullRequestStatus,
    type PullRequestStatusChecks,
    type PullRequestStatusFacts,
    type PullRequestStatusTask,
    type PullRequestStatusUltrafix,
} from './pullRequestStatus.js';

/** The slice of Octokit the status reads use, so MCP can pass the caller's own credential. */
export interface PullRequestStatusGitHub {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: any }>;
}

/** A pull request as GitHub's REST API returns it; only the fields the status reads. */
export interface PullRequestStatusPull {
    state: string;
    merged?: boolean | null;
    mergeable?: boolean | null;
    body?: string | null;
    title?: string | null;
    /** `repo` is null when the fork the pull request came from was deleted. */
    head: { sha: string; ref: string; repo?: { full_name?: string | null } | null };
    /** The branch the pull request merges into; `sha` is its tip as GitHub last compared it. */
    base?: { ref?: string; sha?: string };
    labels?: Array<{ name?: string | null } | null> | null;
}

export interface PullRequestStatusSources {
    github: PullRequestStatusGitHub;
    db: Knex;
    /**
     * Ultrafix loop state lives in Redis; without it no loop is reported. A store
     * that can also write records when a head was first seen without checks
     * (pullRequestStatusCheckWait); a read-only one only reads it.
     */
    redis?: (Pick<Redis, 'get'> & Partial<Pick<Redis, 'set' | 'del'>>) | null;
    /** The clock the wait for a new head's checks runs on; Date.now when absent. */
    now?: () => number;
    loadRatingGoal: () => Promise<number>;
    loadNonBlockingChecks: (owner: string, repo: string) => Promise<string[]>;
    /** BullMQ jobs for the pull request that have not started yet. */
    countQueuedJobs?: (repository: string, prNumber: number) => Promise<number>;
}

const PULL_REQUEST_TASK_TYPES = ['pr-comment', 'review', 'merge_conflict'];
/** Task types that open a pull request; their `pr_number` is the pull request they produced. */
const PULL_REQUEST_CREATING_TASK_TYPES = ['issue', 'implementation'];
/** Newest task records read for the latest outcome; active tasks are read regardless. */
const TASK_LIMIT = 20;

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

function taskMode(type: string, jobData: Record<string, unknown>): PullRequestStatusTask['mode'] {
    if (type !== 'pr-comment') return null;
    const comments = Array.isArray(jobData.comments) ? jobData.comments as Array<{ commandMode?: unknown }> : [];
    const review = jobData.commandMode === 'review' || comments.some(comment => comment?.commandMode === 'review');
    return review ? 'review' : 'follow_up';
}

type TaskRow = { task_id: string; task_type: string | null; created_at: string | Date; initial_job_data: unknown; state: string | null };

function createdTime(row: TaskRow): number {
    const time = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
    return Number.isFinite(time) ? time : 0;
}

/**
 * The pull request's tasks, newest first: the TASK_LIMIT newest records, which
 * carry the latest outcome, plus every task still active however many newer
 * records there are. A history limit alone could hide a running task behind
 * newer terminal ones (for example newer queued runs that were cancelled), and
 * the status would then read ready while ProPR is still working.
 */
export async function loadPullRequestStatusTasks(db: Knex, repository: string, prNumber: number): Promise<PullRequestStatusTask[]> {
    const latestState = db('task_history').select('state')
        .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
    const pullRequestTasks = () => db('tasks')
        .where('tasks.repository', repository)
        .andWhere(query => query.where('tasks.pr_number', prNumber)
            .orWhere(nested => nested.whereIn('tasks.task_type', PULL_REQUEST_TASK_TYPES).andWhere('tasks.issue_number', prNumber)))
        .select('tasks.task_id', 'tasks.task_type', 'tasks.created_at', 'tasks.initial_job_data', latestState.clone().as('state'));
    const [recent, active]: [TaskRow[], TaskRow[]] = await Promise.all([
        pullRequestTasks().orderBy('tasks.created_at', 'desc').orderBy('tasks.task_id', 'desc').limit(TASK_LIMIT),
        // A task without history counts as pending, as isActiveTaskState reads it.
        db.from(pullRequestTasks().as('pr_tasks'))
            .where(query => query.whereNull('pr_tasks.state').orWhereNotIn('pr_tasks.state', TERMINAL_TASK_STATES))
            .select('*'),
    ]);
    const rows = new Map<string, TaskRow>();
    for (const row of [...recent, ...active]) rows.set(row.task_id, row);
    return [...rows.values()]
        .sort((a, b) => createdTime(b) - createdTime(a) || (String(b.task_id) < String(a.task_id) ? -1 : String(b.task_id) > String(a.task_id) ? 1 : 0))
        .map(row => {
            const type = row.task_type ?? 'issue';
            return { type, mode: taskMode(type, parseJson(row.initial_job_data)), state: row.state ?? 'pending', createdAt: String(row.created_at) };
        });
}

/**
 * The epic branch name the pull request comes from, when its head is a branch
 * of `repository` itself. ProPR creates epic branches only there, so the same
 * name on a fork's branch is someone else's branch, never ProPR's epic.
 */
function epicHeadRef(repository: string, head: PullRequestStatusPull['head']): string | null {
    const headRepository = head.repo?.full_name;
    if (typeof headRepository !== 'string' || headRepository.toLowerCase() !== repository.toLowerCase()) return null;
    return EPIC_BRANCH_PATTERN.test(head.ref) ? head.ref : null;
}

/**
 * Whether ProPR recorded `headRef` as the epic branch of one of its plans. The
 * branch name alone proves nothing (anyone can name a branch like an epic):
 * ProPR stores the epic's `base-<branch>` label on the plan draft it created
 * the branch for, and that draft holds the issue the branch name starts with.
 * `headRef` must already be a branch of `repository` (epicHeadRef).
 */
async function isRecordedEpicBranch(db: Knex, repository: string, headRef: string | null): Promise<boolean> {
    const match = headRef?.match(EPIC_BRANCH_PATTERN);
    if (!headRef || !match) return false;
    const draftIds = db('plan_issues').where({ repository, issue_number: Number(match[1]) }).whereNotNull('draft_id').select('draft_id');
    const drafts: Array<{ context_config: unknown }> = await db('task_drafts')
        .where({ repository }).whereIn('draft_id', draftIds).select('context_config');
    return drafts.some(draft => parseJson(draft.context_config).epicLabel === `base-${headRef}`);
}

/**
 * Whether ProPR created the pull request. Only creation records count: an
 * implementation task that produced it, a plan issue, a goal, or an epic
 * branch ProPR recorded for one of its plans. Review, follow-up and conflict
 * tasks prove ProPR worked on a pull request, which it also does on pull
 * requests people opened.
 */
async function isProprPullRequest(
    db: Knex, pullRequest: { repository: string; prNumber: number; epicHeadRef: string | null },
): Promise<boolean> {
    const { repository, prNumber, epicHeadRef: headRef } = pullRequest;
    const [implementation, planIssue, goal, epic] = await Promise.all([
        db('tasks').where({ repository, pr_number: prNumber })
            .andWhere(query => query.whereNull('task_type').orWhereIn('task_type', PULL_REQUEST_CREATING_TASK_TYPES))
            .first('task_id'),
        db('plan_issues').where({ repository, pr_number: prNumber }).first('id'),
        db('goals').where({ repository, final_pr_number: prNumber }).first('goal_id'),
        isRecordedEpicBranch(db, repository, headRef),
    ]);
    return Boolean(implementation || planIssue || goal || epic);
}

/**
 * Whether ProPR created a pull request GitHub listed (isProprPullRequest), so
 * enumerations over a repository's open pull requests apply the same ownership
 * rule as the status itself.
 */
export async function isProprCreatedPullRequest(
    db: Knex, repository: string, pull: { number: number; head: PullRequestStatusPull['head'] },
): Promise<boolean> {
    return await isProprPullRequest(db, { repository, prNumber: pull.number, epicHeadRef: epicHeadRef(repository, pull.head) });
}

/** Ultrafix keeps its loop state, and any CI wait, under these Redis keys. */
export function ultrafixStatusKeys(owner: string, repo: string, prNumber: number): { state: string; ciWait: string } {
    return { state: `ultrafix:state:${owner}:${repo}:${prNumber}`, ciWait: `ultrafix:ci-wait:${owner}:${repo}:${prNumber}` };
}

async function loadUltrafix(redis: Pick<Redis, 'get'> | null | undefined, owner: string, repo: string, prNumber: number): Promise<PullRequestStatusUltrafix | null> {
    if (!redis) return null;
    const keys = ultrafixStatusKeys(owner, repo, prNumber);
    const [rawState, rawWait] = await Promise.all([redis.get(keys.state), redis.get(keys.ciWait)]);
    const state = parseJson(rawState);
    if (!rawState || typeof state.goal !== 'number') return null;
    const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
    return {
        active: state.active === true,
        cycleCount: number(state.cycleCount, 0),
        maxCycles: number(state.maxCycles, 0),
        goal: state.goal,
        completionStatus: state.completionStatus === 'succeeded' || state.completionStatus === 'failed' ? state.completionStatus : null,
        completionReason: text(state.completionReason),
        finalScore: typeof state.finalScore === 'number' ? state.finalScore : null,
        finalCycle: typeof state.finalCycle === 'number' && Number.isFinite(state.finalCycle) ? state.finalCycle : null,
        completedAt: text(state.completedAt),
        waitingForCi: state.active === true && Boolean(rawWait),
    };
}

const CHECK_PAGE = 100;
/** Pages of check runs, and of legacy contexts, read for one head; more is an unusual commit. */
const MAX_CHECK_PAGES = 3;

/**
 * Reads pages of one GitHub list until `total` items are listed or the page
 * budget is spent. `complete` is false when items were left unread: an unread
 * check may be failed or pending, so the read ones cannot establish a pass.
 */
async function readCheckPages<T>(read: (page: number) => Promise<{ items: T[]; total: number }>): Promise<{ items: T[]; complete: boolean; total: number }> {
    const items: T[] = [];
    let listed = 0;
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
        const { items: pageItems, total } = await read(page);
        items.push(...pageItems);
        listed = Math.max(listed, total);
        if (items.length >= total) return { items, complete: true, total: listed };
        // A short page with items still unlisted is GitHub's count disagreeing with its list; nothing further is readable.
        if (pageItems.length < CHECK_PAGE) return { items, complete: false, total: listed };
    }
    return { items, complete: false, total: listed };
}

interface CheckRun {
    id?: number;
    name?: string;
    status: string;
    conclusion: string | null;
    started_at?: string | null;
    /** The suite the run belongs to: for GitHub Actions, one workflow run (all its attempts). */
    check_suite?: { id?: number } | null;
}
interface CheckRunPage { total_count?: number; check_runs?: CheckRun[] }

/** The head's check runs, at most MAX_CHECK_PAGES pages (readCheckPages). */
async function loadCheckRuns(
    github: PullRequestStatusGitHub, owner: string, repo: string, ref: string,
): Promise<{ runs: CheckRun[]; complete: boolean; total: number }> {
    const { items, complete, total: listed } = await readCheckPages<CheckRun>(async page => {
        const { data } = await github.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { owner, repo, ref, per_page: CHECK_PAGE, page }) as { data: CheckRunPage };
        const runs = data.check_runs ?? [];
        return { items: runs, total: data.total_count ?? runs.length };
    });
    return { runs: items, complete, total: Math.max(listed, items.length) };
}

interface LegacyStatusContext { context?: string; state?: string }
interface LegacyStatusPage { state?: string; total_count?: number; statuses?: LegacyStatusContext[] }
/** The head's legacy commit statuses: the combined state and the contexts listed within the page budget. */
interface LegacyStatuses { state: string; statuses: LegacyStatusContext[]; complete: boolean; total: number }
/** Blocking legacy contexts classified one by one; `count` and `nonBlocking` cover the listed contexts only. */
interface LegacyChecks { count: number; nonBlocking: number; passed: number; failed: string[]; pending: string[] }

const FAILED_LEGACY_STATES = new Set(['failure', 'error']);
const LEGACY_PLACEHOLDER = 'commit status';

/**
 * The head's legacy commit statuses, at most MAX_CHECK_PAGES pages
 * (readCheckPages). The combined state comes with every page; the first is kept.
 */
async function loadLegacyStatuses(github: PullRequestStatusGitHub, owner: string, repo: string, ref: string): Promise<LegacyStatuses> {
    let state = 'pending';
    const { items, complete, total } = await readCheckPages<LegacyStatusContext>(async page => {
        const { data } = await github.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref, per_page: CHECK_PAGE, page }) as { data: LegacyStatusPage };
        if (page === 1 && typeof data.state === 'string') state = data.state;
        const statuses = Array.isArray(data.statuses) ? data.statuses : [];
        return { items: statuses, total: data.total_count ?? statuses.length };
    });
    return { state, statuses: items, complete, total: Math.max(total, items.length) };
}

/**
 * Legacy commit statuses on the head, each blocking context classified on its
 * own: a mixed head (one context failed, another pending) is one failed and
 * one pending, never a failed and a passed. Only listed contexts count, and
 * only a listed success is a pass: a context left unlisted may be failed or
 * pending. The combined state covers the unlisted contexts too, so a failure
 * or a wait it reports that no listed context accounts for is one of them.
 */
function classifyLegacyStatuses(read: LegacyStatuses | null, patterns: readonly string[]): LegacyChecks {
    if (read === null) return { count: 0, nonBlocking: 0, passed: 0, failed: [], pending: [] };
    const { statuses } = read;
    const blocking = statuses.filter(status => !isNonBlockingCheck(status.context, patterns));
    const names = (keep: (state: string) => boolean): string[] =>
        blocking.filter(status => keep(status.state ?? '')).map(status => status.context || LEGACY_PLACEHOLDER);
    const failed = names(state => FAILED_LEGACY_STATES.has(state));
    const pending = names(state => state === 'pending');
    if (!read.complete) {
        const listed = (keep: (state: string) => boolean) => statuses.some(status => keep(status.state ?? ''));
        if (FAILED_LEGACY_STATES.has(read.state) && !listed(state => FAILED_LEGACY_STATES.has(state))) failed.push(LEGACY_PLACEHOLDER);
        if (read.state === 'pending' && !listed(state => state === 'pending')) pending.push(LEGACY_PLACEHOLDER);
    }
    return {
        count: statuses.length,
        nonBlocking: statuses.length - blocking.length,
        passed: blocking.filter(status => status.state === 'success').length,
        failed,
        pending,
    };
}

/** A check name GitHub never expanded, such as `Validate ${{ matrix.platform }}`: a job cancelled before its matrix was read. */
export function isUnexpandedCheckName(name: string | null | undefined): boolean {
    return typeof name === 'string' && name.includes('${{');
}

/**
 * Pages of a head's workflow runs read to resolve suites. GitHub lists at most
 * 1,000 workflow runs for a `head_sha` query, so ten pages are all it returns.
 */
const MAX_WORKFLOW_PAGES = 10;

/**
 * The GitHub Actions workflow runs of a head, as check suite id to workflow
 * id. Pages are read until every suite in `wanted` is resolved or the listing
 * is exhausted: GitHub lists the newest runs first, so the older suite of a
 * superseded run may only appear on a later page. A suite still unresolved
 * then is not a workflow run GitHub lists for the head.
 */
async function loadSuiteWorkflows(
    github: PullRequestStatusGitHub, { owner, repo, headSha }: { owner: string; repo: string; headSha: string }, wanted: ReadonlySet<number>,
): Promise<Map<number, number>> {
    const workflows = new Map<number, number>();
    let listed = 0;
    for (let page = 1; page <= MAX_WORKFLOW_PAGES; page++) {
        const { data } = await github.request('GET /repos/{owner}/{repo}/actions/runs', { owner, repo, head_sha: headSha, per_page: CHECK_PAGE, page }) as {
            data: { total_count?: unknown; workflow_runs?: Array<{ check_suite_id?: unknown; workflow_id?: unknown }> };
        };
        const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
        for (const run of runs) {
            if (typeof run.check_suite_id === 'number' && typeof run.workflow_id === 'number') workflows.set(run.check_suite_id, run.workflow_id);
        }
        listed += runs.length;
        if ([...wanted].every(suite => workflows.has(suite))) break;
        const total = typeof data.total_count === 'number' ? data.total_count : listed;
        if (listed >= total || runs.length < CHECK_PAGE) break;
    }
    return workflows;
}

const suiteOf = (run: CheckRun): number | null => typeof run.check_suite?.id === 'number' ? run.check_suite.id : null;

/**
 * Whether `later` ran after `earlier`. Check run ids only grow, so they order
 * two runs; start times are the fallback. Neither readable is no ordering.
 */
function startedAfter(later: CheckRun, earlier: CheckRun): boolean {
    if (typeof later.id === 'number' && typeof earlier.id === 'number') return later.id > earlier.id;
    const laterStart = Date.parse(later.started_at ?? '');
    const earlierStart = Date.parse(earlier.started_at ?? '');
    return Number.isFinite(laterStart) && Number.isFinite(earlierStart) && laterStart > earlierStart;
}

/**
 * Separates cancelled check runs from the rest. A cancelled run is no
 * verdict on the head: it is not failed, and not passed. One a newer run of
 * the same logical check replaced is left out: the same name, started after
 * it, in the same check suite (a re-run job) or in a suite of the same GitHub
 * Actions workflow (a newer workflow run superseding it). A run whose name was
 * never expanded (its workflow run was cancelled before its matrix was read)
 * shares no name with the expanded jobs of its successor, so any newer run in
 * another suite of the same workflow replaces it; without such a successor it
 * stays cancelled like any other, and the renderer counts its raw name
 * without listing it. The name alone proves nothing: two workflows may each
 * have a `test` job, and one passing says nothing about the other being
 * cancelled. Any other blocking
 * cancelled run is reported as cancelled; nothing runs it again, so it still
 * keeps the PR from being ready. The workflow of a suite is read only when
 * a replacement in another suite is possible, page by page until those
 * suites are resolved (loadSuiteWorkflows); a failed read establishes none.
 */
async function cancelledCheckRuns(
    runs: readonly CheckRun[], patterns: readonly string[], workflowsOf: (suites: ReadonlySet<number>) => Promise<Map<number, number>>,
): Promise<{ checkRuns: CheckRun[]; cancelledNames: string[] }> {
    const isCancelled = (run: CheckRun) => run.status === 'completed' && run.conclusion === 'cancelled';
    const kept = runs.filter(run => !isCancelled(run));
    const reported = runs.filter(run => isCancelled(run) && !isNonBlockingCheck(run.name, patterns));
    // An unexpanded run's successor names its jobs after the expanded matrix: any newer run of another suite may be it (the workflow decides).
    const sameCheck = (other: CheckRun, cancelled: CheckRun) => (other.name ?? '') === (cancelled.name ?? '')
        || (isUnexpandedCheckName(cancelled.name) && suiteOf(other) !== suiteOf(cancelled));
    const candidates = (cancelled: CheckRun) => kept.filter(other =>
        sameCheck(other, cancelled) && suiteOf(other) !== null && suiteOf(cancelled) !== null && startedAfter(other, cancelled));
    let workflows: Map<number, number> | null = null;
    // The suites whose workflow decides a replacement: each cancelled run's and its newer same-name runs' in other suites.
    const wanted = new Set<number>();
    for (const cancelled of reported) {
        const cancelledSuite = suiteOf(cancelled);
        for (const other of candidates(cancelled)) {
            const otherSuite = suiteOf(other);
            if (cancelledSuite === null || otherSuite === null || otherSuite === cancelledSuite) continue;
            wanted.add(cancelledSuite);
            wanted.add(otherSuite);
        }
    }
    if (wanted.size > 0) {
        try {
            workflows = await workflowsOf(wanted);
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Could not read the workflow runs of a head; a cancelled check counts as unreplaced');
        }
    }
    const sameWorkflow = (a: number | null, b: number | null): boolean => {
        if (a === null || b === null) return false;
        if (a === b) return true;
        const workflowA = workflows?.get(a);
        return workflowA !== undefined && workflowA === workflows?.get(b);
    };
    const cancelledNames = reported
        .filter(cancelled => !candidates(cancelled).some(other => sameWorkflow(suiteOf(other), suiteOf(cancelled))))
        .map(run => run.name || 'check run');
    return { checkRuns: kept, cancelledNames };
}

/**
 * Blocking checks on the head; nonBlockingChecks neither fail nor hold the
 * status. A GitHub read that rejects leaves the checks incomplete and sets
 * `readFailed`, unlike checks left unread by the page budget: the former is a
 * transient gap a caller may retry, the latter a limit it must not retry.
 */
export async function loadPullRequestStatusChecks(
    sources: Pick<PullRequestStatusSources, 'github' | 'loadNonBlockingChecks'>, owner: string, repo: string, ref: string,
): Promise<PullRequestStatusChecks> {
    const [runs, statuses, patterns] = await Promise.allSettled([
        loadCheckRuns(sources.github, owner, repo, ref),
        loadLegacyStatuses(sources.github, owner, repo, ref),
        sources.loadNonBlockingChecks(owner, repo),
    ]);
    const listedRuns = runs.status === 'fulfilled' ? runs.value.runs : [];
    const patternList = patterns.status === 'fulfilled' ? patterns.value : [];
    const legacy = classifyLegacyStatuses(statuses.status === 'fulfilled' ? statuses.value : null, patternList);
    // Cancelled runs are no verdict (cancelledCheckRuns); the shared summary reads the rest.
    const { checkRuns, cancelledNames } = await cancelledCheckRuns(listedRuns, patternList, suites => loadSuiteWorkflows(sources.github, { owner, repo, headSha: ref }, suites));
    // Legacy contexts are classified above; the shared summary reads the check runs.
    const summary = summarizeCheckSignals(checkRuns, { state: 'success', totalCount: 0, statuses: [] }, patternList);
    const runFailed = summary.blockingFailed ?? [];
    const runPending = summary.blockingPending?.length ?? 0;
    const skipped = checkRuns.filter(run => run.status === 'completed' && run.conclusion === 'skipped' && !isNonBlockingCheck(run.name, patternList)).length;
    const failedNames = [...runFailed, ...legacy.failed];
    const complete = runs.status === 'fulfilled' && runs.value.complete && statuses.status === 'fulfilled' && statuses.value.complete;
    return {
        complete,
        reported: (runs.status === 'fulfilled' && runs.value.total > 0) || (statuses.status === 'fulfilled' && statuses.value.total > 0),
        readFailed: runs.status === 'rejected' || statuses.status === 'rejected',
        passed: Math.max(0, summary.count - (summary.nonBlockingCount ?? 0) - runFailed.length - runPending - skipped) + legacy.passed,
        failed: failedNames.length,
        pending: runPending + legacy.pending.length,
        failedNames,
        ...(skipped > 0 ? { skipped } : {}),
        ...(cancelledNames.length > 0 ? { cancelled: cancelledNames.length, cancelledNames } : {}),
    };
}

/** BullMQ jobs for the pull request that have not started yet (running ones are tasks already). */
export async function countQueuedPullRequestJobs(
    queue: { getJobs: (types: Array<'waiting' | 'delayed' | 'prioritized'>) => Promise<Array<{ data?: unknown } | undefined>> },
    repository: string, prNumber: number,
): Promise<number> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.filter(job => {
        const data = (job?.data ?? {}) as Record<string, unknown>;
        const jobRepository = typeof data.repository === 'string' ? data.repository : `${String(data.repoOwner)}/${String(data.repoName)}`;
        const jobPr = typeof data.pullRequestNumber === 'number' ? data.pullRequestNumber : data.prNumber;
        return jobRepository.toLowerCase() === repository.toLowerCase() && jobPr === prNumber;
    }).length;
}

/** The newest review round's verdict (latestReviewRound): its lowest score and its blockers, never just the last posted review. */
async function latestReviewScore(db: Knex, repository: string, prNumber: number): Promise<{ score: number; blockers: number; headSha: string | null } | null> {
    const round = latestReviewRound(await loadPullRequestScoreHistory(db, repository, prNumber));
    return round ? { score: round.score, blockers: round.blockerCount, headSha: round.headSha || null } : null;
}

/** An epic pull request's facts (loadEpicStatusFacts); its sub-PRs' status by this same computation. */
async function loadEpicFacts(
    repository: string, prNumber: number, sources: PullRequestStatusSources, epic: { epicRef: string | null; pull: PullRequestStatusPull },
): Promise<PullRequestStatusFacts['epic']> {
    const match = epic.epicRef?.match(EPIC_BRANCH_PATTERN);
    if (!epic.epicRef || !match) return null;
    return await loadEpicStatusFacts({
        github: sources.github, db: sources.db, redis: sources.redis,
        // A sub-PR comes from an issue branch, never an epic branch, so this reads no further epic.
        loadChildStatus: async (child, pull) => await loadPullRequestStatus(repository, child, sources, pull),
    }, { repository, prNumber, epicBranch: epic.epicRef, firstIssue: Number(match[1]), pull: epic.pull });
}

/** Reads every fact the status computation needs, from ProPR's records and GitHub. */
export async function loadPullRequestStatusFacts(
    repository: string, prNumber: number, sources: PullRequestStatusSources, pull?: PullRequestStatusPull,
): Promise<PullRequestStatusFacts> {
    const [owner, repo] = repository.split('/');
    const pr = pull ?? (await sources.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber })).data as PullRequestStatusPull;
    const pullRequest = { state: pr.state, merged: pr.merged === true, headSha: pr.head.sha, mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null };
    const tasks = await loadPullRequestStatusTasks(sources.db, repository, prNumber);
    // A fork's branch never counts as an epic branch, for ownership or progress.
    const epicRef = epicHeadRef(repository, pr.head);
    const isPropr = await isProprPullRequest(sources.db, { repository, prNumber, epicHeadRef: epicRef });
    const closed = pullRequest.state !== 'open' || pullRequest.merged;
    const empty: PullRequestStatusChecks = { complete: true, passed: 0, failed: 0, pending: 0, failedNames: [] };
    if (closed || !isPropr) {
        return { pullRequest, isProprPullRequest: isPropr, tasks, queuedJobs: 0, ultrafix: null, checks: empty, latestReviewScore: null, ratingGoal: 0, epic: null };
    }
    // Queued work, the Ultrafix loop, the review score and an epic's sub-PRs each
    // decide whether the PR is ready, so a failed read is not the same as "none":
    // it rejects, and callers keep the previous block (body) or report null (MCP).
    const [queuedJobs, ultrafix, checks, score, ratingGoal, epic] = await Promise.all([
        sources.countQueuedJobs ? sources.countQueuedJobs(repository, prNumber) : 0,
        loadUltrafix(sources.redis, owner, repo, prNumber),
        loadPullRequestStatusChecks(sources, owner, repo, pullRequest.headSha),
        latestReviewScore(sources.db, repository, prNumber),
        sources.loadRatingGoal(),
        loadEpicFacts(repository, prNumber, sources, { epicRef, pull: pr }),
    ]);
    // A head GitHub lists no check for yet may only be one whose checks have not started (pullRequestStatusCheckWait).
    // A listed check is evidence even from an incomplete read (page budget, one endpoint rejected); only a complete read shows none.
    const reported = checks.reported === true ? true : checks.complete ? false : null;
    const checksAwaitedForMs = await headChecksWaitMs(sources.redis, {
        repository, prNumber, headSha: pullRequest.headSha, reported,
    }, sources.now ? sources.now() : Date.now());
    return {
        pullRequest, isProprPullRequest: isPropr, tasks, queuedJobs, ultrafix, checks, checksAwaitedForMs,
        latestReviewScore: score?.score ?? null, latestReviewBlockers: score?.blockers ?? null,
        latestReviewHeadSha: score?.headSha ?? null, ratingGoal, epic,
    };
}

/** The status of a pull request: its facts read, then computed by the one status computation. */
export async function loadPullRequestStatus(
    repository: string, prNumber: number, sources: PullRequestStatusSources, pull?: PullRequestStatusPull,
): Promise<PullRequestStatus> {
    return computePullRequestStatus(await loadPullRequestStatusFacts(repository, prNumber, sources, pull));
}

/** The circuit-breaker label of an Ultrafix loop. */
export const ULTRAFIX_LABEL = 'ultrafix';

/**
 * Removes an `ultrafix` label left on a merged or closed pull request: no loop
 * runs on it any more, so the label only misreports one. Best-effort: a failed
 * removal is logged and retried by the next status update of the pull request.
 * Returns whether a label was removed.
 */
export async function removeLeftoverUltrafixLabel(
    github: PullRequestStatusGitHub, repository: string, prNumber: number, pull: PullRequestStatusPull,
): Promise<boolean> {
    if (pull.state === 'open' && !pull.merged) return false;
    if (!(pull.labels ?? []).some(label => label?.name === ULTRAFIX_LABEL)) return false;
    const [owner, repo] = repository.split('/');
    try {
        await github.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
            owner, repo, issue_number: prNumber, name: ULTRAFIX_LABEL,
        });
        logger.info({ repository, prNumber }, 'Removed the leftover ultrafix label from a closed pull request');
        return true;
    } catch (error) {
        // Already gone: someone removed it meanwhile.
        if ((error as { status?: number }).status === 404) return false;
        logger.warn({ repository, prNumber, error: (error as Error).message }, 'Could not remove the leftover ultrafix label from a closed pull request');
        return false;
    }
}
