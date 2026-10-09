/**
 * Assignment contracts shared by the API, CLI, MCP and Web UI.
 *
 * Tasks, goals, plans, automations and to-dos store the stable GitHub numeric
 * user id of the person they belong to. `AttributedUser` is the one shape every
 * surface renders that id as, and `TaskAssignmentFilter` is the one parsed form
 * of the `assignee` query value, so each surface does not invent its own.
 *
 * This module is dependency-free so the browser can import it without core.
 */

/** A GitHub user that work is assigned or attributed to. */
export interface AttributedUser {
  /** Stable GitHub numeric user id, stored as a string. */
  id: string;
  /** GitHub login at the time the profile was last refreshed. */
  login: string;
  /** GitHub profile name, when the user has set one. */
  displayName: string | null;
  avatarUrl: string | null;
}

/** The assignee filter modes: everyone, the signed-in user, nobody, or named logins. */
export const TASK_ASSIGNMENT_FILTERS = ['all', 'me', 'unassigned', 'users'] as const;
export type TaskAssignmentFilterMode = typeof TASK_ASSIGNMENT_FILTERS[number];

export type TaskAssignmentFilter =
  | { mode: 'all' }
  | { mode: 'me' }
  | { mode: 'unassigned' }
  | { mode: 'users'; logins: string[] };

/** The most logins one assignee filter may name. */
export const MAX_TASK_ASSIGNMENT_FILTER_LOGINS = 20;

// GitHub logins are 1-39 alphanumerics or single hyphens; app bots carry a `[bot]` suffix.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export type TaskAssignmentFilterParseResult =
  | { ok: true; filter: TaskAssignmentFilter }
  | { ok: false; error: string };

export function isGitHubLogin(value: string): boolean {
  return GITHUB_LOGIN_PATTERN.test(value);
}

/**
 * Parses an `assignee` query value. A missing or blank value, or `all`, means
 * every task; `me` means the signed-in user; `unassigned` means tasks nobody
 * is assigned to; anything else is a comma-separated
 * list of GitHub logins (an optional leading `@` is accepted), trimmed and
 * de-duplicated case-insensitively in first-seen order.
 */
export function parseTaskAssignmentFilter(value: unknown): TaskAssignmentFilterParseResult {
  if (value === undefined || value === null) return { ok: true, filter: { mode: 'all' } };
  if (typeof value !== 'string') return { ok: false, error: 'assignee must be a string' };
  const trimmed = value.trim();
  const keyword = trimmed.toLowerCase();
  if (trimmed === '' || keyword === 'all') return { ok: true, filter: { mode: 'all' } };
  if (keyword === 'me') return { ok: true, filter: { mode: 'me' } };
  if (keyword === 'unassigned') return { ok: true, filter: { mode: 'unassigned' } };

  const logins: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(',')) {
    const login = part.trim().replace(/^@/, '');
    if (login === '') continue;
    if (!isGitHubLogin(login)) return { ok: false, error: `assignee contains an invalid GitHub login: ${login.slice(0, 64)}` };
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
    if (logins.length > MAX_TASK_ASSIGNMENT_FILTER_LOGINS) {
      return { ok: false, error: `assignee may name at most ${MAX_TASK_ASSIGNMENT_FILTER_LOGINS} logins` };
    }
  }
  if (logins.length === 0) return { ok: true, filter: { mode: 'all' } };
  return { ok: true, filter: { mode: 'users', logins } };
}

/**
 * Serializes a filter back to its `assignee` query value. A lone login that
 * reads as a keyword (a user named `all`, `me` or `unassigned`) keeps an `@` prefix so it
 * parses back as that user rather than the keyword.
 */
export function formatTaskAssignmentFilter(filter: TaskAssignmentFilter): string {
  if (filter.mode !== 'users') return filter.mode;
  const value = filter.logins.join(',');
  const keyword = value.toLowerCase();
  return keyword === 'all' || keyword === 'me' || keyword === 'unassigned' ? `@${value}` : value;
}
