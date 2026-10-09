/**
 * Task assignment, mapped directly onto GitHub issue and pull request assignment.
 *
 * GitHub is the source of truth: a task is assigned through the issue or pull
 * request it works on, and `task_assignees` is only a local projection of that
 * GitHub state so task lists can render and filter assignees without one
 * GitHub call per row. GitHub treats pull requests as issues for assignment,
 * so `/issues/{n}/assignees` covers both.
 *
 * Reads fail soft (partial data and a logged warning) because assignment
 * display must never break a task list. Writes fail loud with a
 * `TaskAssignmentError`, so the HTTP layer can report what went wrong.
 */

import type { AttributedUser } from '@propr/shared';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { rememberGitHubUserProfiles, resolveGitHubUserProfileByLogin } from './githubUserProfileService.js';

const TABLE = 'task_assignees';
const PROFILES_TABLE = 'github_user_profiles';

// Task types that act on a pull request whose number lives in `issue_number`.
// Mirrors `isPullRequestTask` in packages/api/routes/pullRequestTaskIdentity.ts.
const PULL_REQUEST_TASK_TYPES = new Set(['pr-comment', 'review', 'merge_conflict']);

/** The GitHub issue or pull request a task is assigned through. */
export interface TaskSubject {
    owner: string;
    repo: string;
    number: number;
    kind: 'issue' | 'pull_request';
}

/** The `tasks` columns subject resolution reads. */
export interface TaskSubjectSource {
    task_id?: unknown;
    repository?: unknown;
    issue_number?: unknown;
    pr_number?: unknown;
    task_type?: unknown;
}

export interface TaskAssigneeRow {
    task_id: string;
    github_user_id: string;
    synced_at: string;
    created_at: string;
}

/** The narrow slice of Octokit this service calls; injectable for tests. */
export interface TaskAssignmentClient {
    request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface TaskAssignmentOptions {
    /** Defaults to the installation's authenticated Octokit. */
    github?: TaskAssignmentClient;
    now?: () => Date;
}

/**
 * `add` assigns the requested users and keeps everyone already assigned on
 * GitHub. `replace` makes the requested users the whole set, unassigning only
 * those not requested.
 */
export type TaskAssignmentMode = 'add' | 'replace';

export interface SetTaskAssigneesOptions extends TaskAssignmentOptions {
    mode: TaskAssignmentMode;
    /**
     * Assigns this issue or pull request instead of the one resolved from the
     * task row, for a caller that knows it before the task records it (an
     * implementation's new pull request, during post-processing).
     */
    subject?: TaskSubject;
}

export interface TaskAssigneeSyncResult {
    subject: TaskSubject | null;
    assignees: AttributedUser[];
    /** False when GitHub could not be read and `assignees` is the stored set. */
    synced: boolean;
}

export interface SetTaskAssigneesResult {
    subject: TaskSubject;
    /** The assignees GitHub confirmed, as persisted. */
    assignees: AttributedUser[];
    /** Requested users GitHub did not assign (for example, users without repository access). */
    rejected: AttributedUser[];
}

export type TaskAssignmentErrorCode =
    | 'TASK_NOT_FOUND'
    | 'NO_GITHUB_SUBJECT'
    | 'UNKNOWN_LOGIN'
    | 'GITHUB_WRITE_FAILED';

export class TaskAssignmentError extends Error {
    readonly code: TaskAssignmentErrorCode;
    /** For `UNKNOWN_LOGIN`, the logins that were empty or could not be resolved. */
    readonly logins: string[];
    /** For `GITHUB_WRITE_FAILED`, the HTTP status GitHub answered with, when known. */
    readonly status?: number;

    constructor(code: TaskAssignmentErrorCode, message: string, details: { logins?: string[]; status?: number; cause?: unknown } = {}) {
        super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
        this.name = 'TaskAssignmentError';
        this.code = code;
        this.logins = details.logins ?? [];
        this.status = details.status;
    }
}

interface GitHubAssignee {
    id: string;
    login: string;
    avatar_url?: string | null;
}

function positiveInteger(value: unknown): number | null {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeUserId(value: unknown): string | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value.trim())) return value.trim();
    return null;
}

