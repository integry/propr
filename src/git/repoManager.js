import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

/**
 * Sets up authenticated remote URL for a Git repository
 * @param {Object} git - SimpleGit instance
 * @param {string} repoUrl - Base repository URL
 * @param {string} authToken - GitHub authentication token
 * @returns {Promise<void>}
 */
async function setupAuthenticatedRemote(git, repoUrl, authToken) {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    await git.remote(['set-url', 'origin', authenticatedUrl]);
}

// Configuration from environment variables
const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const WORKTREES_BASE_PATH = process.env.GIT_WORKTREES_BASE_PATH || "/tmp/git-processor/worktrees";
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

/**
 * Gets the local path for a repository clone
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<string>} Local repository path
 */
async function getRepoPath(owner, repoName) {
    return path.join(CLONES_BASE_PATH, owner, repoName);
}

/**
 * Ensures a repository is cloned locally and up to date
 * @param {string} repoUrl - Repository URL (e.g., https://github.com/owner/repo.git)
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} authToken - GitHub authentication token
 * @returns {Promise<string>} Local repository path
 */
export async function ensureRepoCloned(repoUrl, owner, repoName, authToken) {
    const localRepoPath = await getRepoPath(owner, repoName);
    
    try {
        // Check if repository already exists
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository exists locally. Validating and fetching updates...');
            
            // Validate that it's a proper git repository
            try {
                const git = simpleGit(localRepoPath);
                const isRepo = await git.checkIsRepo();
                
                if (!isRepo) {
                    throw new Error('Directory exists but is not a valid git repository');
                }
                
                // Set up authentication for fetch
                await setupAuthenticatedRemote(git, repoUrl, authToken);
                
                await git.fetch(['origin', '--prune']);
            } catch (gitError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    path: localRepoPath,
                    error: gitError.message 
                }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
                
                // Remove the corrupted repository
                await fs.remove(localRepoPath);
                
                // Fall through to clone logic
                return ensureRepoCloned(repoUrl, owner, repoName, authToken);
            }
            
            // Re-create git instance after validation
            const git = simpleGit(localRepoPath);
            
            // Ensure we're on the correct default branch in the main repository
            const defaultBranch = await detectDefaultBranch(git, owner, repoName);
            
            try {
                // Check out the default branch to ensure worktrees are created from the correct base
                await git.checkout(defaultBranch);
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch 
                }, 'Checked out default branch in main repository');
            } catch (checkoutError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch,
                    error: checkoutError.message 
                }, 'Failed to checkout default branch, continuing anyway');
            }
            
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository updated successfully');
            
        } else {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Cloning repository...');
            
            // Ensure parent directory exists
            await fs.ensureDir(localRepoPath);
            
            // Prepare clone options
            const cloneOptions = [];
            if (GIT_SHALLOW_CLONE_DEPTH) {
                cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);
            }
            
            // Construct authenticated URL
            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
            
            // Clone the repository
            const git = simpleGit();
            await git.clone(authenticatedUrl, localRepoPath, cloneOptions);
            
            // Set up remote HEAD to point to the actual default branch
            const repoGit = simpleGit(localRepoPath);
            try {
                await repoGit.raw(['remote', 'set-head', 'origin', '--auto']);
                logger.debug({ repo: `${owner}/${repoName}` }, 'Set remote HEAD to auto-detect default branch');
            } catch (headError) {
                logger.debug({ 
                    repo: `${owner}/${repoName}`, 
                    error: headError.message 
                }, 'Failed to set remote HEAD, continuing anyway');
            }
            
            // Ensure we're on the correct default branch in the main repository after clone
            const defaultBranch = await detectDefaultBranch(repoGit, owner, repoName);
            
            try {
                // Check out the default branch to ensure worktrees are created from the correct base
                await repoGit.checkout(defaultBranch);
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch 
                }, 'Checked out default branch in main repository after clone');
            } catch (checkoutError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch,
                    error: checkoutError.message 
                }, 'Failed to checkout default branch after clone, continuing anyway');
            }
            
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath,
                shallow: !!GIT_SHALLOW_CLONE_DEPTH
            }, 'Repository cloned successfully');
        }
        
        return localRepoPath;
        
    } catch (error) {
        handleError(error, `Failed to clone/fetch repository ${owner}/${repoName}`);
        throw error;
    }
}

/**
 * Gets the environment variable key for repository-specific default branch configuration
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {string} Environment variable key
 */
function getRepoConfigKey(owner, repoName) {
    // Convert to uppercase and replace any special characters with underscores
    const cleanOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const cleanRepoName = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return `GIT_DEFAULT_BRANCH_${cleanOwner}_${cleanRepoName}`;
}

/**
 * Detects the default branch of a repository
 * @param {Object} git - Simple-git instance
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {Object} octokit - GitHub API client (optional)
 * @returns {Promise<string>} Default branch name
 */
