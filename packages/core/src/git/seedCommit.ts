import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { setupAuthenticatedRemote, redactAuthenticatedGitUrl } from './repoBranching.js';
import { AI_COMMIT_AUTHOR } from './commitOperations.js';

export interface SeedCommitOptions {
    localRepoPath: string;
    owner: string;
    repoName: string;
    defaultBranch: string;
    authToken: string;
    repoUrl: string;
}

const DEFAULT_README = (repoName: string) => `# ${repoName}

Welcome to ${repoName}! This repository was initialized automatically.

## Getting Started

Add your project files and documentation here.
`;

const DEFAULT_GITIGNORE = `# Dependencies
node_modules/
vendor/

# Build outputs
dist/
build/
*.log

# Environment files
.env
.env.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`;

/**
 * Return true only when the local repository provably has at least one commit
 * reachable from any ref. A thrown git error is NOT treated as "empty": it is
 * propagated so that a transient failure (e.g. lock contention in the shared
 * clone) can never be mistaken for an empty repo and trigger a destructive
 * seed commit. See the mcptest 22cb898 incident.
 */
async function localRepoHasCommits(git: SimpleGit): Promise<boolean> {
    const revList = await git.raw(['rev-list', '-n', '1', '--all']);
    return revList.trim().length > 0;
}

/**
 * Return true when the remote already has any ref (branch or tag). Seeding only
 * makes sense for a genuinely brand-new empty remote, so a non-empty result
 * must abort seeding. Errors are propagated rather than swallowed.
 */
async function remoteHasAnyRefs(repoUrl: string, authToken: string): Promise<boolean> {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    try {
        const lsRemote = await simpleGit().raw(['ls-remote', authenticatedUrl]);
        return lsRemote.trim().length > 0;
    } catch (error) {
        throw new Error(redactAuthenticatedGitUrl((error as Error).message));
    }
}

/**
 * Return true when HEAD resolves to an existing commit. Used as a final guard:
 * we must never seed on top of real history.
 */
async function headPointsAtCommit(git: SimpleGit): Promise<boolean> {
    const head = await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    return head.trim().length > 0;
}

/**
 * Check if a repository is empty (has no commits) and create a seed commit if needed.
 * This allows the system to work with newly created empty repositories.
 */
export async function ensureSeedCommitIfEmpty(
    git: SimpleGit,
    options: SeedCommitOptions
): Promise<boolean> {
    const { localRepoPath, owner, repoName, defaultBranch, authToken, repoUrl } = options;
    try {
        if (await localRepoHasCommits(git)) {
            return false;
        }

        // The local clone looks empty, but a transient/partial local state can
        // present as empty while the remote actually has history. Never perform
        // the destructive seed unless the remote is confirmed empty too.
        if (await remoteHasAnyRefs(repoUrl, authToken)) {
            logger.warn({ repo: `${owner}/${repoName}` }, 'Local clone appears empty but remote has refs; skipping seed commit to avoid overwriting existing history');
            return false;
        }

        // Final safety net: if HEAD already resolves to a commit, the repo is not
        // empty regardless of what the checks above concluded. Refuse to seed.
        if (await headPointsAtCommit(git)) {
            logger.warn({ repo: `${owner}/${repoName}` }, 'HEAD resolves to an existing commit; refusing to create a seed commit on top of existing history');
            return false;
        }

        logger.info({ repo: `${owner}/${repoName}` }, 'Empty repository detected, creating seed commit...');

        const readmePath = path.join(localRepoPath, 'README.md');
        await fs.writeFile(readmePath, DEFAULT_README(repoName));

        const gitignorePath = path.join(localRepoPath, '.gitignore');
        await fs.writeFile(gitignorePath, DEFAULT_GITIGNORE);

        await git.addConfig('user.email', AI_COMMIT_AUTHOR.email);
        await git.addConfig('user.name', AI_COMMIT_AUTHOR.name);

        await git.checkoutLocalBranch(defaultBranch);
        await git.add([readmePath, gitignorePath]);
        await git.commit('Initial commit\n\nRepository initialized by ProPR to enable AI-assisted development.');

        await setupAuthenticatedRemote(git, repoUrl, authToken);
        await git.push(['--set-upstream', 'origin', defaultBranch]);

        logger.info({ repo: `${owner}/${repoName}`, branch: defaultBranch }, 'Seed commit created and pushed successfully');
        return true;
    } catch (error) {
        logger.error({ repo: `${owner}/${repoName}`, error: (error as Error).message }, 'Failed to create seed commit');
        throw new Error(`Failed to initialize empty repository ${owner}/${repoName}: ${(error as Error).message}`);
    }
}
