/**
 * Task assignment endpoints of the task detail page.
 *
 * The task list serves the cached `task_assignees` projection and never calls
 * GitHub. The detail page opens one task deliberately, so it reads the live
 * assignment from GitHub, writes it through `setTaskAssignees` (GitHub stays
 * the authority), and offers the repository's assignable users as candidates.
 *
 * Any authenticated member may read. Writing requires GitHub write access to
 * the repository, the same bar GitHub enforces on assignment.
 */

import type { Response } from 'express';
import type { Knex } from 'knex';
import {
  getAuthenticatedOctokit,
  loadGitHubUserProfiles,
  loadTaskAssignees,
  rememberGitHubUserProfiles,
  resolveTaskSubject,
  setTaskAssignees,
  syncTaskAssignees,
  TaskAssignmentError,
  type TaskAssignmentClient,
  type TaskAssignmentMode,
  type TaskSubject,
} from '@propr/core';
import { isGitHubLogin, MAX_TASK_ASSIGNEES, type AttributedUser } from '@propr/shared';
import type { FlatRequest } from '../requestTypes.js';
import {
  GitHubRepositoryWriteAccessError,
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
  verifyGitHubRepositoryWriteAccess,
} from '../githubMetadataAuth.js';
import { validateTaskId } from './validation.js';

/** How long the assignable users of a repository are served from memory. */
export const ASSIGNABLE_USERS_CACHE_TTL_MS = 60_000;
/** The most assignable users one response lists. */
export const MAX_ASSIGNABLE_USERS = 300;
const ASSIGNABLE_USERS_PAGE_SIZE = 100;
// Bounds the in-memory cache; the oldest repository is evicted first.
const MAX_CACHED_REPOSITORIES = 200;

const TASK_ASSIGNMENT_MODES: readonly TaskAssignmentMode[] = ['add', 'replace'];

export interface AssignableUsers {
  users: AttributedUser[];
  /** True when the repository has more assignable users than `MAX_ASSIGNABLE_USERS`. */
  truncated: boolean;
}

interface TaskAssignmentRoutesDeps {
  db: Knex;
  /** The installation client GitHub is read and written with; injectable for tests. */
  github?: () => Promise<TaskAssignmentClient>;
  resolveMetadataToken?: typeof resolveGitHubMetadataToken;
  verifyRepositoryWriteAccess?: (repository: string, accessToken: string) => Promise<void>;
  now?: () => number;
}

type TaskLookup =
  | { ok: true; taskId: string; subject: TaskSubject }
  | { ok: false };

// The legacy `error` field is kept beside `code` and `message` for existing clients.
function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: message, code, message, ...extra };
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json(errorBody(code, message));
}

type AssigneesBodyResult =
  | { ok: true; logins: string[]; mode: TaskAssignmentMode }
  | { ok: false; error: string };

/** Validates `{ logins: string[], mode?: 'add' | 'replace' }`; `mode` defaults to `replace`. */
export function parseAssigneesBody(body: unknown): AssigneesBodyResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Request body must be a JSON object' };
  const { logins, mode = 'replace' } = body as { logins?: unknown; mode?: unknown };
  if (!Array.isArray(logins)) return { ok: false, error: 'logins must be an array of GitHub logins' };
  if (logins.length > MAX_TASK_ASSIGNEES) return { ok: false, error: `logins may name at most ${MAX_TASK_ASSIGNEES} users` };
  const parsed: string[] = [];
  for (const entry of logins) {
    const login = typeof entry === 'string' ? entry.trim().replace(/^@/, '') : '';
    if (!isGitHubLogin(login)) {
      return { ok: false, error: `logins contains an invalid GitHub login: ${JSON.stringify(entry)?.slice(0, 64) ?? String(entry)}` };
    }
    parsed.push(login);
  }
  if (typeof mode !== 'string' || !TASK_ASSIGNMENT_MODES.includes(mode as TaskAssignmentMode)) {
    return { ok: false, error: `mode must be one of: ${TASK_ASSIGNMENT_MODES.join(', ')}` };
  }
  return { ok: true, logins: parsed, mode: mode as TaskAssignmentMode };
}