async function detectDefaultBranch(git, owner, repoName, octokit = null) {
    // Method 0 (Highest Priority): Check repository-specific configuration in .env
    const repoConfigKey = getRepoConfigKey(owner, repoName);
    const repoSpecificBranch = process.env[repoConfigKey];
    
    if (repoSpecificBranch) {
        try {
            // Verify the configured branch exists
            await git.revparse([`origin/${repoSpecificBranch}`]);
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                defaultBranch: repoSpecificBranch,
                configKey: repoConfigKey
            }, 'Using repository-specific default branch from environment configuration');
            return repoSpecificBranch;
        } catch (branchError) {
            logger.warn({ 
                repo: `${owner}/${repoName}`, 
                configuredBranch: repoSpecificBranch,
                configKey: repoConfigKey,
                error: branchError.message
            }, 'Repository-specific configured branch does not exist, falling back to detection methods');
        }
    }

    // Method 1: Try GitHub API if available (most reliable automatic detection)
    if (octokit) {
        try {
            const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
                owner,
                repo: repoName
            });
            const defaultBranch = repoInfo.data.default_branch;
            if (defaultBranch) {
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch 
                }, 'Detected default branch from GitHub API');
                return defaultBranch;
            }
        } catch (apiError) {
            logger.debug({ 
                repo: `${owner}/${repoName}`, 
                error: apiError.message 
            }, 'Failed to detect default branch from GitHub API');
        }
    }
    try {
        // Method 2: Try to get the default branch from remote HEAD
        const remoteShow = await git.raw(['remote', 'show', 'origin']);
        const headBranchMatch = remoteShow.match(/HEAD branch: (.+)/);
        if (headBranchMatch) {
            const defaultBranch = headBranchMatch[1].trim();
            logger.debug({ 
                repo: `${owner}/${repoName}`, 
                defaultBranch 
            }, 'Detected default branch from remote HEAD');
            return defaultBranch;
        }
    } catch (error) {
        logger.debug({ 
            repo: `${owner}/${repoName}`, 
            error: error.message 
        }, 'Failed to detect default branch from remote show');
    }

    try {
        // Method 3: Try to get default branch from symbolic-ref
        const symbolicRef = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
        const branchMatch = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
        if (branchMatch) {
            const defaultBranch = branchMatch[1].trim();
            logger.debug({ 
                repo: `${owner}/${repoName}`, 
                defaultBranch 
            }, 'Detected default branch from symbolic-ref');
            return defaultBranch;
        }
    } catch (error) {
        logger.debug({ 
            repo: `${owner}/${repoName}`, 
            error: error.message 
        }, 'Failed to detect default branch from symbolic-ref');
    }

    // Method 4: Check common branch names in order of preference
    const commonBranches = [
        process.env.GIT_FALLBACK_BRANCH || 'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    for (const branch of commonBranches) {
        try {
            await git.revparse([`origin/${branch}`]);
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                defaultBranch: branch 
            }, `Using branch '${branch}' as default (found in common branches)`);
            return branch;
        } catch {
            logger.debug({ 
                repo: `${owner}/${repoName}`, 
                branch 
            }, `Branch '${branch}' not found`);
        }
    }

    // Method 5: Get any available remote branch as last resort
    try {
        const remoteBranches = await git.branch(['-r']);
        const firstBranch = remoteBranches.all
            .filter(branch => branch.startsWith('origin/') && !branch.includes('HEAD'))
            .map(branch => branch.replace('origin/', ''))
            .find(branch => branch);
            
        if (firstBranch) {
            logger.warn({ 
                repo: `${owner}/${repoName}`, 
                defaultBranch: firstBranch 
            }, `Using first available remote branch '${firstBranch}' as fallback`);
            return firstBranch;
        }
    } catch (error) {
        logger.warn({ 
            repo: `${owner}/${repoName}`, 
            error: error.message 
        }, 'Failed to list remote branches');
    }

    throw new Error(`Unable to detect default branch for repository ${owner}/${repoName}`);
}

/**
 * Lists all repository-specific branch configurations from environment variables
 * @returns {Object} Object with repository keys and their configured branches
 */
export function listRepositoryBranchConfigurations() {
    const configs = {};
    const prefix = 'GIT_DEFAULT_BRANCH_';
    
    Object.keys(process.env).forEach(key => {
        if (key.startsWith(prefix)) {
            const repoKey = key.substring(prefix.length);
            const parts = repoKey.split('_');
            
            if (parts.length >= 2) {
                // Reconstruct owner/repo from the key
                // Handle cases where owner or repo might have underscores
                let ownerParts = [];
                let repoParts = [];
                let foundSeparator = false;
                
                for (let i = 0; i < parts.length; i++) {
                    if (!foundSeparator) {
                        ownerParts.push(parts[i]);
                        // Simple heuristic: if we have at least one part for repo, consider it
                        if (i > 0 && parts.length > i + 1) {
                            foundSeparator = true;
                            repoParts = parts.slice(i + 1);
                            break;
                        }
                    }
                }
                
                if (!foundSeparator && parts.length === 2) {
                    // Simple case: exactly two parts
                    ownerParts = [parts[0]];
                    repoParts = [parts[1]];
                }
                
                if (ownerParts.length > 0 && repoParts.length > 0) {
                    const owner = ownerParts.join('_').toLowerCase();
                    const repo = repoParts.join('_').toLowerCase();
                    const branch = process.env[key];
                    
                    configs[`${owner}/${repo}`] = {
                        owner,
                        repo,
                        branch,
                        envKey: key
                    };
                }
            }
        }
    });
    
    return configs;
}

/**
 * Creates a Git worktree for a specific issue
 * @param {string} localRepoPath - Path to the main repository clone
 * @param {number} issueId - GitHub issue ID
 * @param {string} issueTitle - GitHub issue title
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} baseBranch - Base branch to create worktree from (optional)
 * @param {Object} octokit - GitHub API client (optional, for better default branch detection)
 * @param {string} modelName - AI model name for unique branch naming (optional)
 * @returns {Promise<{worktreePath: string, branchName: string}>} Worktree details
 */
