import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadMonitoredRepos, loadMonitoredReposRaw, loadSettings, loadAiPrimaryTag, loadPrimaryProcessingLabels } from '../config/configManager.js';
import { invalidateSettingsCache } from '../services/relevance/keywordExtractor.js';

interface Settings {
    github_user_whitelist?: string[];
    worker_concurrency?: number;
    analysis_model_fast?: string;
    [key: string]: unknown;
}

let AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG ?? 'AI';
let primaryProcessingLabels: string[] = [];
let monitoredRepos: string[] = [];
let GITHUB_USER_WHITELIST: string[] = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u);
let GITHUB_BOT_USERNAME: string | undefined = process.env.GITHUB_BOT_USERNAME;

export function getReposFromEnv(environment: NodeJS.ProcessEnv = process.env): string[] {
    const configuredRepos = environment.GITHUB_REPOS_TO_MONITOR;
    if (!configuredRepos) return [];
    return configuredRepos.split(',').map(r => r.trim()).filter(r => r);
}

export function getRepos(): string[] {
    return monitoredRepos;
}

export function isMonitoredRepository(repository: string, repos: readonly string[] = monitoredRepos): boolean {
    const normalizedRepository = repository.trim().toLowerCase();
    return normalizedRepository.length > 0
        && repos.some(configured => configured.trim().toLowerCase() === normalizedRepository);
}

/**
 * Returns whether automatic failed-CI follow-up is enabled for a repository.
 * Missing or malformed options are treated as disabled so legacy repository
 * configurations cannot opt into autonomous follow-up work after an upgrade.
 */
export async function isAutoCiFollowupEnabledForRepository(
    owner: string,
    repo: string,
    loadConfiguredRepos: typeof loadMonitoredReposRaw = loadMonitoredReposRaw,
): Promise<boolean> {
    return isRepositoryOptionEnabled({ owner, repo, option: 'autoFollowupOnFailedCi', description: 'automatic CI follow-up' }, loadConfiguredRepos);
}

/**
 * Returns whether obsolete pull request validation may be cancelled while a
 * follow-up implementation runs for a repository. Defaults to disabled so CI
 * behaviour never changes for a repository that did not opt in.
 */
export async function isCancelCiDuringFollowupEnabledForRepository(
    owner: string,
    repo: string,
    loadConfiguredRepos: typeof loadMonitoredReposRaw = loadMonitoredReposRaw,
): Promise<boolean> {
    return isRepositoryOptionEnabled({ owner, repo, option: 'cancelCiDuringFollowup', description: 'follow-up CI cancellation' }, loadConfiguredRepos);
}

/**
 * The validation workflows an operator selected for a repository, which are the
 * only workflows follow-up CI cancellation may ever cancel. Branch-specific
 * entries share a repository name, so every entry's selection counts.
 *
 * Returns null when the configuration could not be read at all. That is not an
 * empty selection: a repository whose stored selection is unknown must not have
 * any other workflow cancelled on its behalf, so the caller skips cancellation
 * instead of falling back to the environment allowlist.
 */
export async function getCancelCiDuringFollowupWorkflowsForRepository(
    owner: string,
    repo: string,
    loadConfiguredRepos: typeof loadMonitoredReposRaw = loadMonitoredReposRaw,
): Promise<string[] | null> {
    const repository = `${owner.trim()}/${repo.trim()}`.toLowerCase();
    if (repository === '/') return null;

    try {
        const configuredRepos = await loadConfiguredRepos();
        const selected: string[] = [];
        for (const candidate of configuredRepos) {
            if (candidate.name.trim().toLowerCase() !== repository) continue;
            for (const workflow of candidate.cancelCiDuringFollowupWorkflows ?? []) {
                const normalized = String(workflow ?? '').trim();
                if (normalized && !selected.some(entry => entry.toLowerCase() === normalized.toLowerCase())) {
                    selected.push(normalized);
                }
            }
        }
        return selected;
    } catch (error) {
        const err = error as Error;
        logger.warn({ repository, error: err.message },
            'Failed to load the follow-up CI cancellation workflow selection; cancelling nothing until it can be read');
        return null;
    }
}

async function isRepositoryOptionEnabled(
    params: {
        owner: string;
        repo: string;
        option: 'autoFollowupOnFailedCi' | 'cancelCiDuringFollowup';
        description: string;
    },
    loadConfiguredRepos: typeof loadMonitoredReposRaw,
): Promise<boolean> {
    const { owner, repo, option, description } = params;
    const repository = `${owner.trim()}/${repo.trim()}`.toLowerCase();
    if (repository === '/') return false;

    try {
        const configuredRepos = await loadConfiguredRepos();
        // Branch-specific entries can share a repository name. Treat the option
        // as enabled when any matching entry explicitly opts in so the result is
        // independent of configuration order while the UI keeps those entries
        // synchronized on subsequent writes.
        return configuredRepos.some(candidate =>
            candidate.name.trim().toLowerCase() === repository
            && candidate[option] === true
        );
    } catch (error) {
        const err = error as Error;
        logger.warn({ repository, error: err.message }, `Failed to load ${description} repository configuration; treating it as disabled`);
        return false;
    }
}

