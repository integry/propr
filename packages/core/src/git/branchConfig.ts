import { SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/core';
import logger from '../utils/logger.js';

export function getRepoConfigKey(owner: string, repoName: string): string {
    const cleanOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const cleanRepoName = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return `GIT_DEFAULT_BRANCH_${cleanOwner}_${cleanRepoName}`;
}

export async function detectDefaultBranch(git: SimpleGit, owner: string, repoName: string, octokit: InstanceType<typeof Octokit> | null = null): Promise<string> {
    const repoConfigKey = getRepoConfigKey(owner, repoName);
    const repoSpecificBranch = process.env[repoConfigKey];

    if (repoSpecificBranch) {
        try {
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
                error: (branchError as Error).message
            }, 'Repository-specific configured branch does not exist, falling back to detection methods');
        }
    }

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
                error: (apiError as Error).message
            }, 'Failed to detect default branch from GitHub API');
        }
    }
    try {
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
            error: (error as Error).message
        }, 'Failed to detect default branch from remote show');
    }

    try {
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
            error: (error as Error).message
        }, 'Failed to detect default branch from symbolic-ref');
    }

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
            error: (error as Error).message
        }, 'Failed to list remote branches');
    }

    throw new Error(`Unable to detect default branch for repository ${owner}/${repoName}`);
}

interface OwnerRepoParts {
    ownerParts: string[];
    repoParts: string[];
}

function parseOwnerRepoParts(parts: string[]): OwnerRepoParts {
    const ownerParts: string[] = [];
    let repoParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        ownerParts.push(parts[i]);
        if (i > 0 && parts.length > i + 1) {
            repoParts = parts.slice(i + 1);
            break;
        }
    }
    if (repoParts.length === 0 && parts.length === 2) {
        return { ownerParts: [parts[0]], repoParts: [parts[1]] };
    }
    return { ownerParts, repoParts };
}

export interface BranchConfiguration {
    owner: string;
    repo: string;
    branch: string | undefined;
    envKey: string;
}

export function listRepositoryBranchConfigurations(): Record<string, BranchConfiguration> {
    const configs: Record<string, BranchConfiguration> = {};
    const prefix = 'GIT_DEFAULT_BRANCH_';

    Object.keys(process.env).forEach(key => {
        if (!key.startsWith(prefix)) return;
        const repoKey = key.substring(prefix.length);
        const parts = repoKey.split('_');
        if (parts.length < 2) return;
        const { ownerParts, repoParts } = parseOwnerRepoParts(parts);
        if (ownerParts.length === 0 || repoParts.length === 0) return;
        const owner = ownerParts.join('_').toLowerCase();
        const repo = repoParts.join('_').toLowerCase();
        configs[`${owner}/${repo}`] = { owner, repo, branch: process.env[key], envKey: key };
    });

    return configs;
}