export async function createWorktreeForIssue(localRepoPath, issueId, issueTitle, owner, repoName, baseBranch = null, octokit = null, modelName = null) {
    // Sanitize issue title for branch name
    const sanitizedTitle = issueTitle
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 25); // Reduced to make room for modelName and random string
    
    // Generate a 3-character random string for uniqueness
    const randomString = Math.random().toString(36).substring(2, 5);
    
    // Use shorter timestamp format (YYYYMMDD-HHMM)
    const now = new Date();
    const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    
    // Include modelName and random string in branch and worktree names
    const modelSuffix = modelName ? `-${modelName}` : '';
    const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
    const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
    const worktreePath = path.join(WORKTREES_BASE_PATH, owner, repoName, worktreeDirName);
    
    try {
        const git = simpleGit(localRepoPath);
        
        // Check if worktree path already exists
        if (await fs.pathExists(worktreePath)) {
            logger.warn({ 
                worktreePath, 
                issueId 
            }, 'Worktree path already exists. Removing existing worktree...');
            
            await cleanupWorktree(localRepoPath, worktreePath, branchName);
        }
        
        // Ensure parent directory exists
        await fs.ensureDir(path.dirname(worktreePath));
        
        // Detect the actual default branch if not specified
        if (!baseBranch) {
            baseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                detectedBranch: baseBranch 
            }, 'Auto-detected default branch');
        } else {
            // Verify the specified branch exists
            try {
                await git.revparse([`origin/${baseBranch}`]);
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    specifiedBranch: baseBranch 
                }, 'Using specified base branch');
            } catch (branchError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    specifiedBranch: baseBranch,
                    error: branchError.message
                }, 'Specified branch not found, detecting default branch');
                baseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            }
        }
        
        logger.info({ 
            localRepoPath, 
            worktreePath, 
            branchName, 
            baseBranch,
            issueId
        }, 'Creating Git worktree...');
        
        // Clean up any existing worktrees and branches
        try {
            // First, try to prune any stale worktree references
            await git.raw(['worktree', 'prune']);
            logger.debug('Pruned stale worktree references');
        } catch (pruneError) {
            logger.debug({ error: pruneError.message }, 'Failed to prune worktrees, continuing');
        }
        
        // Check if the branch already exists
        try {
            await git.revparse([branchName]);
            logger.info({ branchName }, 'Branch already exists, will delete and recreate');
            
            // Try to remove any worktrees using this branch
            try {
                const worktreeList = await git.raw(['worktree', 'list', '--porcelain']);
                const worktreeLines = worktreeList.split('\n');
                
                for (let i = 0; i < worktreeLines.length; i++) {
                    const line = worktreeLines[i];
                    if (line.startsWith('worktree ')) {
                        const worktreePath = line.substring('worktree '.length);
                        const branchLine = worktreeLines[i + 1];
                        if (branchLine && branchLine.startsWith('branch ') && 
                            branchLine.substring('branch refs/heads/'.length) === branchName) {
                            logger.info({ worktreePath, branchName }, 'Removing existing worktree for branch');
                            try {
                                await git.raw(['worktree', 'remove', worktreePath, '--force']);
                            } catch (removeError) {
                                logger.warn({ 
                                    worktreePath, 
                                    error: removeError.message 
                                }, 'Failed to remove existing worktree');
                            }
                        }
                    }
                }
            } catch (listError) {
                logger.debug({ error: listError.message }, 'Failed to list worktrees');
            }
            
            // Now try to delete the branch
            try {
                await git.branch(['-D', branchName]);
                logger.info({ branchName }, 'Deleted existing branch');
            } catch (deleteError) {
                logger.warn({ 
                    branchName, 
                    error: deleteError.message 
                }, 'Failed to delete existing branch, continuing anyway');
            }
        } catch {
            // Branch doesn't exist, which is what we want
            logger.debug({ branchName }, 'Branch does not exist, will create new one');
        }
        
        // Ensure we have the latest refs from remote
        await git.fetch('origin', baseBranch);
        logger.debug({ baseBranch }, 'Fetched latest changes for base branch');
        
        // Create the worktree with new branch
        await git.raw([
            'worktree', 'add', 
            worktreePath, 
            '-b', branchName, 
            `origin/${baseBranch}`
        ]);
        
        // Ensure worktree files are owned by UID 1000 for Docker container compatibility
        try {
            const { execSync } = await import('child_process');
            execSync(`sudo chown -R 1000:1000 "${worktreePath}"`, { 
                stdio: 'inherit',
                timeout: 10000 // 10 seconds timeout
            });
            logger.debug({ 
                worktreePath, 
                branchName, 
                issueId 
            }, 'Set worktree ownership to UID 1000 for container compatibility');
        } catch (chownError) {
            logger.warn({ 
                worktreePath, 
                branchName, 
                issueId,
                error: chownError.message 
            }, 'Failed to set worktree ownership - container may have permission issues');
        }
        
        // Add the worktree and main repo to Git's safe directories to prevent "dubious ownership" errors
        try {
            await git.raw(['config', '--global', '--add', 'safe.directory', worktreePath]);
            // Also add the main repository path for container compatibility
            await git.raw(['config', '--global', '--add', 'safe.directory', localRepoPath]);
            logger.debug({ 
                worktreePath, 
                localRepoPath,
                branchName, 
                issueId 
            }, 'Added worktree and main repo to Git safe directories');
        } catch (safeConfigError) {
            logger.warn({ 
                worktreePath, 
                branchName, 
                issueId,
                error: safeConfigError.message 
            }, 'Failed to add directories to Git safe directories - may encounter ownership warnings');
        }
        
        logger.info({ 
            worktreePath, 
            branchName, 
            issueId 
        }, 'Git worktree created successfully');
        
        return {
            worktreePath,
            branchName
        };
        
    } catch (error) {
        handleError(error, `Failed to create worktree for issue ${issueId}`);
        throw error;
    }
}

/**
 * Cleans up a Git worktree and optionally its branch with retention strategy
 * @param {string} localRepoPath - Path to the main repository clone
 * @param {string} worktreePath - Path to the worktree to remove
 * @param {string} branchName - Branch name to optionally delete
 * @param {Object} options - Cleanup options
 * @param {boolean} options.deleteBranch - Whether to delete the local branch
 * @param {boolean} options.success - Whether the task was successful
 * @param {string} options.retentionStrategy - Retention strategy ('always_delete', 'keep_on_failure', 'keep_for_hours')
 * @param {number} options.retentionHours - Hours to retain on failure (default: 24)
 */
