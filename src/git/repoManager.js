import simpleGit from 'simple-git'; 
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import {
    cleanupWorktree,
    cleanupExpiredWorktrees,
    setupWorktreePermissions,
    addToSafeDirectories,
    verifyWorktreeCreation,
    setupWorktreeRemote,
    getWorktreePath
} from './worktreeOperations.js';

async function setupAuthenticatedRemote(git, repoUrl, authToken) {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    await git.remote(['set-url', 'origin', authenticatedUrl]);
}

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

async function getRepoPath(owner, repoName) {
    return path.join(CLONES_BASE_PATH, owner, repoName);
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
    
    const sanitizedTitle = issueTitle
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 25);
    
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

async function removeWorktreeForBranch(git, worktreeLines, branchName) {
    for (let i = 0; i < worktreeLines.length; i++) {
        const line = worktreeLines[i];
        if (!line.startsWith('worktree ')) continue;
        
        const wtPath = line.substring('worktree '.length);
        const branchLine = worktreeLines[i + 1];
        const isBranchMatch = branchLine && 
            branchLine.startsWith('branch ') && 
            branchLine.substring('branch refs/heads/'.length) === branchName;
        
        if (isBranchMatch) {
            logger.info({ worktreePath: wtPath, branchName }, 'Removing existing worktree for branch');
            try {
                await git.raw(['worktree', 'remove', wtPath, '--force']);
            } catch (removeError) {
                logger.warn({ worktreePath: wtPath, error: removeError.message }, 'Failed to remove existing worktree');
            }
        }
    }
}

async function cleanupExistingBranch(git, branchName) {
    try {
        await git.revparse([branchName]);
        logger.info({ branchName }, 'Branch already exists, will delete and recreate');
        
        try {
            const worktreeList = await git.raw(['worktree', 'list', '--porcelain']);
            const worktreeLines = worktreeList.split('\n');
            await removeWorktreeForBranch(git, worktreeLines, branchName);
        } catch (listError) {
            logger.debug({ error: listError.message }, 'Failed to list worktrees');
        }
        
        try {
            await git.branch(['-D', branchName]);
            logger.info({ branchName }, 'Deleted existing branch');
        } catch (deleteError) {
            logger.warn({ branchName, error: deleteError.message }, 'Failed to delete existing branch, continuing anyway');
        }
    } catch {
        logger.debug({ branchName }, 'Branch does not exist, will create new one');
    }
}

