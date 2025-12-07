import { logger } from '@gitfix/core';
import { getAuthenticatedOctokit } from '@gitfix/core';
import { loadMonitoredRepos, loadSettings, loadAiPrimaryTag, loadPrimaryProcessingLabels } from '@gitfix/core';
const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
let AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG ?? 'AI';
let primaryProcessingLabels = [];
let monitoredRepos = [];
let GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u);
let GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
export function getReposFromEnv() {
    if (!GITHUB_REPOS_TO_MONITOR)
        return [];
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
}
export function getRepos() {
    return monitoredRepos;
}
export function getAiPrimaryTag() {
    return AI_PRIMARY_TAG;
}
export function getPrimaryProcessingLabels() {
    return primaryProcessingLabels;
}
export function getUserWhitelist() {
    return GITHUB_USER_WHITELIST;
}
export function getBotUsername() {
    return GITHUB_BOT_USERNAME;
}
export async function detectBotUsername() {
    if (GITHUB_BOT_USERNAME)
        return GITHUB_BOT_USERNAME;
    try {
        const octokit = await getAuthenticatedOctokit();
        const { data: installation } = await octokit.request('GET /installation');
        GITHUB_BOT_USERNAME = `${installation.app_slug}[bot]`;
        logger.info({ botUsername: GITHUB_BOT_USERNAME }, 'Auto-detected bot username');
        return GITHUB_BOT_USERNAME;
    }
    catch (error) {
        const err = error;
        logger.warn({ error: err.message }, 'Failed to auto-detect bot username, will use default');
        GITHUB_BOT_USERNAME = 'gitfixio[bot]';
        return GITHUB_BOT_USERNAME;
    }
}
export async function loadReposFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            monitoredRepos = await loadMonitoredRepos();
            logger.info({ repos: monitoredRepos }, 'Successfully loaded monitored repositories from config repo');
        }
        else {
            monitoredRepos = getReposFromEnv();
            logger.info({ repos: monitoredRepos }, 'Using repositories from environment variable');
        }
    }
    catch (error) {
        const err = error;
        logger.error({ error: err.message }, 'Failed to load repositories from config, falling back to environment variable');
        monitoredRepos = getReposFromEnv();
    }
}
export async function loadSettingsFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            if (settings.github_user_whitelist && Array.isArray(settings.github_user_whitelist)) {
                GITHUB_USER_WHITELIST = settings.github_user_whitelist;
                process.env.GITHUB_USER_WHITELIST = settings.github_user_whitelist.join(',');
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Successfully loaded github_user_whitelist from config repo');
            }
            else if (process.env.GITHUB_USER_WHITELIST) {
                GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u);
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Using github_user_whitelist from environment variable');
            }
        }
    }
    catch (error) {
        const err = error;
        logger.warn({ error: err.message }, 'Failed to load settings from config, using environment variable');
    }
}
export async function loadAiPrimaryTagFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            AI_PRIMARY_TAG = await loadAiPrimaryTag();
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Successfully loaded ai_primary_tag from config repo');
        }
        else if (process.env.AI_PRIMARY_TAG) {
            AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG;
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Using ai_primary_tag from environment variable');
        }
    }
    catch (error) {
        const err = error;
        logger.warn({ error: err.message }, 'Failed to load ai_primary_tag from config, using default or environment variable');
        AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG ?? 'AI';
    }
}
export async function loadPrimaryProcessingLabelsFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            primaryProcessingLabels = await loadPrimaryProcessingLabels();
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Successfully loaded primary_processing_labels from config repo');
        }
        else if (process.env.PRIMARY_PROCESSING_LABELS) {
            primaryProcessingLabels = process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using primary_processing_labels from environment variable');
        }
        else {
            primaryProcessingLabels = [AI_PRIMARY_TAG];
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using AI_PRIMARY_TAG as default primary processing label');
        }
    }
    catch (error) {
        const err = error;
        logger.warn({ error: err.message }, 'Failed to load primary_processing_labels from config, using default');
        primaryProcessingLabels = [AI_PRIMARY_TAG ?? 'AI'];
    }
}
export async function loadAllConfigs() {
    await loadReposFromConfig();
    await loadSettingsFromConfig();
    await loadAiPrimaryTagFromConfig();
    await loadPrimaryProcessingLabelsFromConfig();
    await detectBotUsername();
}
export async function reloadConfigs() {
    try {
        if (process.env.CONFIG_REPO) {
            await loadReposFromConfig();
            await loadSettingsFromConfig();
            await loadAiPrimaryTagFromConfig();
            await loadPrimaryProcessingLabelsFromConfig();
        }
    }
    catch (error) {
        const err = error;
        logger.error({ error: err.message }, 'Failed to reload config');
    }
}
