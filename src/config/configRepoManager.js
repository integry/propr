import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';

const CONFIG_REPO_URL = process.env.CONFIG_REPO || 'https://github.com/integry/gitfix-config.git';
const LOCAL_CONFIG_PATH = process.env.CONFIG_REPO_PATH || path.join(process.cwd(), '.config_repo');
const CONFIG_FILE_PATH = path.join(LOCAL_CONFIG_PATH, 'config.json');

export async function cloneOrPullConfigRepo() {
    try {
        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);

        if (await fs.pathExists(LOCAL_CONFIG_PATH)) {
            const git = simpleGit(LOCAL_CONFIG_PATH);
            try {
                // Update remote URL with fresh token before pulling
                await git.remote(['set-url', 'origin', authenticatedUrl]);
                // Fetch latest changes and reset to match remote (discard any local changes)
                // This ensures the local config always matches the remote
                await git.fetch('origin', 'main');
                await git.reset(['--hard', 'origin/main']);
                logger.info('Config repository updated successfully');
            } catch (pullError) {
                // If pull fails (e.g., no remote branch yet, auth issues, conflicts), log a warning
                // but continue - we'll use the existing local config
                logger.warn({ error: pullError.message }, 'Failed to pull config repository, using local version. Check authentication or network connectivity.');
            }
        } else {
            try {
                await simpleGit().clone(authenticatedUrl, LOCAL_CONFIG_PATH);
                logger.info('Config repository cloned successfully');
            } catch (cloneError) {
                // If clone fails because repo doesn't exist, create it locally
                if (cloneError.message.includes('Repository not found') || cloneError.message.includes('not found')) {
                    await fs.ensureDir(LOCAL_CONFIG_PATH);
                    const git = simpleGit(LOCAL_CONFIG_PATH);
                    await git.init();
                    await git.addRemote('origin', authenticatedUrl);
                    logger.info('Initialized new config repository locally');
                } else {
                    throw cloneError;
                }
            }
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to clone or pull config repository');
        throw error;
    }
}

export async function loadFollowupKeywords() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        const keywords = config.followup_keywords || [];
        
        logger.info({ followup_keywords: keywords }, 'Successfully loaded followup keywords');
        return keywords;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load followup keywords from config');
        throw error;
    }
}

export async function loadMonitoredRepos() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        let reposToMonitor = config.repos_to_monitor || [];

        if (reposToMonitor.length > 0 && typeof reposToMonitor[0] === 'string') {
            reposToMonitor = reposToMonitor.map(repo => ({ name: repo, enabled: true }));
        }

        const repos = reposToMonitor.filter(repo => repo.enabled).map(repo => repo.name);
        
        logger.info({ repos_to_monitor: repos, total_configured: reposToMonitor.length }, 'Successfully loaded enabled monitored repositories');
        return repos;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load monitored repositories from config');
        throw error;
    }
}

export async function saveFollowupKeywords(keywords, commitMessage = 'Update followup keywords via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.followup_keywords = keywords;
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ keywords }, 'Successfully saved and pushed followup keywords');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save followup keywords');
        throw error;
    }
}

export async function saveMonitoredRepos(repos, commitMessage = 'Update monitored repositories via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.repos_to_monitor = repos;
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ repos }, 'Successfully saved and pushed monitored repositories');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save monitored repositories');
        throw error;
    }
}

export async function ensureConfigRepoExists() {
    try {
        await cloneOrPullConfigRepo();

        if (!await fs.pathExists(CONFIG_FILE_PATH)) {
            const initialConfig = {
                repos_to_monitor: []
            };

            await fs.writeJson(CONFIG_FILE_PATH, initialConfig, { spaces: 2 });

            const git = simpleGit(LOCAL_CONFIG_PATH);

            // Configure git user for commits
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');

            await git.add('config.json');
            await git.commit('Initialize config.json');

            const authToken = await getGitHubInstallationToken();
            const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
            await git.push(authenticatedUrl, 'main');
            
            logger.info('Initialized config.json in config repository');
        }
        
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to ensure config repo exists');
        throw error;
    }
}

export async function loadSettings() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        const settings = config.settings || {};
        
        logger.info({ settings }, 'Successfully loaded settings from config repo');
        return settings;
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load settings from config repo, returning empty object.');
        return {};
    }
}

export async function loadPrLabel() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        const prLabel = config.pr_label !== undefined ? config.pr_label : (process.env.PR_LABEL || 'gitfix');
        
        logger.info({ pr_label: prLabel }, 'Successfully loaded PR label');
        return prLabel;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load PR label from config');
        throw error;
    }
}

export async function savePrLabel(prLabel, commitMessage = 'Update PR label via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.pr_label = prLabel;
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ pr_label: prLabel }, 'Successfully saved and pushed PR label');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save PR label');
        throw error;
    }
}

export async function saveSettings(settings, commitMessage = 'Update settings via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.settings = { ...(config.settings || {}), ...settings };
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ settings }, 'Successfully saved and pushed settings');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save settings');
        throw error;
    }
}

export async function loadAiPrimaryTag() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        const aiPrimaryTag = config.ai_primary_tag !== undefined ? config.ai_primary_tag : (process.env.AI_PRIMARY_TAG || 'AI');
        
        logger.info({ ai_primary_tag: aiPrimaryTag }, 'Successfully loaded AI primary tag');
        return aiPrimaryTag;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load AI primary tag from config');
        throw error;
    }
}

export async function saveAiPrimaryTag(aiPrimaryTag, commitMessage = 'Update AI primary tag via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.ai_primary_tag = aiPrimaryTag;
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ ai_primary_tag: aiPrimaryTag }, 'Successfully saved and pushed AI primary tag');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save AI primary tag');
        throw error;
    }
}

export async function loadPrimaryProcessingLabels() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        let primaryLabels = config.primary_processing_labels;
        
        if (primaryLabels && Array.isArray(primaryLabels)) {
            logger.info({ primary_processing_labels: primaryLabels }, 'Successfully loaded primary processing labels');
            return primaryLabels;
        }
        
        const envLabels = process.env.PRIMARY_PROCESSING_LABELS;
        if (envLabels) {
            primaryLabels = envLabels.split(',').map(l => l.trim()).filter(l => l);
            logger.info({ primary_processing_labels: primaryLabels }, 'Using primary processing labels from environment');
            return primaryLabels;
        }
        
        logger.info('No primary processing labels found, using default: [AI]');
        return ['AI'];
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load primary processing labels from config');
        throw error;
    }
}

export async function savePrimaryProcessingLabels(primaryLabels, commitMessage = 'Update primary processing labels via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.primary_processing_labels = Array.isArray(primaryLabels) ? primaryLabels : primaryLabels.split(',').map(l => l.trim()).filter(l => l);
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch {
            // Ignore git config errors
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ primary_processing_labels: config.primary_processing_labels }, 'Successfully saved and pushed primary processing labels');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save primary processing labels');
        throw error;
    }
}