export function getRepoUrl(issue) {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

export async function commitChanges(worktreePath, commitMessage, author, options = {}) {
    const { issueNumber, issueTitle } = options;
    try {
        const gitPath = path.join(worktreePath, '.git');
        const worktreeExists = await fs.pathExists(worktreePath);
        const gitExists = await fs.pathExists(gitPath);
        
        if (!worktreeExists) throw new Error(`Worktree path does not exist: ${worktreePath}`);
        if (!gitExists) throw new Error(`Not a git repository (or any of the parent directories): ${worktreePath}`);
        
        const gitStats = await fs.stat(gitPath);
        if (gitStats.isDirectory()) {
            logger.warn({ worktreePath, gitPath, issueNumber }, '.git is a directory, not a worktree file - this suggests improper worktree creation');
        } else if (gitStats.isFile()) {
            const gitFileContent = await fs.readFile(gitPath, 'utf8');
            logger.debug({ worktreePath, gitPath, gitFileContent: gitFileContent.trim(), issueNumber }, 'Validated worktree .git file');
        }
    } catch (validationError) {
        logger.error({ worktreePath, issueNumber, error: validationError.message }, 'Worktree validation failed');
        throw validationError;
    }
    
    const git = simpleGit({ baseDir: worktreePath });
    logger.debug({ worktreePath, issueNumber }, 'Initializing git operations in worktree');
    
    try {
        if (author) {
            try {
                await git.raw(['config', 'user.name', author.name]);
                await git.raw(['config', 'user.email', author.email]);
                logger.debug({ worktreePath, author, issueNumber }, 'Set git author config using raw commands');
            } catch (configError) {
                logger.warn({ worktreePath, error: configError.message, issueNumber }, 'Failed to set local git config, continuing without author config');
            }
        }
        
        await git.add('.');
        const status = await git.status();
        
        logger.debug({
            worktreePath,
            issueNumber,
            tracked: status.tracked?.length || 0,
            notAdded: status.not_added?.length || 0,
            conflicted: status.conflicted?.length || 0,
            created: status.created?.length || 0,
            deleted: status.deleted?.length || 0,
            modified: status.modified?.length || 0,
            renamed: status.renamed?.length || 0,
            staged: status.staged?.length || 0,
            totalFiles: status.files?.length || 0
        }, 'Git status before commit');
        
        if (status.files.length === 0) {
            logger.info({ worktreePath }, 'No changes to commit');
            return null;
        }
        
        logger.info({
            worktreePath,
            issueNumber,
            totalFiles: status.files.length,
            files: status.files.map(f => ({ path: f.path, index: f.index, working_dir: f.working_dir }))
        }, 'Files to be committed');
        
        let finalCommitMessage;
        if (typeof commitMessage === 'object' && commitMessage.claudeSuggested) {
            finalCommitMessage = commitMessage.claudeSuggested;
        } else if (typeof commitMessage === 'string') {
            finalCommitMessage = commitMessage;
        } else {
            const shortTitle = issueTitle ? issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
            finalCommitMessage = `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}\n\nImplemented by Claude Code. Full conversation log in PR comment.`;
        }
        
        const result = await git.commit(finalCommitMessage);
        const commitHash = result.commit.replace(/^HEAD\s+/, '');
        
        logger.info({ worktreePath, commitHash, filesChanged: status.files.length, issueNumber, commitMessage: finalCommitMessage }, 'Changes committed successfully');
        
        return { commitHash, commitMessage: finalCommitMessage };
        
    } catch (error) {
        handleError(error, `Failed to commit changes in worktree ${worktreePath}`);
        throw error;
    }
}

export async function ensureBranchAndPush(worktreePath, branchName, baseBranch, options = {}) {
    const { repoUrl, authToken, tokenRefreshFn, correlationId } = options;
    
    const pushOperation = async (currentToken) => {
        const git = simpleGit({ baseDir: worktreePath });
        
        if (repoUrl && currentToken) await setupAuthenticatedRemote(git, repoUrl, currentToken);
        
        logger.info({ worktreePath, branchName, baseBranch }, 'Ensuring branch is properly set up and pushed...');
        
        const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
        const actualBranch = currentBranch.trim();
        
        if (actualBranch !== branchName) throw new Error(`Expected to be on branch '${branchName}' but currently on '${actualBranch}'`);
        
        try {
            const diffResult = await git.raw(['diff', '--name-only', `origin/${baseBranch}...HEAD`]);
            if (!diffResult.trim()) {
                logger.warn({ branchName, baseBranch }, 'No changes detected between branch and base');
            } else {
                const changedFiles = diffResult.trim().split('\n').filter(f => f);
                logger.info({ branchName, baseBranch, changedFiles: changedFiles.length }, 'Changes detected, proceeding with push');
            }
        } catch (diffError) {
            logger.debug({ error: diffError.message }, 'Could not check diff, proceeding anyway');
        }
        
        await git.push(['--set-upstream', 'origin', branchName]);
        logger.info({ branchName, baseBranch, worktreePath }, 'Branch successfully pushed to remote');
    };
    
    try {
        let currentToken = authToken;
        
        await withRetry(
            async () => {
                try {
                    await pushOperation(currentToken);
                } catch (error) {
                    if (tokenRefreshFn && (error.message.includes('Authentication failed') || error.message.includes('Invalid username or token'))) {
                        logger.info({ correlationId, worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');
                        
                        try {
                            const refreshedToken = await tokenRefreshFn();
                            if (refreshedToken && refreshedToken !== currentToken) {
                                currentToken = refreshedToken;
                                logger.info({ correlationId }, 'Token refreshed successfully, retrying push');
                            }
                        } catch (refreshError) {
                            logger.error({ correlationId, error: refreshError.message }, 'Failed to refresh token');
                        }
                    }
                    throw error;
                }
            },
            { ...retryConfigs.gitPush, correlationId },
            `Git push for branch ${branchName}`
        );
        
    } catch (error) {
        logger.error({ error: error.message, branchName, baseBranch, worktreePath }, 'Failed to ensure branch and push');
        throw error;
    }
}

export async function createWorktreeFromExistingBranch(localRepoPath, branchName, options = {}) {
    const { worktreeDirName, owner, repoName } = options;
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);
    
    try {
        const git = simpleGit(localRepoPath);
        
        if (await fs.pathExists(worktreePath)) {
            await handleExistingWorktreePath(worktreePath, localRepoPath, branchName);
        }
        
        await fs.ensureDir(path.dirname(worktreePath));
        
        logger.info({ localRepoPath, worktreePath, branchName }, 'Creating Git worktree from existing branch...');
        
        await git.fetch('origin', branchName);
        logger.debug({ branchName }, 'Fetched latest changes for branch');
        
        await createWorktreeFromRemote(git, worktreePath, branchName, localRepoPath);
        
        await verifyWorktreeCreation(worktreePath);
        await setupWorktreePermissions(worktreePath, branchName, null);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId: null });
        
        const worktreeGit = simpleGit({ baseDir: worktreePath });
        await setupWorktreeRemote(worktreeGit, git, worktreePath);
        
        await verifyFinalWorktreeSetup(worktreeGit, worktreePath, branchName);
        
        return { worktreePath, branchName };
        
    } catch (error) {
        handleError(error, `Failed to create worktree from branch ${branchName}`);
        throw error;
    }
}