export async function resolveMonitoredRepositories(
    environment: NodeJS.ProcessEnv = process.env,
    loadPersisted: () => Promise<string[]> = loadMonitoredRepos,
): Promise<string[]> {
    const environmentRepos = getReposFromEnv(environment);
    return environment.CONFIG_REPO || environmentRepos.length === 0
        ? loadPersisted()
        : environmentRepos;
}

export function getAiPrimaryTag(): string {
    return AI_PRIMARY_TAG;
}

export function getPrimaryProcessingLabels(): string[] {
    return primaryProcessingLabels;
}

export function getUserWhitelist(): string[] {
    if (!process.env.CONFIG_REPO) {
        return (process.env.GITHUB_USER_WHITELIST ?? '')
            .split(',')
            .map(user => user.trim())
            .filter(Boolean);
    }
    return GITHUB_USER_WHITELIST;
}

export function getBotUsername(): string | undefined {
    return GITHUB_BOT_USERNAME;
}

export async function detectBotUsername(): Promise<string> {
    if (GITHUB_BOT_USERNAME) return GITHUB_BOT_USERNAME;

    try {
        const octokit = await getAuthenticatedOctokit();
        const { data: installation } = await octokit.request('GET /installation');
        GITHUB_BOT_USERNAME = `${(installation as { app_slug: string }).app_slug}[bot]`;
        logger.info({ botUsername: GITHUB_BOT_USERNAME }, 'Auto-detected bot username');
        return GITHUB_BOT_USERNAME;
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to auto-detect bot username, will use default');
        GITHUB_BOT_USERNAME = 'propr-dev[bot]';
        return GITHUB_BOT_USERNAME;
    }
}

export async function loadReposFromConfig(): Promise<void> {
    try {
        const usesPersistedConfiguration = !!process.env.CONFIG_REPO || getReposFromEnv().length === 0;
        monitoredRepos = await resolveMonitoredRepositories();
        if (usesPersistedConfiguration) {
            logger.info({ repos: monitoredRepos }, 'Successfully loaded monitored repositories from persisted configuration');
        } else {
            logger.info({ repos: monitoredRepos }, 'Using repositories from environment variable');
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to load repositories from config, falling back to environment variable');
        monitoredRepos = getReposFromEnv();
    }
}

export async function loadSettingsFromConfig(): Promise<void> {
    invalidateSettingsCache();
    try {
        if (process.env.CONFIG_REPO) {
            const settings: Settings = await loadSettings();

            if (settings.github_user_whitelist && Array.isArray(settings.github_user_whitelist)) {
                GITHUB_USER_WHITELIST = settings.github_user_whitelist;
                process.env.GITHUB_USER_WHITELIST = settings.github_user_whitelist.join(',');
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Successfully loaded github_user_whitelist from config repo');
            } else if (process.env.GITHUB_USER_WHITELIST) {
                GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u);
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Using github_user_whitelist from environment variable');
            }
        }
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load settings from config, using environment variable');
    }
}

export async function loadAiPrimaryTagFromConfig(): Promise<void> {
    try {
        if (process.env.CONFIG_REPO) {
            AI_PRIMARY_TAG = await loadAiPrimaryTag();
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Successfully loaded ai_primary_tag from config repo');
        } else if (process.env.AI_PRIMARY_TAG) {
            AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG;
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Using ai_primary_tag from environment variable');
        }
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load ai_primary_tag from config, using default or environment variable');
        AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG ?? 'AI';
    }
}

export async function loadPrimaryProcessingLabelsFromConfig(): Promise<void> {
    try {
        if (process.env.CONFIG_REPO) {
            primaryProcessingLabels = await loadPrimaryProcessingLabels();
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Successfully loaded primary_processing_labels from config repo');
        } else if (process.env.PRIMARY_PROCESSING_LABELS) {
            primaryProcessingLabels = process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using primary_processing_labels from environment variable');
        } else {
            primaryProcessingLabels = [AI_PRIMARY_TAG];
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using AI_PRIMARY_TAG as default primary processing label');
        }
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load primary_processing_labels from config, using default');
        primaryProcessingLabels = [AI_PRIMARY_TAG ?? 'AI'];
    }
}

export async function loadAllConfigs(): Promise<void> {
    await loadReposFromConfig();
    await loadSettingsFromConfig();
    await loadAiPrimaryTagFromConfig();
    await loadPrimaryProcessingLabelsFromConfig();
    await detectBotUsername();
}

export async function reloadConfigs(): Promise<void> {
    try {
        // Repository configuration is persisted by the standard CLI/UI setup even
        // when no legacy CONFIG_REPO is configured, so it must always be refreshed.
        await loadReposFromConfig();
        // Settings updates must always invalidate the settings cache. Loading the
        // legacy repository-backed values remains conditional inside this function.
        await loadSettingsFromConfig();
        if (process.env.CONFIG_REPO) {
            await loadAiPrimaryTagFromConfig();
            await loadPrimaryProcessingLabelsFromConfig();
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to reload config');
    }
}
