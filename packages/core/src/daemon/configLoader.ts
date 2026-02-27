import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadMonitoredRepos, loadSettings, loadAiPrimaryTag, loadPrimaryProcessingLabels } from '../config/configManager.js';

interface Settings {
    github_user_whitelist?: string[];
    worker_concurrency?: number;
    analysis_model_fast?: string;
    [key: string]: unknown;
}

const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;

let AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG ?? 'AI';
let primaryProcessingLabels: string[] = [];
let monitoredRepos: string[] = [];
let GITHUB_USER_WHITELIST: string[] = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u);
let GITHUB_BOT_USERNAME: string | undefined = process.env.GITHUB_BOT_USERNAME;

export function getReposFromEnv(): string[] {
    if (!GITHUB_REPOS_TO_MONITOR) return [];
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
}

export function getRepos(): string[] {
    return monitoredRepos;
}

export function getAiPrimaryTag(): string {
    return AI_PRIMARY_TAG;
}

export function getPrimaryProcessingLabels(): string[] {
    return primaryProcessingLabels;
}

export function getUserWhitelist(): string[] {
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
        GITHUB_BOT_USERNAME = 'propr.dev[bot]';
        return GITHUB_BOT_USERNAME;
    }
}

export async function loadReposFromConfig(): Promise<void> {
    try {
        if (process.env.CONFIG_REPO) {
            monitoredRepos = await loadMonitoredRepos();
            logger.info({ repos: monitoredRepos }, 'Successfully loaded monitored repositories from config repo');
        } else {
            monitoredRepos = getReposFromEnv();
            logger.info({ repos: monitoredRepos }, 'Using repositories from environment variable');
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to load repositories from config, falling back to environment variable');
        monitoredRepos = getReposFromEnv();
    }
}

export async function loadSettingsFromConfig(): Promise<void> {
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
        if (process.env.CONFIG_REPO) {
            await loadReposFromConfig();
            await loadSettingsFromConfig();
            await loadAiPrimaryTagFromConfig();
            await loadPrimaryProcessingLabelsFromConfig();
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to reload config');
    }
}
