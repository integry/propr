import { isGitHubLogin } from '@propr/shared';
import type { RepoToMonitor } from '@propr/core';

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

type AutoAssignField = 'autoAssignPullRequests' | 'autoAssignDefaultAssignee' | 'autoAssignRequestReview';
type AutoAssignValue = boolean | string | null;

const AUTO_ASSIGN_FIELDS: readonly AutoAssignField[] = ['autoAssignPullRequests', 'autoAssignDefaultAssignee', 'autoAssignRequestReview'];

function repositoryKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** A stored default assignee is a GitHub login; anything else means "use the issue author". */
export function normalizeStoredAutoAssignDefaultAssignee(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const login = value.trim().replace(/^@/, '');
  return login && isGitHubLogin(login) ? login : null;
}

/**
 * Validates the default assignee written by a client. `null` and a blank string
 * clear the override so the issue author is assigned again; an optional leading
 * `@` is accepted. Absent stays absent so preservation can keep the stored value.
 */
export function normalizeAutoAssignDefaultAssignee(value: unknown, repoName: string): ValidationResult<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: `Invalid autoAssignDefaultAssignee format for ${repoName}: must be a GitHub login or null` };
  }
  const login = value.trim().replace(/^@/, '');
  if (!login) return { ok: true, value: null };
  if (!isGitHubLogin(login)) {
    return { ok: false, error: `Invalid autoAssignDefaultAssignee format for ${repoName}: must be a GitHub login or null` };
  }
  return { ok: true, value: login };
}

type AutoAssignSettings = Required<Pick<RepoToMonitor, AutoAssignField>>;

/**
 * The normalized automatic assignment options of a written repository entry.
 * The booleans are validated with the other optional booleans; absent reads as
 * off and the issue author, and preservation then keeps the stored values.
 */
export function normalizeRepoAutoAssign(candidate: Partial<RepoToMonitor>, repoName: string): ValidationResult<AutoAssignSettings> {
  const defaultAssignee = normalizeAutoAssignDefaultAssignee(candidate.autoAssignDefaultAssignee, repoName);
  if (!defaultAssignee.ok) return defaultAssignee;
  return {
    ok: true,
    value: {
      autoAssignPullRequests: candidate.autoAssignPullRequests === true,
      autoAssignDefaultAssignee: defaultAssignee.value ?? null,
      autoAssignRequestReview: candidate.autoAssignRequestReview === true
    }
  };
}

function normalizeStoredAutoAssignValue(field: AutoAssignField, value: unknown): AutoAssignValue {
  return field === 'autoAssignDefaultAssignee' ? normalizeStoredAutoAssignDefaultAssignee(value) : value === true;
}

/** Automatic pull request assignment is off, uses the issue author and requests no review unless configured. */
export function withDefaultRepoAutoAssign(repo: RepoToMonitor): RepoToMonitor {
  return {
    ...repo,
    autoAssignPullRequests: repo.autoAssignPullRequests === true,
    autoAssignDefaultAssignee: normalizeStoredAutoAssignDefaultAssignee(repo.autoAssignDefaultAssignee),
    autoAssignRequestReview: repo.autoAssignRequestReview === true
  };
}

/**
 * Repository-wide stored value across branch entries: a boolean option is on
 * when any entry opts in, and the default assignee is the first configured one.
 */
function resolveStoredRepoAutoAssignValue(field: AutoAssignField, entries: readonly RepoToMonitor[]): AutoAssignValue {
  if (field !== 'autoAssignDefaultAssignee') return entries.some(entry => entry[field] === true);
  for (const entry of entries) {
    const login = normalizeStoredAutoAssignDefaultAssignee(entry.autoAssignDefaultAssignee);
    if (login) return login;
  }
  return null;
}

function sameAutoAssignValue(left: AutoAssignValue | undefined, right: AutoAssignValue | undefined): boolean {
  // GitHub logins are case-insensitive; changing only the case is not an edit.
  return typeof left === 'string' && typeof right === 'string' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function preserveRepoAutoAssignField(
  field: AutoAssignField,
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const storedByRepository = new Map<string, AutoAssignValue>();
  for (const key of new Set(previousRepos.map(repo => repositoryKeyOf(repo.name)))) {
    storedByRepository.set(key, resolveStoredRepoAutoAssignValue(field, previousRepos.filter(repo => repositoryKeyOf(repo.name) === key)));
  }

  const changedByRepository = new Map<string, AutoAssignValue>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor> | undefined;
    if (incoming?.[field] === undefined) return;
    const repositoryKey = repositoryKeyOf(repo.name);
    if (changedByRepository.has(repositoryKey)) return;
    const value = normalizeStoredAutoAssignValue(field, repo[field]);
    const previousEntry = previousRepos.find(candidate => candidate.id === repo.id);
    const previousValue = previousEntry
      ? normalizeStoredAutoAssignValue(field, previousEntry[field])
      : storedByRepository.get(repositoryKey);
    if (!sameAutoAssignValue(previousValue, value)) changedByRepository.set(repositoryKey, value);
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repositoryKeyOf(repo.name);
    // A new repository has no stored value, so its first explicit value counts as a change.
    const value = changedByRepository.has(repositoryKey) ? changedByRepository.get(repositoryKey)
      : storedByRepository.has(repositoryKey) ? storedByRepository.get(repositoryKey)
        : normalizeStoredAutoAssignValue(field, repo[field]);
    return { ...repo, [field]: value ?? null };
  });
}

/**
 * Automatic pull request assignment is repository-wide, like notifications: an
 * explicit change on any branch entry applies to every entry of the repository,
 * and entries submitted without a field (the CLI, scripts, older UIs) keep the
 * stored repository value instead of silently switching it off or clearing it.
 */
export function preserveRepoAutoAssign(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  return AUTO_ASSIGN_FIELDS.reduce(
    (repos, field) => preserveRepoAutoAssignField(field, previousRepos, repos, incomingRepos),
    normalizedRepos
  );
}