function parseUser(entry: unknown): { id: string; login: string; avatar_url: string | null } | null {
  const record = entry as Record<string, unknown> | null;
  const id = typeof record?.id === 'number' && Number.isSafeInteger(record.id) && record.id > 0 ? String(record.id) : null;
  const login = typeof record?.login === 'string' ? record.login : '';
  if (!id || !login) return null;
  return { id, login, avatar_url: typeof record?.avatar_url === 'string' ? record.avatar_url : null };
}

export function createTaskAssignmentRoutes(deps: TaskAssignmentRoutesDeps) {
  const { db } = deps;
  const github = deps.github ?? (async () => await getAuthenticatedOctokit() as unknown as TaskAssignmentClient);
  // Without an injected client the service resolves the installation client
  // itself, inside its own fail-soft handling.
  const serviceOptions = async () => deps.github ? { github: await deps.github() } : {};
  const resolveMetadataToken = deps.resolveMetadataToken ?? resolveGitHubMetadataToken;
  const verifyRepositoryWriteAccess = deps.verifyRepositoryWriteAccess ?? verifyGitHubRepositoryWriteAccess;
  const now = deps.now ?? Date.now;
  const assignableUsersCache = new Map<string, { expiresAt: number; value: Promise<AssignableUsers> }>();

  /** Reads the task row once and answers 400, 404 or 409 itself when there is nothing to work on. */
  async function lookupTask(req: FlatRequest, res: Response): Promise<TaskLookup> {
    const validation = validateTaskId(req.params.taskId);
    if (!validation.valid) {
      sendError(res, 400, 'INVALID_TASK_ID', validation.error ?? 'Invalid task ID');
      return { ok: false };
    }
    const taskId = req.params.taskId.trim();
    const task = await db('tasks').select('task_id', 'repository', 'issue_number', 'pr_number', 'task_type').where({ task_id: taskId }).first();
    if (!task) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task ${taskId} was not found`);
      return { ok: false };
    }
    const subject = resolveTaskSubject(task);
    if (!subject) {
      sendError(res, 409, 'NO_GITHUB_SUBJECT', 'This task has no GitHub issue or pull request, so there is nothing to assign.');
      return { ok: false };
    }
    return { ok: true, taskId, subject };
  }

  async function fetchAssignableUsers(subject: TaskSubject): Promise<AssignableUsers> {
    const client = await github();
    const listed: Array<{ id: string; login: string; avatar_url: string | null }> = [];
    // Reading on past the cap until a short page or one user more than fits
    // establishes `truncated`; a full page at exactly the cap proves nothing.
    for (let page = 1; listed.length <= MAX_ASSIGNABLE_USERS; page++) {
      const response = await client.request('GET /repos/{owner}/{repo}/assignees', {
        owner: subject.owner, repo: subject.repo, per_page: ASSIGNABLE_USERS_PAGE_SIZE, page,
      });
      const entries = Array.isArray(response.data) ? response.data : [];
      for (const entry of entries) {
        const user = parseUser(entry);
        if (user) listed.push(user);
      }
      if (entries.length < ASSIGNABLE_USERS_PAGE_SIZE) break;
    }
    const truncated = listed.length > MAX_ASSIGNABLE_USERS;
    const users = listed.slice(0, MAX_ASSIGNABLE_USERS);
    await rememberGitHubUserProfiles(users);
    // The listing carries no display names; previously cached profiles fill them in.
    const profiles = await loadGitHubUserProfiles(users.map(user => user.id));
    return {
      users: users
        .map(user => profiles.get(user.id) ?? { id: user.id, login: user.login, displayName: null, avatarUrl: user.avatar_url })
        .sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' })),
      truncated,
    };
  }

  function cachedAssignableUsers(subject: TaskSubject): Promise<AssignableUsers> {
    const key = `${subject.owner}/${subject.repo}`.toLowerCase();
    const cached = assignableUsersCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    assignableUsersCache.delete(key);
    const value = fetchAssignableUsers(subject);
    assignableUsersCache.set(key, { expiresAt: now() + ASSIGNABLE_USERS_CACHE_TTL_MS, value });
    // A failed read must not be served from the cache.
    value.catch(() => { if (assignableUsersCache.get(key)?.value === value) assignableUsersCache.delete(key); });
    while (assignableUsersCache.size > MAX_CACHED_REPOSITORIES) {
      assignableUsersCache.delete(assignableUsersCache.keys().next().value as string);
    }
    return value;
  }

  /** `GET /api/task/:taskId/assignees`: live from GitHub unless `?refresh=false`. */
  async function getAssignees(req: FlatRequest, res: Response): Promise<void> {
    try {
      const lookup = await lookupTask(req, res);
      if (!lookup.ok) return;
      if (req.query.refresh === 'false') {
        const assignees = (await loadTaskAssignees([lookup.taskId])).get(lookup.taskId) ?? [];
        res.json({ subject: lookup.subject, assignees, synced: false });
        return;
      }
      const result = await syncTaskAssignees(lookup.taskId, await serviceOptions());
      res.json({ subject: result.subject ?? lookup.subject, assignees: result.assignees, synced: result.synced });
    } catch (error) {
      console.error('Error in GET /api/task/:taskId/assignees:', error);
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to read task assignees');
    }
  }

  /** `PUT /api/task/:taskId/assignees`: assigns on GitHub and returns the confirmed set. */
  async function putAssignees(req: FlatRequest, res: Response): Promise<void> {
    try {
      const body = parseAssigneesBody(req.body);
      if (!body.ok) { sendError(res, 400, 'INVALID_ASSIGNEES', body.error); return; }
      const lookup = await lookupTask(req, res);
      if (!lookup.ok) return;

      const repository = `${lookup.subject.owner}/${lookup.subject.repo}`;
      try {
        await verifyRepositoryWriteAccess(repository, await resolveMetadataToken(req));
      } catch (error) {
        if (error instanceof GitHubRepositoryWriteAccessError) { sendError(res, 403, 'REPOSITORY_WRITE_ACCESS_REQUIRED', error.message); return; }
        if (await handleGitHubRepositoryAccessError(req, res, error)) return;
        // GitHub being unavailable during the permission check is the same outage as during the write.
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status === 'number' && status >= 500) { sendError(res, 502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached to check repository access'); return; }
        throw error;
      }

      const result = await setTaskAssignees(lookup.taskId, body.logins, { mode: body.mode, ...await serviceOptions() });
      if (result.rejected.length > 0) {
        // The confirmed set is still returned so the page can show what GitHub did apply.
        res.status(422).json(errorBody('GITHUB_REJECTED',
          `GitHub did not assign ${result.rejected.map(user => user.login).join(', ')}; they may not have access to ${repository}.`,
          { subject: result.subject, assignees: result.assignees, rejected: result.rejected }));
        return;
      }
      res.json({ subject: result.subject, assignees: result.assignees, rejected: [] });
    } catch (error) {
      if (error instanceof TaskAssignmentError) {
        if (error.code === 'TASK_NOT_FOUND') { sendError(res, 404, error.code, error.message); return; }
        if (error.code === 'NO_GITHUB_SUBJECT') { sendError(res, 409, error.code, error.message); return; }
        if (error.code === 'UNKNOWN_LOGIN') { res.status(400).json(errorBody(error.code, error.message, { logins: error.logins })); return; }
        // A GitHub answer below 500 is a rejection of this request; anything else is GitHub being unavailable.
        if (error.status !== undefined && error.status < 500) { sendError(res, 422, 'GITHUB_REJECTED', error.message); return; }
        sendError(res, 502, 'GITHUB_UNAVAILABLE', error.message);
        return;
      }
      console.error('Error in PUT /api/task/:taskId/assignees:', error);
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update task assignees');
    }
  }

  /** `GET /api/task/:taskId/assignable-users`: the repository's assignable users, cached briefly. */
  async function getAssignableUsers(req: FlatRequest, res: Response): Promise<void> {
    try {
      const lookup = await lookupTask(req, res);
      if (!lookup.ok) return;
      res.json(await cachedAssignableUsers(lookup.subject));
    } catch (error) {
      console.error('Error in GET /api/task/:taskId/assignable-users:', error);
      sendError(res, 502, 'GITHUB_UNAVAILABLE', 'Failed to read the assignable users of the repository from GitHub');
    }
  }

  return { getAssignees, putAssignees, getAssignableUsers };
}
