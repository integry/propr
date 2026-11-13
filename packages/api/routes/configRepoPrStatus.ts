import type { RepoToMonitor } from '@propr/core';

function repositoryKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** Repository-wide stored value: on when any branch entry of the repository opts in. */
export function resolveStoredRepoPrStatusDisplay(entries: readonly RepoToMonitor[]): boolean {
  return entries.some(entry => entry.prStatusDisplay === true);
}

/**
 * The pull request status display is repository-wide, like automatic
 * assignment: an explicit change on any branch entry applies to every entry of
 * the repository, and entries submitted without the field (the CLI, scripts,
 * older UIs) keep the stored repository value instead of switching it off.
 */
export function preserveRepoPrStatusDisplay(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const storedByRepository = new Map<string, boolean>();
  for (const key of new Set(previousRepos.map(repo => repositoryKeyOf(repo.name)))) {
    storedByRepository.set(key, resolveStoredRepoPrStatusDisplay(previousRepos.filter(repo => repositoryKeyOf(repo.name) === key)));
  }

  const changedByRepository = new Map<string, boolean>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor> | undefined;
    if (typeof incoming?.prStatusDisplay !== 'boolean') return;
    const repositoryKey = repositoryKeyOf(repo.name);
    if (changedByRepository.has(repositoryKey)) return;
    const previousEntry = previousRepos.find(candidate => candidate.id === repo.id);
    const previousValue = previousEntry ? previousEntry.prStatusDisplay === true : storedByRepository.get(repositoryKey);
    if (previousValue !== incoming.prStatusDisplay) changedByRepository.set(repositoryKey, incoming.prStatusDisplay);
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repositoryKeyOf(repo.name);
    const value = changedByRepository.get(repositoryKey)
      ?? storedByRepository.get(repositoryKey)
      ?? repo.prStatusDisplay === true;
    return { ...repo, prStatusDisplay: value };
  });
}
