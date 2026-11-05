import logger from '../utils/logger.js';
import { getConfig, getConfigStrict } from './configStore.js';
import type { RepoToMonitor } from './configManager.js';
import {
    AUTO_RESOLVE_MERGE_CONFLICTS_CONFIG_KEY,
    parseBooleanSetting,
    resolveAutoResolveMergeConflicts,
    type EffectiveAutoResolveMergeConflicts,
} from './mergeConflictSettingsResolution.js';

export * from './mergeConflictSettingsResolution.js';

/** Reads the instance default from the same row the settings route writes. */
export async function loadInstanceAutoResolveMergeConflicts(): Promise<boolean> {
    const raw = await getConfig<unknown>(AUTO_RESOLVE_MERGE_CONFLICTS_CONFIG_KEY, false);
    const parsed = parseBooleanSetting(raw);
    if (parsed === null && raw !== null && raw !== undefined) {
        logger.warn({ key: AUTO_RESOLVE_MERGE_CONFLICTS_CONFIG_KEY, valueType: typeof raw }, 'Stored auto-resolve merge conflicts setting is not a boolean; treating it as disabled');
    }
    return parsed ?? false;
}

/**
 * Reads the repository overrides strictly: a failed read must not look like
 * "no override", or an enabled instance default would bypass a repository opt-out.
 * Throws when the row cannot be read or is not a list; a missing row inherits.
 */
export async function loadAutoResolveRepositoryConfigs(): Promise<RepoToMonitor[]> {
    const repos = await getConfigStrict<unknown>('repos_to_monitor', []);
    if (!Array.isArray(repos)) {
        throw new Error(`Stored repos_to_monitor is not a list (${typeof repos}); refusing to auto-resolve merge conflicts`);
    }
    return repos as RepoToMonitor[];
}

/** Effective auto-resolve setting for one repository. Throws when repository overrides cannot be read. */
export async function loadEffectiveAutoResolveMergeConflicts(repository: string): Promise<EffectiveAutoResolveMergeConflicts> {
    const [repos, instanceDefault] = await Promise.all([
        loadAutoResolveRepositoryConfigs(),
        loadInstanceAutoResolveMergeConflicts(),
    ]);
    return resolveAutoResolveMergeConflicts({ repos, repository, instanceDefault });
}