function isPullRequestTask(task: TaskSubjectSource): boolean {
    const taskId = String(task.task_id ?? '');
    return PULL_REQUEST_TASK_TYPES.has(String(task.task_type))
        || taskId.startsWith('pr-comment-')
        || taskId.startsWith('pr-comments-');
}

/**
 * Resolves the GitHub issue or pull request a task is assigned through: the
 * task's pull request when it has one (PR tasks record theirs as the issue
 * number), otherwise its issue. Returns null when the task has neither or its
 * repository is not an `owner/repo` pair.
 */
export function resolveTaskSubject(task: TaskSubjectSource | null | undefined): TaskSubject | null {
    if (!task) return null;
    const [owner, repo, ...rest] = typeof task.repository === 'string' ? task.repository.trim().split('/') : [];
    if (!owner || !repo || rest.length > 0) return null;
    const prNumber = positiveInteger(task.pr_number);
    if (prNumber) return { owner, repo, number: prNumber, kind: 'pull_request' };
    const issueNumber = positiveInteger(task.issue_number);
    if (!issueNumber) return null;
    return { owner, repo, number: issueNumber, kind: isPullRequestTask(task) ? 'pull_request' : 'issue' };
}

async function defaultClient(): Promise<TaskAssignmentClient> {
    return await getAuthenticatedOctokit() as unknown as TaskAssignmentClient;
}

async function readTask(taskId: string): Promise<TaskSubjectSource | undefined> {
    return await db('tasks').select('task_id', 'repository', 'issue_number', 'pr_number', 'task_type').where({ task_id: taskId }).first();
}

function parseAssignees(issue: unknown): GitHubAssignee[] {
    const raw = (issue as { assignees?: unknown } | null)?.assignees;
    if (!Array.isArray(raw)) throw new Error('GitHub response did not include an assignee list');
    const byId = new Map<string, GitHubAssignee>();
    for (const entry of raw) {
        const record = entry as Record<string, unknown> | null;
        const id = normalizeUserId(record?.id);
        const login = typeof record?.login === 'string' ? record.login : '';
        if (id && login) byId.set(id, { id, login, avatar_url: typeof record?.avatar_url === 'string' ? record.avatar_url : null });
    }
    return [...byId.values()];
}

function subjectParameters(subject: TaskSubject): Record<string, unknown> {
    return { owner: subject.owner, repo: subject.repo, issue_number: subject.number };
}

async function fetchAssignees(github: TaskAssignmentClient, subject: TaskSubject): Promise<GitHubAssignee[]> {
    const response = await withRetry(
        () => github.request('GET /repos/{owner}/{repo}/issues/{issue_number}', subjectParameters(subject)),
        retryConfigs.githubApi,
        'read GitHub issue assignees',
    );
    return parseAssignees(response.data);
}