export async function cleanupWorktree(localRepoPath, worktreePath, branchName, options = {}) {
    const {
        deleteBranch = false,
        success = true,
        retentionStrategy = process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete',
        retentionHours = parseInt(process.env.WORKTREE_RETENTION_HOURS || '24', 10)
    } = options;

    logger.info({ 
        worktreePath, 
        branchName, 
        deleteBranch,
        success,
        retentionStrategy,
        retentionHours
    }, 'Cleaning up Git worktree...');
    
    // Apply retention strategy
    if (!success && retentionStrategy === 'keep_on_failure') {
        logger.info({
            worktreePath,
            branchName,
            retentionStrategy
        }, 'Keeping worktree due to failure and retention strategy');
        
        // Create a marker file with retention info
        try {
            const retentionInfo = {
                timestamp: new Date().toISOString(),
                issueProcessed: true,
                success: false,
                retentionHours,
                scheduledCleanup: new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString()
            };
            await fs.writeJson(path.join(worktreePath, '.retention-info.json'), retentionInfo);
            logger.info({ worktreePath }, 'Created retention marker file');
        } catch (markerError) {
            logger.warn({
                worktreePath,
                error: markerError.message
            }, 'Failed to create retention marker file');
        }
        return;
    }

    if (!success && retentionStrategy === 'keep_for_hours') {
        // Schedule cleanup for later (this would typically be handled by a cron job)
        logger.info({
            worktreePath,
            retentionHours
        }, `Scheduling worktree cleanup in ${retentionHours} hours`);
        
        try {
            const retentionInfo = {
                timestamp: new Date().toISOString(),
                issueProcessed: true,
                success: false,
                retentionHours,
                scheduledCleanup: new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString()
            };
            await fs.writeJson(path.join(worktreePath, '.retention-info.json'), retentionInfo);
            logger.info({ worktreePath }, 'Scheduled cleanup with retention marker');
        } catch (markerError) {
            logger.warn({
                worktreePath,
                error: markerError.message
            }, 'Failed to create retention marker, proceeding with immediate cleanup');
        }
        
        // For now, still clean up immediately but log the intention
        // In a production system, this would exit here and let a cron job handle it
    }
    
    const git = simpleGit(localRepoPath);
    
    try {
        // Remove the worktree
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        logger.info({ worktreePath }, 'Worktree removed successfully');
    } catch (error) {
        // Check if the error is because it's not a valid worktree
        if (error.message && error.message.includes('.git\' is not a .git file')) {
            logger.info({ 
                worktreePath
            }, 'Directory is not a valid worktree (possibly converted to regular repo), will remove directly');
        } else {
            logger.warn({ 
                worktreePath, 
                error: error.message 
            }, 'Failed to remove worktree with git command, attempting directory removal');
        }
        
        // Try to remove directory directly if git command fails
        try {
            await fs.remove(worktreePath);
            logger.info({ worktreePath }, 'Worktree directory removed directly');
        } catch (fsError) {
            logger.error({ 
                worktreePath, 
                error: fsError.message 
            }, 'Failed to remove worktree directory');
        }
    }
    
    // Optionally delete the local branch
    if (deleteBranch && branchName) {
        try {
            await git.deleteLocalBranch(branchName, true); // Force delete
            logger.info({ branchName }, 'Local branch deleted');
        } catch (branchError) {
            logger.warn({ 
                branchName, 
                error: branchError.message 
            }, 'Failed to delete local branch');
        }
    }
    
    // Prune worktrees to clean up references
    try {
        await git.raw(['worktree', 'prune']);
        logger.debug('Git worktree references pruned');
    } catch (pruneError) {
        logger.warn({ 
            error: pruneError.message 
        }, 'Failed to prune worktree references');
    }
}

/**
 * Cleans up old worktrees based on retention policies (for cron jobs)
 * @param {string} worktreesBasePath - Base path for worktrees
 * @returns {Promise<{cleaned: number, retained: number}>} Cleanup results
 */
export async function cleanupExpiredWorktrees(worktreesBasePath = WORKTREES_BASE_PATH) {
    logger.info({ worktreesBasePath }, 'Starting cleanup of expired worktrees...');
    
    let cleaned = 0;
    let retained = 0;
    
    try {
        if (!await fs.pathExists(worktreesBasePath)) {
            logger.info({ worktreesBasePath }, 'Worktrees base path does not exist, nothing to clean');
            return { cleaned, retained };
        }
        
        // Walk through all worktree directories
        const processDirectory = async (dirPath) => {
            const items = await fs.readdir(dirPath);
            
            for (const item of items) {
                const itemPath = path.join(dirPath, item);
                const stats = await fs.stat(itemPath);
                
                if (stats.isDirectory()) {
                    const retentionFile = path.join(itemPath, '.retention-info.json');
                    
                    if (await fs.pathExists(retentionFile)) {
                        try {
                            const retentionInfo = await fs.readJson(retentionFile);
                            const scheduledCleanup = new Date(retentionInfo.scheduledCleanup);
                            const now = new Date();
                            
                            if (now >= scheduledCleanup) {
                                logger.info({
                                    worktreePath: itemPath,
                                    scheduledCleanup: retentionInfo.scheduledCleanup
                                }, 'Cleaning up expired worktree');
                                
                                await fs.remove(itemPath);
                                cleaned++;
                            } else {
                                logger.debug({
                                    worktreePath: itemPath,
                                    scheduledCleanup: retentionInfo.scheduledCleanup
                                }, 'Retaining worktree until scheduled cleanup time');
                                retained++;
                            }
                        } catch (retentionError) {
                            logger.warn({
                                worktreePath: itemPath,
                                error: retentionError.message
                            }, 'Failed to read retention info, skipping cleanup');
                            retained++;
                        }
                    } else {
                        // Check if it's an old directory (fallback cleanup)
                        const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
                        const maxAgeHours = parseInt(process.env.WORKTREE_MAX_AGE_HOURS || '72', 10);
                        
                        if (ageHours > maxAgeHours) {
                            logger.info({
                                worktreePath: itemPath,
                                ageHours: Math.round(ageHours),
                                maxAgeHours
                            }, 'Cleaning up old worktree (fallback cleanup)');
                            
                            await fs.remove(itemPath);
                            cleaned++;
                        } else {
                            // Recursively process subdirectories
                            await processDirectory(itemPath);
                        }
                    }
                }
            }
        };
        
        await processDirectory(worktreesBasePath);
        
        logger.info({
            worktreesBasePath,
            cleaned,
            retained
        }, 'Expired worktrees cleanup completed');
        
    } catch (error) {
        handleError(error, 'Failed to cleanup expired worktrees');
        throw error;
    }
    
    return { cleaned, retained };
}

