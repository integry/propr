import type { RepoToMonitor } from './configManager.js';
import { getConfigStrict } from './configStore.js';

/**
 * The pull request status display is repository-wide: it is on when any entry
 * of the repository opts in. Missing or malformed values read as off.
 */
export function resolveRepositoryPrStatusDisplay(repos: readonly RepoToMonitor[], repository: string): boolean {
    const normalizedRepository = repository.trim().toLowerCase();
    return repos.some(repo => repo.name.trim().toLowerCase() === normalizedRepository && repo.prStatusDisplay === true);
}

/** Throws when the configuration cannot be read, so no body is written on a guess. */
export async function loadRepositoryPrStatusDisplay(repository: string): Promise<boolean> {
    return resolveRepositoryPrStatusDisplay(await getConfigStrict<RepoToMonitor[]>('repos_to_monitor', []), repository);
}