function sortUsers(users: AttributedUser[]): AttributedUser[] {
    return users.sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

// Profiles in `github_user_profiles` are joined in; an assignee whose profile
// was never cached (the cache write failed) is still listed, under its id.
function toAttributedUser(row: { github_user_id: string; login: string | null; display_name: string | null; avatar_url: string | null }): AttributedUser {
    return { id: row.github_user_id, login: row.login ?? row.github_user_id, displayName: row.display_name ?? null, avatarUrl: row.avatar_url ?? null };
}

async function readStoredAssignees(taskId: string): Promise<AttributedUser[]> {
    return (await loadTaskAssignees([taskId])).get(taskId) ?? [];
}

// Replaces the stored set in one transaction, so a concurrent read sees either
// the previous set or the new one. `created_at` is kept for assignees that stay.
async function replaceStoredAssignees(taskId: string, assignees: GitHubAssignee[], now: Date): Promise<void> {
    const timestamp = now.toISOString();
    const ids = assignees.map(assignee => assignee.id);
    await db.transaction(async trx => {
        const removed = trx<TaskAssigneeRow>(TABLE).where({ task_id: taskId });
        if (ids.length > 0) removed.whereNotIn('github_user_id', ids);
        await removed.delete();
        for (const id of ids) {
            await trx<TaskAssigneeRow>(TABLE)
                .insert({ task_id: taskId, github_user_id: id, synced_at: timestamp, created_at: timestamp })
                .onConflict(['task_id', 'github_user_id'])
                .merge({ synced_at: timestamp });
        }
    });
}

async function persistObserved(taskId: string, assignees: GitHubAssignee[], now: Date): Promise<AttributedUser[]> {
    await rememberGitHubUserProfiles(assignees, now);
    await replaceStoredAssignees(taskId, assignees, now);
    return await readStoredAssignees(taskId);
}

/**
 * Reads the task's live assignees from GitHub and replaces the stored set with
 * them, caching the observed profiles. A task that is unknown or has no GitHub
 * subject yields an empty set; a GitHub or database failure leaves the stored
 * set untouched and returns it with `synced: false`.
 */
export async function syncTaskAssignees(taskId: string, options: TaskAssignmentOptions = {}): Promise<TaskAssigneeSyncResult> {
    const now = options.now?.() ?? new Date();
    let subject: TaskSubject | null = null;
    try {
        subject = resolveTaskSubject(await readTask(taskId));
        if (!subject) return { subject: null, assignees: [], synced: false };
        const github = options.github ?? await defaultClient();
        const observed = await fetchAssignees(github, subject);
        return { subject, assignees: await persistObserved(taskId, observed, now), synced: true };
    } catch (error) {
        logger.warn({ error: (error as Error).message, taskId }, 'Failed to sync task assignees from GitHub; serving stored set');
        return { subject, assignees: await readStoredAssignees(taskId), synced: false };
    }
}

/**
 * Replaces the task's stored set with the live assignees of an explicit
 * subject, for a caller that knows the subject before the task row records it
 * (an implementation's new pull request). Unlike `syncTaskAssignees`, a GitHub
 * or database failure throws, so the caller can retry.
 */
export async function refreshTaskAssignees(taskId: string, subject: TaskSubject, options: TaskAssignmentOptions = {}): Promise<AttributedUser[]> {
    const now = options.now?.() ?? new Date();
    const github = options.github ?? await defaultClient();
    return await persistObserved(taskId, await fetchAssignees(github, subject), now);
}

async function readTasksOnSubject(subject: TaskSubject): Promise<string[]> {
    const rows: TaskSubjectSource[] = await db('tasks')
        .select('task_id', 'repository', 'issue_number', 'pr_number', 'task_type')
        .whereRaw('LOWER(repository) = ?', [`${subject.owner}/${subject.repo}`.toLowerCase()])
        .andWhere(query => query.where('pr_number', subject.number).orWhere('issue_number', subject.number));
    return rows
        .filter(row => {
            const resolved = resolveTaskSubject(row);
            return resolved?.number === subject.number && resolved.kind === subject.kind;
        })
        .map(row => String(row.task_id));
}

/**
 * Reads the live assignees of a GitHub issue or pull request and, as a side
 * effect, replaces the stored set of every task working on it. The GitHub read
 * fails loud (callers that gate on assignment must not guess); the projection
 * refresh fails soft, since the live answer is already in hand.
 */
export async function syncSubjectAssignees(subject: TaskSubject, options: TaskAssignmentOptions = {}): Promise<AttributedUser[]> {
    const now = options.now?.() ?? new Date();
    const github = options.github ?? await defaultClient();
    const observed = await fetchAssignees(github, subject);
    try {
        const taskIds = await readTasksOnSubject(subject);
        if (taskIds.length > 0) {
            await rememberGitHubUserProfiles(observed, now);
            for (const taskId of taskIds) await replaceStoredAssignees(taskId, observed, now);
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message, repository: `${subject.owner}/${subject.repo}`, number: subject.number }, 'Failed to refresh stored task assignees after a live read');
    }
    return sortUsers(observed.map(assignee => ({ id: assignee.id, login: assignee.login, displayName: null, avatarUrl: assignee.avatar_url ?? null })));
}

