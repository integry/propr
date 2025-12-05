import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    cleanupWorktree,
    cleanupExpiredWorktrees,
    setupWorktreePermissions,
    addToSafeDirectories,
    getWorktreePath
} from './worktreeOperations.js';
import { cleanupExistingBranch, createWorktreeFromExistingBranch } from './worktreeCreation.js';
import { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch } from './repoBranching.js';
import { commitChanges } from './commitOperations.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

async function getRepoPath(owner, repoName) {
    return path.join(CLONES_BASE_PATH, owner, repoName);
}

function getRepoConfigKey(owner, repoName) {
    const cleanOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const cleanRepoName = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return `GIT_DEFAULT_BRANCH_${cleanOwner}_${cleanRepoName}`;
}

async function detectDefaultBranch(git, owner, repoName, octokit = null) {
    const repoConfigKey = getRepoConfigKey(owner, repoName);
    const repoSpecificBranch = process.env[repoConfigKey];

    if (repoSpecificBranch) {
        try {
            await git.revparse([`origin/${repoSpecificBranch}`]);
            logger.info({ repo: `${owner}/${repoName}`, defaultBranch: repoSpecificBranch, configKey: repoConfigKey }, 'Using repository-specific default branch from environment configuration');
            return repoSpecificBranch;
        } catch (branchError) {
            logger.warn({ repo: `${owner}/${repoName}`, configuredBranch: repoSpecificBranch, configKey: repoConfigKey, error: branchError.message }, 'Repository-specific configured branch does not exist, falling back to detection methods');
        }
    }

    if (octokit) {
        try {
            const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName });
            const defaultBranch = repoInfo.data.default_branch;
            if (defaultBranch) {
                logger.info({ repo: `${owner}/${repoName}`, defaultBranch }, 'Detected default branch from GitHub API');
                return defaultBranch;
            }
        } catch (apiError) {
            logger.debug({ repo: `${owner}/${repoName}`, error: apiError.message }, 'Failed to detect default branch from GitHub API');
        }
    }

    try {
        const remoteShow = await git.raw(['remote', 'show', 'origin']);
        const headBranchMatch = remoteShow.match(/HEAD branch: (.+)/);
        if (headBranchMatch) {
            const defaultBranch = headBranchMatch[1].trim();
            logger.debug({ repo: `${owner}/${repoName}`, defaultBranch }, 'Detected default branch from remote HEAD');
            return defaultBranch;
        }
    } catch (error) {
        logger.debug({ repo: `${owner}/${repoName}`, error: error.message }, 'Failed to detect default branch from remote show');
    }

    try {
        const symbolicRef = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
        const branchMatch = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
        if (branchMatch) {
            const defaultBranch = branchMatch[1].trim();
            logger.debug({ repo: `${owner}/${repoName}`, defaultBranch }, 'Detected default branch from symbolic-ref');
            return defaultBranch;
        }
    } catch (error) {
        logger.debug({ repo: `${owner}/${repoName}`, error: error.message }, 'Failed to detect default branch from symbolic-ref');
    }

    const commonBranches = [process.env.GIT_FALLBACK_BRANCH || 'main', 'main', 'master', 'develop', 'dev', 'trunk'];

    for (const branch of commonBranches) {
        try {
            await git.revparse([`origin/${branch}`]);
            logger.info({ repo: `${owner}/${repoName}`, defaultBranch: branch }, `Using branch '${branch}' as default (found in common branches)`);
            return branch;
        } catch {
            logger.debug({ repo: `${owner}/${repoName}`, branch }, `Branch '${branch}' not found`);
        }
    }

    try {
        const remoteBranches = await git.branch(['-r']);
        const firstBranch = remoteBranches.all
            .filter(branch => branch.startsWith('origin/') && !branch.includes('HEAD'))
            .map(branch => branch.replace('origin/', ''))
            .find(branch => branch);

        if (firstBranch) {
            logger.warn({ repo: `${owner}/${repoName}`, defaultBranch: firstBranch }, `Using first available remote branch '${firstBranch}' as fallback`);
            return firstBranch;
        }
    } catch (error) {
        logger.warn({ repo: `${owner}/${repoName}`, error: error.message }, 'Failed to list remote branches');
    }

    throw new Error(`Unable to detect default branch for repository ${owner}/${repoName}`);
}

