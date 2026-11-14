import type { RepoToMonitor } from '@propr/core';

function repositoryKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** Repository-wide stored value: on unless a branch entry of the repository turns it off. */
export function resolveStoredRepoPrTitleStatus(entries: readonly RepoToMonitor[]): boolean {
  return !entries.some(entry => entry.prTitleStatus === false);
}

/**
 * The pull request title status is repository-wide, like automatic
 * assignment: an explicit change on any branch entry applies to every entry of
 * the repository, and entries submitted without the field (the CLI, scripts,
 * older UIs) keep the stored repository value. It controls the title only.
 */
export function preserveRepoPrTitleStatus(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const storedByRepository = new Map<string, boolean>();
  for (const key of new Set(previousRepos.map(repo => repositoryKeyOf(repo.name)))) {
    storedByRepository.set(key, resolveStoredRepoPrTitleStatus(previousRepos.filter(repo => repositoryKeyOf(repo.name) === key)));
  }

  const changedByRepository = new Map<string, boolean>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor> | undefined;
    if (typeof incoming?.prTitleStatus !== 'boolean') return;
    const repositoryKey = repositoryKeyOf(repo.name);
    if (changedByRepository.has(repositoryKey)) return;
    const previousEntry = previousRepos.find(candidate => candidate.id === repo.id);
    const previousValue = previousEntry ? previousEntry.prTitleStatus !== false : storedByRepository.get(repositoryKey);
    if (previousValue !== incoming.prTitleStatus) changedByRepository.set(repositoryKey, incoming.prTitleStatus);
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repositoryKeyOf(repo.name);
    const value = changedByRepository.get(repositoryKey)
      ?? storedByRepository.get(repositoryKey)
      ?? repo.prTitleStatus !== false;
    return { ...repo, prTitleStatus: value };
  });
}