function githubWriteError(error: unknown, subject: TaskSubject): TaskAssignmentError {
    const status = (error as { status?: unknown } | null)?.status;
    return new TaskAssignmentError(
        'GITHUB_WRITE_FAILED',
        `GitHub rejected the assignment of ${subject.owner}/${subject.repo}#${subject.number}: ${(error as Error)?.message ?? String(error)}`,
        { status: typeof status === 'number' ? status : undefined, cause: error },
    );
}

async function writeAssignees(github: TaskAssignmentClient, subject: TaskSubject, method: 'POST' | 'DELETE', logins: string[]): Promise<GitHubAssignee[]> {
    const response = await withRetry(
        () => github.request(`${method} /repos/{owner}/{repo}/issues/{issue_number}/assignees`, { ...subjectParameters(subject), assignees: logins }),
        retryConfigs.githubApi,
        method === 'POST' ? 'add GitHub issue assignees' : 'remove GitHub issue assignees',
    );
    return parseAssignees(response.data);
}

/**
 * De-duplicates requested logins case-insensitively, dropping a leading `@`.
 * An entry that normalizes to nothing ('', '  ', '@') fails like an unknown
 * login; silently dropping it would turn a replace into a clear-all.
 */
function normalizeRequestedLogins(logins: string[]): Map<string, string> {
    const wanted = new Map<string, string>();
    const invalid: string[] = [];
    for (const login of logins) {
        const trimmed = typeof login === 'string' ? login.trim().replace(/^@/, '') : '';
        if (!trimmed) invalid.push(String(login));
        else if (!wanted.has(trimmed.toLowerCase())) wanted.set(trimmed.toLowerCase(), trimmed);
    }
    if (invalid.length > 0) {
        throw new TaskAssignmentError('UNKNOWN_LOGIN', `Invalid GitHub login${invalid.length === 1 ? '' : 's'}: ${invalid.map(login => JSON.stringify(login)).join(', ')}`, { logins: invalid });
    }
    return wanted;
}

/**
 * Assigns the task's GitHub issue or pull request, then persists the set
 * GitHub confirmed. GitHub is written first and only its response is stored,
 * so ProPR never shows an assignment GitHub did not accept; GitHub silently
 * ignores users without repository access, and those are reported in
 * `rejected`. In `add` mode assignees added elsewhere (the GitHub UI) are
 * always kept; `replace` unassigns only current assignees not requested.
 *
 * Throws `TaskAssignmentError` when the task or its subject is missing, a
 * login is empty or does not resolve (before anything is written), or GitHub
 * fails. An empty `logins` array in `replace` mode clears every assignee.
 */
export async function setTaskAssignees(taskId: string, logins: string[], options: SetTaskAssigneesOptions): Promise<SetTaskAssigneesResult> {
    const now = options.now?.() ?? new Date();
    const task = await readTask(taskId);
    if (!task) throw new TaskAssignmentError('TASK_NOT_FOUND', `Task ${taskId} was not found`);
    const subject = options.subject ?? resolveTaskSubject(task);
    if (!subject) throw new TaskAssignmentError('NO_GITHUB_SUBJECT', `Task ${taskId} has no GitHub issue or pull request to assign`);
    const github = options.github ?? await defaultClient();

    const wanted = normalizeRequestedLogins(logins);
    const requested = new Map<string, AttributedUser>();
    const unknown: string[] = [];
    for (const login of wanted.values()) {
        const profile = await resolveGitHubUserProfileByLogin(login, { github, now: () => now });
        if (profile) requested.set(profile.id, profile);
        else unknown.push(login);
    }
    if (unknown.length > 0) {
        throw new TaskAssignmentError('UNKNOWN_LOGIN', `Unknown GitHub login${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`, { logins: unknown });
    }

    let confirmed: GitHubAssignee[];
    try {
        const toAdd = [...requested.values()];
        if (options.mode === 'replace') {
            const current = await fetchAssignees(github, subject);
            const currentIds = new Set(current.map(assignee => assignee.id));
            const additions = toAdd.filter(user => !currentIds.has(user.id));
            const removals = current.filter(assignee => !requested.has(assignee.id));
            confirmed = current;
            if (additions.length > 0) confirmed = await writeAssignees(github, subject, 'POST', additions.map(user => user.login));
            if (removals.length > 0) confirmed = await writeAssignees(github, subject, 'DELETE', removals.map(assignee => assignee.login));
        } else {
            confirmed = toAdd.length > 0
                ? await writeAssignees(github, subject, 'POST', toAdd.map(user => user.login))
                : await fetchAssignees(github, subject);
        }
    } catch (error) {
        throw githubWriteError(error, subject);
    }

    const assignees = await persistObserved(taskId, confirmed, now);
    const confirmedIds = new Set(confirmed.map(assignee => assignee.id));
    const rejected = [...requested.values()].filter(user => !confirmedIds.has(user.id));
    if (rejected.length > 0) {
        logger.warn({ taskId, rejected: rejected.map(user => user.login) }, 'GitHub did not assign every requested user');
    }
    return { subject, assignees, rejected: sortUsers(rejected) };
}