export async function ensureRepoCloned(repoUrl, owner, repoName, authToken) {
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository exists locally. Validating and fetching updates...');

            try {
                const git = simpleGit(localRepoPath);
                const isRepo = await git.checkIsRepo();

                if (!isRepo) throw new Error('Directory exists but is not a valid git repository');

                await setupAuthenticatedRemote(git, repoUrl, authToken);
                await git.fetch(['origin', '--prune']);
            } catch (gitError) {
                logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath, error: gitError.message }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
                await fs.remove(localRepoPath);
                return ensureRepoCloned(repoUrl, owner, repoName, authToken);
            }

            const git = simpleGit(localRepoPath);
            const defaultBranch = await detectDefaultBranch(git, owner, repoName);

            try {
                await git.checkout(defaultBranch);
                logger.info({ repo: `${owner}/${repoName}`, defaultBranch }, 'Checked out default branch in main repository');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, defaultBranch, error: checkoutError.message }, 'Failed to checkout default branch, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository updated successfully');

        } else {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Cloning repository...');

            await fs.ensureDir(localRepoPath);

            const cloneOptions = [];
            if (GIT_SHALLOW_CLONE_DEPTH) cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);

            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);

            const git = simpleGit();
            await git.clone(authenticatedUrl, localRepoPath, cloneOptions);

            const repoGit = simpleGit(localRepoPath);
            try {
                await repoGit.raw(['remote', 'set-head', 'origin', '--auto']);
                logger.debug({ repo: `${owner}/${repoName}` }, 'Set remote HEAD to auto-detect default branch');
            } catch (headError) {
                logger.debug({ repo: `${owner}/${repoName}`, error: headError.message }, 'Failed to set remote HEAD, continuing anyway');
            }

            const defaultBranch = await detectDefaultBranch(repoGit, owner, repoName);

            try {
                await repoGit.checkout(defaultBranch);
                logger.info({ repo: `${owner}/${repoName}`, defaultBranch }, 'Checked out default branch in main repository after clone');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, defaultBranch, error: checkoutError.message }, 'Failed to checkout default branch after clone, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath, shallow: !!GIT_SHALLOW_CLONE_DEPTH }, 'Repository cloned successfully');
        }

        return localRepoPath;

    } catch (error) {
        handleError(error, `Failed to clone/fetch repository ${owner}/${repoName}`);
        throw error;
    }
}

function parseRepoKeyParts(parts) {
    let ownerParts = [];
    let repoParts = [];
    let foundSeparator = false;

    for (let i = 0; i < parts.length; i++) {
        if (!foundSeparator) {
            ownerParts.push(parts[i]);
            if (i > 0 && parts.length > i + 1) {
                foundSeparator = true;
                repoParts = parts.slice(i + 1);
                break;
            }
        }
    }

    if (!foundSeparator && parts.length === 2) {
        ownerParts = [parts[0]];
        repoParts = [parts[1]];
    }

    return { ownerParts, repoParts };
}

function processEnvKeyForConfig(key, prefix, configs) {
    const repoKey = key.substring(prefix.length);
    const parts = repoKey.split('_');

    if (parts.length < 2) return;

    const { ownerParts, repoParts } = parseRepoKeyParts(parts);

    if (ownerParts.length > 0 && repoParts.length > 0) {
        const owner = ownerParts.join('_').toLowerCase();
        const repo = repoParts.join('_').toLowerCase();
        const branch = process.env[key];

        configs[`${owner}/${repo}`] = { owner, repo, branch, envKey: key };
    }
}

export function listRepositoryBranchConfigurations() {
    const configs = {};
    const prefix = 'GIT_DEFAULT_BRANCH_';

    Object.keys(process.env).forEach(key => {
        if (key.startsWith(prefix)) {
            processEnvKeyForConfig(key, prefix, configs);
        }
    });

    return configs;
}

export async function createWorktreeForIssue(localRepoPath, issueInfo, options = {}) {
    const { issueId, issueTitle, owner, repoName } = issueInfo;
    const { baseBranch = null, octokit = null, modelName = null } = options;

    const sanitizedTitle = issueTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 25);
    const randomString = Math.random().toString(36).substring(2, 5);
    const now = new Date();
    const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    const modelSuffix = modelName ? `-${modelName}` : '';
    const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
    const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);

    try {
        const git = simpleGit(localRepoPath);

        if (await fs.pathExists(worktreePath)) {
            logger.warn({ worktreePath, issueId }, 'Worktree path already exists. Removing existing worktree...');
            await cleanupWorktree(localRepoPath, worktreePath, branchName);
        }

        await fs.ensureDir(path.dirname(worktreePath));

        let resolvedBaseBranch = baseBranch;
        if (!resolvedBaseBranch) {
            resolvedBaseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            logger.info({ repo: `${owner}/${repoName}`, detectedBranch: resolvedBaseBranch }, 'Auto-detected default branch');
        } else {
            try {
                await git.revparse([`origin/${resolvedBaseBranch}`]);
                logger.info({ repo: `${owner}/${repoName}`, specifiedBranch: resolvedBaseBranch }, 'Using specified base branch');
            } catch (branchError) {
                logger.warn({ repo: `${owner}/${repoName}`, specifiedBranch: resolvedBaseBranch, error: branchError.message }, 'Specified branch not found, detecting default branch');
                resolvedBaseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            }
        }

        logger.info({ localRepoPath, worktreePath, branchName, baseBranch: resolvedBaseBranch, issueId }, 'Creating Git worktree...');

        try {
            await git.raw(['worktree', 'prune']);
            logger.debug('Pruned stale worktree references');
        } catch (pruneError) {
            logger.debug({ error: pruneError.message }, 'Failed to prune worktrees, continuing');
        }

        await cleanupExistingBranch(git, branchName);
        await git.fetch('origin', resolvedBaseBranch);
        logger.debug({ baseBranch: resolvedBaseBranch }, 'Fetched latest changes for base branch');

        await git.raw(['worktree', 'add', worktreePath, '-b', branchName, `origin/${resolvedBaseBranch}`]);
        await setupWorktreePermissions(worktreePath, branchName, issueId);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId });

        logger.info({ worktreePath, branchName, issueId }, 'Git worktree created successfully');

        return { worktreePath, branchName };

    } catch (error) {
        handleError(error, `Failed to create worktree for issue ${issueId}`);
        throw error;
    }
}

export function getRepoUrl(issue) {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

export { cleanupWorktree, cleanupExpiredWorktrees, createWorktreeFromExistingBranch, ensureBranchAndPush, pushBranch, commitChanges };
