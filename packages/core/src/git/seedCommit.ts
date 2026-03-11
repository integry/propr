import { SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { setupAuthenticatedRemote } from './repoBranching.js';

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
 * Check if a repository is empty (has no commits) and create a seed commit if needed.
 * This allows the system to work with newly created empty repositories.
 */
export async function ensureSeedCommitIfEmpty(
    git: SimpleGit,
    options: SeedCommitOptions
): Promise<boolean> {
    const { localRepoPath, owner, repoName, defaultBranch, authToken, repoUrl } = options;
    try {
        const logResult = await git.raw(['rev-list', '-n', '1', '--all']).catch(() => '');
        if (logResult.trim()) {
            return false;
        }

        logger.info({ repo: `${owner}/${repoName}` }, 'Empty repository detected, creating seed commit...');

        const readmePath = path.join(localRepoPath, 'README.md');
        await fs.writeFile(readmePath, DEFAULT_README(repoName));

        const gitignorePath = path.join(localRepoPath, '.gitignore');
        await fs.writeFile(gitignorePath, DEFAULT_GITIGNORE);

        await git.addConfig('user.email', 'bot@propr.dev');
        await git.addConfig('user.name', 'ProPR Bot');

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