/**
 * Gets the repository URL from issue data
 * @param {Object} issue - Issue object containing repository information
 * @returns {string} Repository URL
 */
export function getRepoUrl(issue) {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

/**
 * Commits changes in a worktree with Claude-optimized message
 * @param {string} worktreePath - Path to the worktree
 * @param {string|Object} commitMessage - Commit message string or object with suggested message
 * @param {Object} author - Author information {name, email}
 * @param {number} issueNumber - Issue number for structured commit message
 * @param {string} issueTitle - Issue title for context
 * @returns {Promise<{commitHash: string, commitMessage: string}|null>} Commit result
 */
export async function commitChanges(worktreePath, commitMessage, author, issueNumber, issueTitle) {
    // Validate worktree path exists and contains .git
    try {
        const gitPath = path.join(worktreePath, '.git');
        const worktreeExists = await fs.pathExists(worktreePath);
        const gitExists = await fs.pathExists(gitPath);
        
        if (!worktreeExists) {
            throw new Error(`Worktree path does not exist: ${worktreePath}`);
        }
        
        if (!gitExists) {
            throw new Error(`Not a git repository (or any of the parent directories): ${worktreePath}`);
        }
        
        // Check if .git is a file (worktree) or directory (regular repo)
        const gitStats = await fs.stat(gitPath);
        if (gitStats.isDirectory()) {
            logger.warn({ 
                worktreePath,
                gitPath,
                issueNumber 
            }, '.git is a directory, not a worktree file - this suggests improper worktree creation');
            
            // This can happen if the worktree was converted to a regular repo during processing
            // (e.g., by some git operations inside Docker containers)
            // We can still continue as the git operations should work
        } else if (gitStats.isFile()) {
            // Read .git file content to verify it's a proper worktree
            const gitFileContent = await fs.readFile(gitPath, 'utf8');
            logger.debug({ 
                worktreePath,
                gitPath,
                gitFileContent: gitFileContent.trim(),
                issueNumber 
            }, 'Validated worktree .git file');
        }
    } catch (validationError) {
        logger.error({
            worktreePath,
            issueNumber,
            error: validationError.message
        }, 'Worktree validation failed');
        throw validationError;
    }
    
    // Initialize simple-git with proper baseDir option
    const git = simpleGit({ baseDir: worktreePath });
    
    logger.debug({ 
        worktreePath,
        issueNumber 
    }, 'Initializing git operations in worktree');
    
    try {
        // Try a different approach: set git config using raw commands instead of addConfig
        if (author) {
            try {
                // Use raw git commands to set config
                await git.raw(['config', 'user.name', author.name]);
                await git.raw(['config', 'user.email', author.email]);
                logger.debug({
                    worktreePath,
                    author,
                    issueNumber
                }, 'Set git author config using raw commands');
            } catch (configError) {
                // If local config fails, try without --local flag
                logger.warn({
                    worktreePath,
                    error: configError.message,
                    issueNumber
                }, 'Failed to set local git config, continuing without author config');
            }
        }
        
        // Add all changes
        await git.add('.');
        
        // Check if there are any changes to commit
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
            ahead: status.ahead || 0,
            behind: status.behind || 0,
            current: status.current || null,
            detached: status.detached || false,
            totalFiles: status.files?.length || 0
        }, 'Git status before commit');
        
        if (status.files.length === 0) {
            logger.info({ worktreePath }, 'No changes to commit');
            return null;
        }
        
        // Log detailed file information
        logger.info({
            worktreePath,
            issueNumber,
            totalFiles: status.files.length,
            files: status.files.map(f => ({
                path: f.path,
                index: f.index,
                working_dir: f.working_dir
            }))
        }, 'Files to be committed');
        
        // Generate structured commit message
        let finalCommitMessage;
        if (typeof commitMessage === 'object' && commitMessage.claudeSuggested) {
            // Use Claude's suggested message if available and well-formed
            finalCommitMessage = commitMessage.claudeSuggested;
        } else if (typeof commitMessage === 'string') {
            finalCommitMessage = commitMessage;
        } else {
            // Generate default structured commit message
            const shortTitle = issueTitle ? issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
            finalCommitMessage = `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}

Implemented by Claude Code. Full conversation log in PR comment.`;
        }
        
        // Commit changes
        const result = await git.commit(finalCommitMessage);
        
        // Extract the actual commit hash (remove "HEAD " prefix if present)
        const commitHash = result.commit.replace(/^HEAD\s+/, '');
        
        logger.info({ 
            worktreePath, 
            commitHash: commitHash,
            filesChanged: status.files.length,
            issueNumber,
            commitMessage: finalCommitMessage
        }, 'Changes committed successfully');
        
        return {
            commitHash: commitHash,
            commitMessage: finalCommitMessage
        };
        
    } catch (error) {
        handleError(error, `Failed to commit changes in worktree ${worktreePath}`);
        throw error;
    }
}

/**
 * Ensures branch is properly set up with origin and pushes to remote
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name
 * @param {string} baseBranch - Base branch name
 * @param {Object} options - Setup options
 * @param {string} options.repoUrl - Repository URL for authentication
 * @param {string} options.authToken - GitHub authentication token
 * @param {Object} options.tokenRefreshFn - Function to refresh token if needed
 * @param {string} options.correlationId - Correlation ID for logging
 * @returns {Promise<void>}
 */