async function handleExistingWorktreePath(worktreePath, localRepoPath, branchName) {
    logger.warn({ worktreePath, branchName }, 'Worktree path already exists. Checking if it\'s a valid worktree...');
    
    const gitPath = path.join(worktreePath, '.git');
    let isProperWorktree = false;
    
    if (await fs.pathExists(gitPath)) {
        const stats = await fs.stat(gitPath);
        isProperWorktree = stats.isFile();
    }
    
    if (!isProperWorktree) {
        logger.warn({ worktreePath, gitPath, isDirectory: await fs.pathExists(gitPath) ? (await fs.stat(gitPath)).isDirectory() : false }, 'Not a proper worktree, removing directory directly');
        await fs.remove(worktreePath);
    } else {
        await cleanupWorktree(localRepoPath, worktreePath, branchName);
    }
    
    if (await fs.pathExists(worktreePath)) {
        logger.warn({ worktreePath }, 'Directory still exists after cleanup, forcing removal');
        await fs.remove(worktreePath);
    }
}

async function createWorktreeFromRemote(git, worktreePath, branchName, localRepoPath) {
    try {
        const worktreeMetadataDir = path.join(localRepoPath, '.git', 'worktrees');
        await fs.ensureDir(worktreeMetadataDir);
        
        const mainRepoGitPath = path.join(localRepoPath, '.git');
        if (!await fs.pathExists(mainRepoGitPath)) {
            throw new Error(`Main repository is invalid - no .git found at ${localRepoPath}`);
        }
        
        try {
            const existingWorktrees = await git.raw(['worktree', 'list', '--porcelain']);
            logger.debug({ localRepoPath, existingWorktrees: existingWorktrees.trim() }, 'Current worktrees before adding new one');
        } catch (listError) {
            logger.warn({ error: listError.message }, 'Failed to list existing worktrees');
        }
        
        const worktreeAddResult = await git.raw(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
        logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Git worktree add command completed');
        
    } catch (error) {
        if (error.message && error.message.includes('is already used by worktree')) {
            await handleWorktreeConflict(git, error, worktreePath, branchName);
        } else if (error.message && error.message.includes('.git is a directory')) {
            await handleImproperWorktree(worktreePath, branchName, error);
        } else {
            await handleWorktreeCreationError(git, branchName, error);
        }
    }
}

async function handleWorktreeConflict(git, error, worktreePath, branchName) {
    logger.error({ branchName, error: error.message }, 'Branch is already checked out in another worktree');
    
    const match = error.message.match(/worktree at '([^']+)'/);
    if (match) {
        const existingWorktreePath = match[1];
        logger.info({ branchName, existingWorktreePath, newWorktreePath: worktreePath }, 'Attempting to remove existing worktree to allow new one');
        
        try {
            await git.raw(['worktree', 'remove', existingWorktreePath, '--force']);
            logger.info({ existingWorktreePath }, 'Successfully removed existing worktree');
            
            const worktreeAddResult = await git.raw(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
            logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Successfully created worktree after removing existing one');
        } catch (retryError) {
            logger.error({ branchName, existingWorktreePath, error: retryError.message }, 'Failed to handle existing worktree conflict');
            throw new Error(`Cannot create worktree: branch '${branchName}' is locked by another worktree`);
        }
    } else {
        throw new Error(`Cannot create worktree: branch '${branchName}' is already checked out elsewhere`);
    }
}

async function handleImproperWorktree(worktreePath, branchName, error) {
    logger.error({ branchName, worktreePath, error: error.message }, 'Worktree creation failed - improper structure detected');
    
    try {
        await fs.remove(worktreePath);
        logger.info({ worktreePath }, 'Removed improperly created worktree directory');
    } catch (cleanupError) {
        logger.error({ worktreePath, error: cleanupError.message }, 'Failed to clean up improper worktree directory');
    }
    
    throw error;
}

async function handleWorktreeCreationError(git, branchName, error) {
    logger.error({ branchName, error: error.message }, 'Failed to create worktree from remote branch');
    
    try {
        const remoteBranches = await git.branch(['-r']);
        const remoteBranchExists = remoteBranches.all.includes(`origin/${branchName}`);
        if (!remoteBranchExists) {
            throw new Error(`Cannot create worktree: branch '${branchName}' not found on remote`);
        } else {
            throw new Error(`Cannot create worktree: ${error.message}`);
        }
    } catch {
        throw new Error(`Cannot create worktree: ${error.message}`);
    }
}

async function verifyFinalWorktreeSetup(worktreeGit, worktreePath, branchName) {
    try {
        const finalRemotes = await worktreeGit.getRemotes(true);
        const hasOrigin = finalRemotes.some(r => r.name === 'origin');
        
        if (!hasOrigin) throw new Error('Worktree was created but origin remote is missing');
        
        logger.info({ worktreePath, branchName, remotes: finalRemotes.map(r => ({ name: r.name, url: r.refs.fetch })) }, 'Git worktree created successfully from existing branch with remotes configured');
    } catch (verifyError) {
        logger.error({ worktreePath, error: verifyError.message }, 'Final verification failed - worktree may not be properly configured');
        throw new Error(`Worktree setup incomplete: ${verifyError.message}`);
    }
}

export async function pushBranch(worktreePath, branchName, options = {}) {
    const { repoUrl, authToken, remote = 'origin' } = options;
    
    const performPush = async (token) => {
        if (repoUrl && token) await setupAuthenticatedRemote(git, repoUrl, token);
        
        try {
            const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            logger.debug({ worktreePath, currentBranch: currentBranch.trim(), expectedBranch: branchName }, 'Current branch in worktree');
            
            if (currentBranch.trim() !== branchName) {
                logger.warn({ worktreePath, currentBranch: currentBranch.trim(), expectedBranch: branchName }, 'Branch mismatch detected, attempting to checkout correct branch');
                
                const branches = await git.branchLocal();
                logger.debug({ worktreePath, branchName, branchExists: branches.all.includes(branchName), localBranches: branches.all, currentBranch: branches.current }, 'Checking local branches before checkout');
                
                await git.checkout(branchName);
                
                const newBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
                logger.info({ worktreePath, previousBranch: currentBranch.trim(), newBranch: newBranch.trim(), expectedBranch: branchName, checkoutSuccess: newBranch.trim() === branchName }, 'Branch checkout completed');
            }
        } catch (branchCheckError) {
            logger.warn({ error: branchCheckError.message }, 'Failed to verify current branch, proceeding with push anyway');
        }
        
        await git.push([remote, branchName, '--set-upstream']);
    };
    
    const git = simpleGit({ baseDir: worktreePath });
    
    try {
        await performPush(authToken);
        logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully');
    } catch (error) {
        if (error.message && (error.message.includes('Authentication failed') || error.message.includes('Invalid username or token'))) {
            logger.info({ worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');
            try {
                const freshOctokit = await getAuthenticatedOctokit();
                const freshAuth = await freshOctokit.auth({ type: "installation" });
                await performPush(freshAuth.token);
                logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully after token refresh');
            } catch (retryError) {
                handleError(retryError, `Failed to push branch ${branchName} from worktree ${worktreePath} after token refresh`);
                throw retryError;
            }
        } else {
            handleError(error, `Failed to push branch ${branchName} from worktree ${worktreePath}`);
            throw error;
        }
    }
}

export { cleanupWorktree, cleanupExpiredWorktrees };
