import { useEffect, useMemo, useState } from 'react';
import type { RepoOption } from '../components/RepositorySelector';
import { fetchEnabledRepos } from '../utils/repoHelpers';

/**
 * Adds the starred flag and repository icon (as shown in Planner Studio) to
 * repository options built from bare names, so every RepositorySelector groups
 * starred repositories first and shows the same icons. Counts, display names
 * and branches set by the caller are kept.
 */
export function useDecoratedRepoOptions(options: RepoOption[]): RepoOption[];
export function useDecoratedRepoOptions(options: RepoOption[] | undefined): RepoOption[] | undefined;
export function useDecoratedRepoOptions(options: RepoOption[] | undefined): RepoOption[] | undefined {
  const [known, setKnown] = useState<RepoOption[]>([]);

  useEffect(() => {
    let active = true;
    fetchEnabledRepos()
      .then(loaded => { if (active) setKnown(loaded); })
      .catch(() => { /* Options stay undecorated. */ });
    return () => { active = false; };
  }, []);

  return useMemo(() => {
    if (!options || known.length === 0) return options;
    const byName = new Map<string, RepoOption>();
    for (const repo of known) {
      const existing = byName.get(repo.name);
      if (!existing || (!existing.iconPath && repo.iconPath)) byName.set(repo.name, repo);
    }
    return options.map(option => {
      const match = byName.get(option.name);
      if (!match) return option;
      return {
        ...option,
        starred: option.starred ?? match.starred,
        iconPath: option.iconPath ?? match.iconPath,
        iconRevision: option.iconRevision ?? match.iconRevision,
      };
    });
  }, [options, known]);
}