export async function ensureBranchAndPush(worktreePath, branchName, baseBranch, options = {}) {
    const { repoUrl, authToken, tokenRefreshFn, correlationId } = options;
    
    const pushOperation = async (currentToken) => {
        const git = simpleGit({ baseDir: worktreePath });
        
        // Set up authentication if provided
        if (repoUrl && currentToken) {
            await setupAuthenticatedRemote(git, repoUrl, currentToken);
        }
        
        logger.info({ 
            worktreePath, 
            branchName, 
            baseBranch 
        }, 'Ensuring branch is properly set up and pushed...');
        
        // Verify we're on the correct branch
        const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
        const actualBranch = currentBranch.trim();
        
        if (actualBranch !== branchName) {
            throw new Error(`Expected to be on branch '${branchName}' but currently on '${actualBranch}'`);
        }
        
        // Ensure we have commits (check if there are any changes compared to base)
        try {
            const diffResult = await git.raw(['diff', '--name-only', `origin/${baseBranch}...HEAD`]);
            if (!diffResult.trim()) {
                logger.warn({ branchName, baseBranch }, 'No changes detected between branch and base');
            } else {
                const changedFiles = diffResult.trim().split('\n').filter(f => f);
                logger.info({ 
                    branchName, 
                    baseBranch, 
                    changedFiles: changedFiles.length 
                }, 'Changes detected, proceeding with push');
            }
        } catch (diffError) {
            logger.debug({ error: diffError.message }, 'Could not check diff, proceeding anyway');
        }
        
        // Set upstream and push
        await git.push(['--set-upstream', 'origin', branchName]);
        
        logger.info({ 
            branchName, 
            baseBranch,
            worktreePath 
        }, 'Branch successfully pushed to remote');
    };
    
    try {
        let currentToken = authToken;
        
        // Wrap the push operation with retry logic
        await withRetry(
            async () => {
                try {
                    await pushOperation(currentToken);
                } catch (error) {
                    
                    // Check if it's an authentication error and we can refresh the token
                    if (tokenRefreshFn && 
                        (error.message.includes('Authentication failed') || 
                         error.message.includes('Invalid username or token'))) {
                        logger.info({
                            correlationId,
                            worktreePath,
                            branchName
                        }, 'Authentication error detected, attempting to refresh token');
                        
                        try {
                            const refreshedToken = await tokenRefreshFn();
                            if (refreshedToken && refreshedToken !== currentToken) {
                                currentToken = refreshedToken;
                                logger.info({
                                    correlationId
                                }, 'Token refreshed successfully, retrying push');
                            }
                        } catch (refreshError) {
                            logger.error({
                                correlationId,
                                error: refreshError.message
                            }, 'Failed to refresh token');
                        }
                    }
                    
                    throw error;
                }
            },
            { ...retryConfigs.gitPush, correlationId },
            `Git push for branch ${branchName}`
        );
        
    } catch (error) {
        logger.error({ 
            error: error.message, 
            branchName, 
            baseBranch,
            worktreePath 
        }, 'Failed to ensure branch and push');
        throw error;
    }
}

/**
 * Creates a Git worktree from an existing branch (for PR follow-ups)
 * @param {string} localRepoPath - Path to the main repository clone
 * @param {string} branchName - Existing branch name to create worktree from
 * @param {string} worktreeDirName - Name for the worktree directory
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<{worktreePath: string, branchName: string}>} Worktree details
 */
