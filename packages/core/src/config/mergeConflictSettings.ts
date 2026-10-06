import logger from '../utils/logger.js';
import { getConfig } from './configStore.js';
import type { RepoToMonitor } from './configManager.js';

/** Instance-wide default stored as its own `system_configs` row. */
export const AUTO_RESOLVE_MERGE_CONFLICTS_CONFIG_KEY = 'auto_resolve_merge_conflicts';

export type AutoResolveMergeConflictsSource = 'repository' | 'instance';

export interface EffectiveAutoResolveMergeConflicts {
    enabled: boolean;
    /** `repository` when a repository override decided the value, otherwise `instance`. */
    source: AutoResolveMergeConflictsSource;
    /** The stored repository override; `null` means the repository inherits. */
    repositoryOverride: boolean | null;
    instanceDefault: boolean;
}

/**
 * Parses a stored boolean setting. `system_configs.value` is TEXT, so the value
 * may arrive as a boolean, as `"true"`/`"false"`, or JSON-encoded twice
 * (`"\"false\""`). Anything else is not a boolean and yields `null`; a plain
 * truthiness check would turn the string `"false"` into "enabled".
 */
export function parseBooleanSetting(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
}

/**
 * Normalizes a stored repository override. Absent, `null` and unparseable values
 * all mean "inherit the instance default".
 */
export function normalizeAutoResolveMergeConflictsOverride(value: unknown): boolean | null {
    return parseBooleanSetting(value);
}

/**
 * The override is repository-wide: every branch entry of a repository shares it.
 * Names match case-insensitively; the first entry with an explicit value wins
 * until the next synchronized save brings the entries back in line.
 */
export function resolveRepositoryAutoResolveMergeConflictsOverride(
    repos: readonly Pick<RepoToMonitor, 'name' | 'autoResolveMergeConflicts'>[],
    repository: string
): boolean | null {
    const normalizedRepository = repository.trim().toLowerCase();
    if (!normalizedRepository) return null;
    for (const repo of repos) {
        if (typeof repo?.name !== 'string' || repo.name.trim().toLowerCase() !== normalizedRepository) continue;
        const override = normalizeAutoResolveMergeConflictsOverride(repo.autoResolveMergeConflicts);
        if (override !== null) return override;
    }
    return null;
}

/** Repository override when present, otherwise the instance default, otherwise off. */
export function resolveAutoResolveMergeConflicts(options: {
    repos: readonly Pick<RepoToMonitor, 'name' | 'autoResolveMergeConflicts'>[];
    repository: string;
    instanceDefault: unknown;
}): EffectiveAutoResolveMergeConflicts {
    const instanceDefault = parseBooleanSetting(options.instanceDefault) ?? false;
    const repositoryOverride = resolveRepositoryAutoResolveMergeConflictsOverride(options.repos, options.repository);
    return repositoryOverride === null
        ? { enabled: instanceDefault, source: 'instance', repositoryOverride: null, instanceDefault }
        : { enabled: repositoryOverride, source: 'repository', repositoryOverride, instanceDefault };
}

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
