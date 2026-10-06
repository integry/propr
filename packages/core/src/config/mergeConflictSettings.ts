import logger from '../utils/logger.js';
import { getConfig } from './configStore.js';
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

/** Effective auto-resolve setting for one repository. */
export async function loadEffectiveAutoResolveMergeConflicts(repository: string): Promise<EffectiveAutoResolveMergeConflicts> {
    const [repos, instanceDefault] = await Promise.all([
        getConfig<RepoToMonitor[]>('repos_to_monitor', []),
        loadInstanceAutoResolveMergeConflicts(),
    ]);
    return resolveAutoResolveMergeConflicts({ repos: Array.isArray(repos) ? repos : [], repository, instanceDefault });
}