export async function createWorktreeFromExistingBranch(localRepoPath, branchName, worktreeDirName, owner, repoName) {
    const worktreePath = path.join(WORKTREES_BASE_PATH, owner, repoName, worktreeDirName);
    
    try {
        const git = simpleGit(localRepoPath);
        
        // Check if worktree path already exists
        if (await fs.pathExists(worktreePath)) {
            logger.warn({ 
                worktreePath, 
                branchName 
            }, 'Worktree path already exists. Checking if it\'s a valid worktree...');
            
            // Check if it's a proper worktree or just a directory
            const gitPath = path.join(worktreePath, '.git');
            let isProperWorktree = false;
            
            if (await fs.pathExists(gitPath)) {
                const stats = await fs.stat(gitPath);
                isProperWorktree = stats.isFile(); // Worktrees have .git as a file, not directory
            }
            
            if (!isProperWorktree) {
                logger.warn({ 
                    worktreePath,
                    gitPath,
                    isDirectory: await fs.pathExists(gitPath) ? (await fs.stat(gitPath)).isDirectory() : false
                }, 'Not a proper worktree, removing directory directly');
                
                // Force remove the directory since it's not a valid worktree
                await fs.remove(worktreePath);
            } else {
                // It's a proper worktree, use cleanupWorktree
                await cleanupWorktree(localRepoPath, worktreePath, branchName);
            }
            
            // Double-check that the directory is really gone
            if (await fs.pathExists(worktreePath)) {
                logger.warn({ worktreePath }, 'Directory still exists after cleanup, forcing removal');
                await fs.remove(worktreePath);
            }
        }
        
        // Ensure parent directory exists
        await fs.ensureDir(path.dirname(worktreePath));
        
        logger.info({ 
            localRepoPath, 
            worktreePath, 
            branchName
        }, 'Creating Git worktree from existing branch...');
        
        // Fetch the latest changes for the branch
        await git.fetch('origin', branchName);
        logger.debug({ branchName }, 'Fetched latest changes for branch');
        
        // Always create worktree from remote branch to ensure fresh start
        // This avoids complexity of tracking unpushed commits across failed attempts
        let worktreeCreated = false;
        
        try {
            // First, ensure the worktree metadata directory exists in the main repo
            const worktreeMetadataDir = path.join(localRepoPath, '.git', 'worktrees');
            await fs.ensureDir(worktreeMetadataDir);
            
            // Verify the main repository is valid before creating worktree
            const mainRepoGitPath = path.join(localRepoPath, '.git');
            if (!await fs.pathExists(mainRepoGitPath)) {
                throw new Error(`Main repository is invalid - no .git found at ${localRepoPath}`);
            }
            
            // List existing worktrees to ensure we're not duplicating
            try {
                const existingWorktrees = await git.raw(['worktree', 'list', '--porcelain']);
                logger.debug({ 
                    localRepoPath,
                    existingWorktrees: existingWorktrees.trim()
                }, 'Current worktrees before adding new one');
            } catch (listError) {
                logger.warn({ error: listError.message }, 'Failed to list existing worktrees');
            }
            
            // Create worktree with a local branch tracking the remote branch
            // Using -b flag with the same branch name to create a local tracking branch
            const worktreeAddResult = await git.raw([
                'worktree', 'add',
                '-B', branchName,  // Force create/reset local branch
                worktreePath,
                `origin/${branchName}`
            ]);
            logger.info({ 
                branchName, 
                worktreePath,
                gitOutput: worktreeAddResult.trim(),
                commandUsed: `git worktree add -B ${branchName} ${worktreePath} origin/${branchName}`
            }, 'Git worktree add command completed');
            
            worktreeCreated = true;
        } catch (error) {
            // Check if the error is because the branch is already checked out in another worktree
            if (error.message && error.message.includes('is already used by worktree')) {
                logger.error({ 
                    branchName,
                    error: error.message 
                }, 'Branch is already checked out in another worktree');
                
                // Extract the existing worktree path from the error message
                const match = error.message.match(/worktree at '([^']+)'/);
                if (match) {
                    const existingWorktreePath = match[1];
                    logger.info({ 
                        branchName,
                        existingWorktreePath,
                        newWorktreePath: worktreePath
                    }, 'Attempting to remove existing worktree to allow new one');
                    
                    try {
                        // Remove the existing worktree
                        await git.raw(['worktree', 'remove', existingWorktreePath, '--force']);
                        logger.info({ existingWorktreePath }, 'Successfully removed existing worktree');
                        
                        // Try creating the worktree again
                        const worktreeAddResult = await git.raw([
                            'worktree', 'add',
                            '-B', branchName,  // Force create/reset local branch
                            worktreePath,
                            `origin/${branchName}`
                        ]);
                        logger.info({ 
                            branchName, 
                            worktreePath,
                            gitOutput: worktreeAddResult.trim()
                        }, 'Successfully created worktree after removing existing one');
                        
                        // Mark as created so we can continue with verification
                        worktreeCreated = true;
                    } catch (retryError) {
                        logger.error({ 
                            branchName,
                            existingWorktreePath,
                            error: retryError.message 
                        }, 'Failed to handle existing worktree conflict');
                        throw new Error(`Cannot create worktree: branch '${branchName}' is locked by another worktree`);
                    }
                } else {
                    throw new Error(`Cannot create worktree: branch '${branchName}' is already checked out elsewhere`);
                }
            } else if (error.message && error.message.includes('.git is a directory')) {
                // This is a critical error - the worktree was not created properly
                logger.error({ 
                    branchName,
                    worktreePath,
                    error: error.message 
                }, 'Worktree creation failed - improper structure detected');
                
                // Clean up the improperly created directory
                try {
                    await fs.remove(worktreePath);
                    logger.info({ worktreePath }, 'Removed improperly created worktree directory');
                } catch (cleanupError) {
                    logger.error({ 
                        worktreePath,
                        error: cleanupError.message 
                    }, 'Failed to clean up improper worktree directory');
                }
                
                throw error; // Re-throw the original error
            } else {
                // For other errors, check if it's really because branch doesn't exist
                logger.error({ 
                    branchName,
                    error: error.message 
                }, 'Failed to create worktree from remote branch');
                
                // Try to verify if the branch exists on remote
                try {
                    const remoteBranches = await git.branch(['-r']);
                    const remoteBranchExists = remoteBranches.all.includes(`origin/${branchName}`);
                    if (!remoteBranchExists) {
                        throw new Error(`Cannot create worktree: branch '${branchName}' not found on remote`);
                    } else {
                        // Branch exists but some other error occurred
                        throw new Error(`Cannot create worktree: ${error.message}`);
                    }
                } catch {
                    // If we can't even check branches, throw the original error
                    throw new Error(`Cannot create worktree: ${error.message}`);
                }
            }
        }
        
        // Verify the worktree was created properly (runs for both initial and retry attempts)
        if (worktreeCreated) {
            const gitFilePath = path.join(worktreePath, '.git');
            if (await fs.pathExists(gitFilePath)) {
                const stats = await fs.stat(gitFilePath);
                if (stats.isDirectory()) {
                    // This means git created a regular repository instead of a worktree
                    logger.error({
                        worktreePath,
                        gitFilePath,
                        isDirectory: true
                    }, 'Git created a regular repository instead of a worktree');
                    throw new Error('Worktree creation failed - .git is a directory instead of a file');
                } else {
                    // Read the .git file to verify it points to the right place
                    const gitFileContent = await fs.readFile(gitFilePath, 'utf8');
                    logger.debug({
                        worktreePath,
                        gitFileContent: gitFileContent.trim()
                    }, 'Worktree .git file content');
                    
                    // Extract the path from the .git file
                    const match = gitFileContent.match(/gitdir:\s*(.+)/);
                    if (match) {
                        const gitdirPath = match[1].trim();
                        // Verify the gitdir path exists
                        if (!await fs.pathExists(gitdirPath)) {
                            logger.error({
                                worktreePath,
                                gitdirPath,
                                gitFileContent: gitFileContent.trim()
                            }, 'Worktree .git file points to non-existent directory');
                            throw new Error(`Worktree creation failed - gitdir path does not exist: ${gitdirPath}`);
                        }
                    }
                }
            } else {
                throw new Error('Worktree creation failed - no .git file found');
            }
        }
        
        // Ensure worktree files are owned by UID 1000 for Docker container compatibility
        try {
            const { execSync } = await import('child_process');
            execSync(`sudo chown -R 1000:1000 "${worktreePath}"`, { 
                stdio: 'inherit',
                timeout: 10000
            });
            logger.debug({ 
                worktreePath, 
                branchName
            }, 'Set worktree ownership to UID 1000 for container compatibility');
        } catch (chownError) {
            logger.warn({ 
                worktreePath, 
                branchName,
                error: chownError.message 
            }, 'Failed to set worktree ownership - container may have permission issues');
        }
        
        // Add the worktree and main repo to Git's safe directories
        try {
            await git.raw(['config', '--global', '--add', 'safe.directory', worktreePath]);
            await git.raw(['config', '--global', '--add', 'safe.directory', localRepoPath]);
            logger.debug({ 
                worktreePath, 
                localRepoPath,
                branchName
            }, 'Added worktree and main repo to Git safe directories');
        } catch (safeConfigError) {
            logger.warn({ 
                worktreePath, 
                branchName,
                error: safeConfigError.message 
            }, 'Failed to add directories to Git safe directories - may encounter ownership warnings');
        }
        
        // Set up remote in the worktree
        // Worktrees don't automatically inherit remotes from the parent repository
        const worktreeGit = simpleGit({ baseDir: worktreePath });
        try {
            // Check if origin remote exists
            const remotes = await worktreeGit.getRemotes();
            logger.debug({
                worktreePath,
                existingRemotes: remotes.map(r => r.name)
            }, 'Checking existing remotes in worktree');
            
            if (!remotes.find(r => r.name === 'origin')) {
                logger.info({ worktreePath }, 'No origin remote found in worktree, adding it');
                
                // Get the remote URL from the parent repository
                const parentRemotes = await git.getRemotes(true);
                const originRemote = parentRemotes.find(r => r.name === 'origin');
                
                if (originRemote && originRemote.refs.fetch) {
                    await worktreeGit.addRemote('origin', originRemote.refs.fetch);
                    logger.info({ 
                        worktreePath, 
                        remoteUrl: originRemote.refs.fetch
                    }, 'Successfully added origin remote to worktree');
                } else {
                    logger.error({
                        worktreePath,
                        parentRemotes
                    }, 'Could not find origin remote in parent repository');
                }
            } else {
                logger.debug({ worktreePath }, 'Origin remote already exists in worktree');
            }
        } catch (remoteError) {
            logger.error({ 
                worktreePath, 
                error: remoteError.message,
                stack: remoteError.stack
            }, 'Failed to set up remote in worktree - push operations WILL fail');
        }
        
        // Final verification that the worktree is properly set up
        try {
            const finalRemotes = await worktreeGit.getRemotes(true);
            const hasOrigin = finalRemotes.some(r => r.name === 'origin');
            
            if (!hasOrigin) {
                throw new Error('Worktree was created but origin remote is missing');
            }
            
            logger.info({ 
                worktreePath, 
                branchName,
                remotes: finalRemotes.map(r => ({ name: r.name, url: r.refs.fetch }))
            }, 'Git worktree created successfully from existing branch with remotes configured');
        } catch (verifyError) {
            logger.error({
                worktreePath,
                error: verifyError.message
            }, 'Final verification failed - worktree may not be properly configured');
            throw new Error(`Worktree setup incomplete: ${verifyError.message}`);
        }
        
        return {
            worktreePath,
            branchName
        };
        
    } catch (error) {
        handleError(error, `Failed to create worktree from branch ${branchName}`);
        throw error;
    }
}

