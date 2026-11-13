import type { RepoToMonitor } from './configManager.js';
import { getConfigStrict } from './configStore.js';

/**
 * Whether the pull request title shows the PR state as a leading emoji. It
 * controls the title only: the status block in the body is always written.
 * Repository-wide and on by default: it is off only when an entry of the
 * repository sets it to false. Read by the status sync (pullRequestStatusTitle).
 */
export function resolveRepositoryPrTitleStatus(repos: readonly RepoToMonitor[], repository: string): boolean {
    const normalizedRepository = repository.trim().toLowerCase();
    return !repos.some(repo => repo.name.trim().toLowerCase() === normalizedRepository && repo.prTitleStatus === false);
}

/** Throws when the configuration cannot be read, so the title is not changed on a guess. */
export async function loadRepositoryPrTitleStatus(repository: string): Promise<boolean> {
    return resolveRepositoryPrTitleStatus(await getConfigStrict<RepoToMonitor[]>('repos_to_monitor', []), repository);
}
