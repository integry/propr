import { Knex } from 'knex';
import type { AttributedUser, TaskAssignmentFilter } from '@propr/shared';

/**
 * The task list's view of `task_assignees`, the local projection of GitHub
 * issue and pull request assignment. Everything here reads through the
 * connection the list query uses and never calls GitHub: refreshing the
 * projection is the detail view's opt-in, not the list's.
 */

/** Which tasks the assignee filter lists, with logins already resolved to stable ids. */
export type AssigneeSelection =
  | { kind: 'users'; userIds: readonly string[] }
  | { kind: 'unassigned' };

const normalizeUserId = (value: unknown): string | null => {
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
};

/**
 * The ids of cached GitHub profiles holding these logins. A login is matched
 * case-insensitively, and when a rename left an older profile holding the same
 * login, the most recently confirmed one wins. Unknown logins resolve to nothing.
 */
async function userIdsForLogins(db: Knex, logins: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(logins.map(login => login.toLowerCase()))];
  const rows = await db('github_user_profiles')
    .whereRaw(`LOWER(login) IN (${wanted.map(() => '?').join(', ')})`, wanted)
    .select('github_user_id', 'login')
    .orderBy('updated_at', 'desc') as Array<{ github_user_id: string; login: string }>;
  const byLogin = new Map<string, string>();
  for (const row of rows) {
    const key = row.login.toLowerCase();
    if (!byLogin.has(key)) byLogin.set(key, String(row.github_user_id));
  }
  return [...new Set(byLogin.values())];
}

/**
 * Resolves the filter to the selection the list query applies, or null when
 * it lists every task. `me` is the acting user's GitHub id, never a value the
 * client supplied.
 */
export async function resolveAssigneeSelection(
  db: Knex,
  filter: TaskAssignmentFilter | undefined,
  actingUserId: string | number | null | undefined,
): Promise<AssigneeSelection | null> {
  switch (filter?.mode) {
    case undefined:
    case 'all':
      return null;
    case 'unassigned':
      return { kind: 'unassigned' };
    case 'me': {
      const id = normalizeUserId(actingUserId);
      return { kind: 'users', userIds: id ? [id] : [] };
    }
    case 'users':
      return { kind: 'users', userIds: await userIdsForLogins(db, filter.logins) };
  }
}

/** Whether a selection can list no task at all, so the page is empty without querying. */
export const selectsNothing = (selection: AssigneeSelection | null): boolean =>
  selection?.kind === 'users' && selection.userIds.length === 0;

/**
 * The `task_assignees` rows of run `t` that a selection looks for: any
 * assignee for `unassigned` (which then asks that none exist), else the
 * selected users. An existence check keeps the predicate on the primary key.
 */
export function assigneeRows(db: Knex, selection: AssigneeSelection): Knex.QueryBuilder {
  const rows = db('task_assignees as ta').select(db.raw('1')).whereRaw('ta.task_id = t.task_id');
  if (selection.kind === 'users') rows.whereIn('ta.github_user_id', [...selection.userIds]);
  return rows;
}

/** Narrows a run query to the runs a selection lists. */
export function applyAssigneeSelection(db: Knex, query: Knex.QueryBuilder, selection: AssigneeSelection): void {
  if (selection.kind === 'unassigned') query.whereNotExists(assigneeRows(db, selection));
  else query.whereExists(assigneeRows(db, selection));
}

const byLogin = (a: AttributedUser, b: AttributedUser): number =>
  a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * The stored assignees of a page of tasks, in one query with their cached
 * profiles joined in. Only tasks with an assignee have an entry. An assignee
 * whose profile was never cached is listed under its id. A failed read yields
 * no assignees rather than failing the list.
 */
export async function loadPageAssignees(db: Knex, taskIds: readonly string[]): Promise<Map<string, AttributedUser[]>> {
  const assignees = new Map<string, AttributedUser[]>();
  if (taskIds.length === 0) return assignees;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await db('task_assignees as a')
      .leftJoin('github_user_profiles as p', 'p.github_user_id', 'a.github_user_id')
      .whereIn('a.task_id', [...taskIds])
      .select('a.task_id', 'a.github_user_id', 'p.login', 'p.display_name', 'p.avatar_url');
  } catch (error) {
    console.warn('Failed to load task assignees:', (error as Error).message);
    return assignees;
  }
  for (const row of rows) {
    const id = String(row.github_user_id);
    const user: AttributedUser = {
      id,
      login: typeof row.login === 'string' && row.login ? row.login : id,
      displayName: typeof row.display_name === 'string' ? row.display_name : null,
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    };
    const taskId = String(row.task_id);
    assignees.set(taskId, [...(assignees.get(taskId) ?? []), user]);
  }
  for (const list of assignees.values()) list.sort(byLogin);
  return assignees;
}