/**
 * Pushes branch from worktree to remote
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name to push
 * @param {Object} options - Push options
 * @param {string} options.repoUrl - Repository URL for authentication
 * @param {string} options.authToken - GitHub authentication token
 * @param {string} options.remote - Remote name (default: 'origin')
 * @param {Object} options.tokenRefreshFn - Function to refresh token if needed
 * @param {string} options.correlationId - Correlation ID for logging
 * @returns {Promise<void>}
 */
export async function pushBranch(worktreePath, branchName, options = {}) {
    const { repoUrl, authToken, remote = 'origin' } = options;
    
    const performPush = async (token) => {
        if (repoUrl && token) {
            await setupAuthenticatedRemote(git, repoUrl, token);
        }
        
        try {
            const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            logger.debug({ 
                worktreePath, 
                currentBranch: currentBranch.trim(),
                expectedBranch: branchName 
            }, 'Current branch in worktree');
            
            if (currentBranch.trim() !== branchName) {
                logger.warn({ 
                    worktreePath, 
                    currentBranch: currentBranch.trim(),
                    expectedBranch: branchName 
                }, 'Branch mismatch detected, attempting to checkout correct branch');
                
                const branches = await git.branchLocal();
                const branchExists = branches.all.includes(branchName);
                
                logger.debug({
                    worktreePath,
                    branchName,
                    branchExists,
                    localBranches: branches.all,
                    currentBranch: branches.current
                }, 'Checking local branches before checkout');
                
                await git.checkout(branchName);
                
                const newBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
                logger.info({
                    worktreePath,
                    previousBranch: currentBranch.trim(),
                    newBranch: newBranch.trim(),
                    expectedBranch: branchName,
                    checkoutSuccess: newBranch.trim() === branchName
                }, 'Branch checkout completed');
            }
        } catch (branchCheckError) {
            logger.warn({ 
                error: branchCheckError.message 
            }, 'Failed to verify current branch, proceeding with push anyway');
        }
        
        await git.push([remote, branchName, '--set-upstream']);
    };
    
    const git = simpleGit({ baseDir: worktreePath });
    
    try {
        await performPush(authToken);
        
        logger.info({ 
            worktreePath, 
            branchName, 
            remote 
        }, 'Branch pushed to remote successfully');
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