/**
 * Batch-reads stored assignees for list projections in a single query. Only
 * tasks with at least one assignee have an entry; a read failure yields an
 * empty map.
 */
export async function loadTaskAssignees(taskIds: Iterable<string | null | undefined>): Promise<Map<string, AttributedUser[]>> {
    const assignees = new Map<string, AttributedUser[]>();
    const ids = [...new Set([...taskIds].filter((id): id is string => typeof id === 'string' && id !== ''))];
    if (ids.length === 0) return assignees;
    try {
        const rows = await db(`${TABLE} as a`)
            .leftJoin(`${PROFILES_TABLE} as p`, 'p.github_user_id', 'a.github_user_id')
            .whereIn('a.task_id', ids)
            .select('a.task_id', 'a.github_user_id', 'p.login', 'p.display_name', 'p.avatar_url');
        for (const row of rows) {
            const list = assignees.get(row.task_id) ?? [];
            list.push(toAttributedUser(row));
            assignees.set(row.task_id, list);
        }
        for (const list of assignees.values()) sortUsers(list);
    } catch (error) {
        logger.warn({ error: (error as Error).message, count: ids.length }, 'Failed to load task assignees');
    }
    return assignees;
}

export interface TaskIdsAssignedToOptions {
    /** Restricts the result to tasks in this `owner/repo` repository. */
    repository?: string | null;
}

/** The ids of tasks assigned to a GitHub user, behind the "my tasks" filter. A read failure yields an empty set. */
export async function taskIdsAssignedTo(githubUserId: string | number, options: TaskIdsAssignedToOptions = {}): Promise<Set<string>> {
    const userId = normalizeUserId(githubUserId);
    if (!userId) return new Set();
    try {
        const query = db(`${TABLE} as a`).where('a.github_user_id', userId).select('a.task_id');
        const repository = options.repository?.trim();
        if (repository) {
            query.join('tasks as t', 't.task_id', 'a.task_id').whereRaw('LOWER(t.repository) = ?', [repository.toLowerCase()]);
        }
        return new Set((await query).map((row: { task_id: string }) => row.task_id));
    } catch (error) {
        logger.warn({ error: (error as Error).message, githubUserId: userId }, 'Failed to read tasks assigned to user');
        return new Set();
    }
}

/** Whether a GitHub user is a stored assignee of a task. A read failure answers false. */
export async function isUserAssignedToTask(taskId: string, githubUserId: string | number): Promise<boolean> {
    const userId = normalizeUserId(githubUserId);
    if (!taskId || !userId) return false;
    try {
        return Boolean(await db<TaskAssigneeRow>(TABLE).where({ task_id: taskId, github_user_id: userId }).first('task_id'));
    } catch (error) {
        logger.warn({ error: (error as Error).message, taskId, githubUserId: userId }, 'Failed to check task assignment');
        return false;
    }
}
