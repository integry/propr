import { RepoOption } from '../components/RepositorySelector';
import { getRepoConfig } from '../api/proprApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../api/repoIndexingApi';
import { getUserRepoPreferences, UserRepoPreferences } from '../api/userRepoPreferencesApi';

/**
 * Fetches enabled repositories with their preferences (starred) and indexing status (iconPath).
 * Used internally by RepositorySelector when no repos prop is provided.
 */
export async function fetchEnabledRepos(): Promise<RepoOption[]> {
  const [repoData, userPrefs, indexingData] = await Promise.all([
    getRepoConfig() as Promise<{ repos_to_monitor?: Array<{ name: string; enabled?: boolean; baseBranch?: string }> }>,
    getUserRepoPreferences().catch(() => ({} as UserRepoPreferences)),
    getRepositoriesIndexingStatus().catch(() => ({ repositories: [] as RepositoryIndexingStatus[] }))
  ]);

  const indexingMap = new Map<string, RepositoryIndexingStatus>();
  for (const status of indexingData.repositories || []) {
    indexingMap.set(status.full_name, status);
  }

  return (repoData.repos_to_monitor || [])
    .filter((r): r is { name: string; enabled?: boolean; baseBranch?: string } =>
      typeof r === 'object' && r !== null && 'name' in r && typeof (r as { name: unknown }).name === 'string'
    )
    .filter(r => r.enabled !== false)
    .map(r => {
      const prefs = userPrefs[r.name];
      const indexingStatus = indexingMap.get(r.name);
      return {
        name: r.name,
        enabled: true,
        baseBranch: r.baseBranch,
        starred: prefs?.starred || false,
        iconPath: indexingStatus?.icon_path || null
      };
    });
}
