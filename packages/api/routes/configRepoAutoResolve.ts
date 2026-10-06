import type { RepoToMonitor } from '@propr/core';

function repositoryKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A repository override is `true`/`false`; anything else (absent, `null`) means
 * "inherit the instance default" and is not stored. Never default it to false:
 * that would silently turn "inherit" into "off" for every repository.
 */
export function normalizeStoredAutoResolveMergeConflicts(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** `null` is valid: it clears the override so the repository inherits the instance default. */
export function isValidAutoResolveMergeConflicts(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

/** Sets the override, or removes the field entirely when the repository inherits. */
export function withAutoResolveMergeConflicts(repo: RepoToMonitor, value: boolean | null): RepoToMonitor {
  if (value !== null) return { ...repo, autoResolveMergeConflicts: value };
  const inherited = { ...repo };
  delete inherited.autoResolveMergeConflicts;
  return inherited;
}

/** Repository-wide stored override: the first explicit value among the repository's entries. */
export function resolveStoredRepoAutoResolveMergeConflicts(entries: readonly RepoToMonitor[]): boolean | null {
  for (const entry of entries) {
    const value = normalizeStoredAutoResolveMergeConflicts(entry.autoResolveMergeConflicts);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The merge-conflict auto-resolve override is repository-wide, like
 * notifications: an explicit change (`true`, `false`, or `null` to inherit) on
 * any branch entry applies to every entry of the repository. Entries submitted
 * without the field (partial or legacy clients) keep the stored override.
 */
export function preserveRepoAutoResolveMergeConflicts(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const storedByRepository = new Map<string, boolean | null>();
  for (const key of new Set(previousRepos.map(repo => repositoryKeyOf(repo.name)))) {
    storedByRepository.set(key, resolveStoredRepoAutoResolveMergeConflicts(
      previousRepos.filter(repo => repositoryKeyOf(repo.name) === key)
    ));
  }

  const changedByRepository = new Map<string, boolean | null>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor> | undefined;
    if (incoming?.autoResolveMergeConflicts === undefined) return;
    const repositoryKey = repositoryKeyOf(repo.name);
    if (changedByRepository.has(repositoryKey)) return;
    const incomingValue = normalizeStoredAutoResolveMergeConflicts(incoming.autoResolveMergeConflicts);
    const previousEntry = previousRepos.find(candidate => candidate.id === repo.id);
    const previousValue = previousEntry
      ? normalizeStoredAutoResolveMergeConflicts(previousEntry.autoResolveMergeConflicts)
      : storedByRepository.get(repositoryKey) ?? null;
    if (previousValue !== incomingValue) changedByRepository.set(repositoryKey, incomingValue);
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repositoryKeyOf(repo.name);
    const value = changedByRepository.has(repositoryKey)
      ? changedByRepository.get(repositoryKey) ?? null
      : storedByRepository.has(repositoryKey)
        ? storedByRepository.get(repositoryKey) ?? null
        : normalizeStoredAutoResolveMergeConflicts(repo.autoResolveMergeConflicts);
    return withAutoResolveMergeConflicts(repo, value);
  });
}
