import { simpleGit, SimpleGit, StatusResult, FileStatusResult } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

interface Author {
    name: string;
    email: string;
}

interface CommitMessageObject {
    claudeSuggested?: string;
}

interface CommitOptions {
    issueNumber?: number;
    issueTitle?: string;
}

export interface CommitResult {
    commitHash: string;
    commitMessage: string;
}

async function validateWorktree(worktreePath: string, issueNumber?: number): Promise<void> {
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

        // Verify the gitdir path actually exists (critical check)
        const match = gitFileContent.match(/gitdir:\s*(.+)/);
        if (match) {
            const gitdirPath = match[1].trim();
            if (!await fs.pathExists(gitdirPath)) {
                logger.error({
                    worktreePath,
                    gitdirPath,
                    gitFileContent: gitFileContent.trim(),
                    issueNumber
                }, 'Worktree metadata directory was deleted during execution - this may be caused by concurrent git operations or Claude running git commands');
                throw new Error(`Worktree metadata was deleted: ${gitdirPath} no longer exists. The worktree .git file points to a non-existent directory.`);
            }
            logger.debug({ worktreePath, gitdirPath, issueNumber }, 'Worktree gitdir path verified');
        }
    }
}

async function configureGitAuthor(git: SimpleGit, author: Author | null, worktreePath: string, issueNumber?: number): Promise<void> {
    if (!author) return;
    try {
        await git.raw(['config', 'user.name', author.name]);
        await git.raw(['config', 'user.email', author.email]);
        logger.debug({ worktreePath, author, issueNumber }, 'Set git author config using raw commands');
    } catch (configError) {
        logger.warn({ worktreePath, error: (configError as Error).message, issueNumber }, 'Failed to set local git config, continuing without author config');
    }
}

function logGitStatus(status: StatusResult, worktreePath: string, issueNumber?: number): void {
    logger.debug({
        worktreePath,
        issueNumber,
        tracked: (status as StatusResult & { tracked?: string[] }).tracked?.length || 0,
        notAdded: status.not_added?.length || 0,
        conflicted: status.conflicted?.length || 0,
        created: status.created?.length || 0,
        deleted: status.deleted?.length || 0,
        modified: status.modified?.length || 0,
        renamed: status.renamed?.length || 0,
        staged: status.staged?.length || 0,
        totalFiles: status.files?.length || 0
    }, 'Git status before commit');
}

function resolveCommitMessage(commitMessage: string | CommitMessageObject, issueNumber?: number, issueTitle?: string): string {
    if (typeof commitMessage === 'object' && commitMessage.claudeSuggested) {
        return commitMessage.claudeSuggested;
    }
    if (typeof commitMessage === 'string') {
        return commitMessage;
    }
    const shortTitle = issueTitle ? issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
    return `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}\n\nImplemented by Claude Code. Full conversation log in PR comment.`;
}

export async function commitChanges(worktreePath: string, commitMessage: string | CommitMessageObject, author: Author | null, options: CommitOptions = {}): Promise<CommitResult | null> {
    const { issueNumber, issueTitle } = options;
    try {
        await validateWorktree(worktreePath, issueNumber);
    } catch (validationError) {
        logger.error({ worktreePath, issueNumber, error: (validationError as Error).message }, 'Worktree validation failed');
        throw validationError;
    }

    const git: SimpleGit = simpleGit({ baseDir: worktreePath });
    logger.debug({ worktreePath, issueNumber }, 'Initializing git operations in worktree');

    try {
        await configureGitAuthor(git, author, worktreePath, issueNumber);

        await git.add('.');
        // Unstage .propr/assets if it was staged - this directory should never be committed
        try {
            await git.raw(['reset', 'HEAD', '--', '.propr/assets']);
        } catch {
            // Ignore error if .propr/assets doesn't exist or wasn't staged
        }
        const status = await git.status();

        logGitStatus(status, worktreePath, issueNumber);

        if (status.files.length === 0) {
            logger.info({ worktreePath }, 'No changes to commit');
            return null;
        }

        logger.info({
            worktreePath,
            issueNumber,
            totalFiles: status.files.length,
            files: status.files.map((f: FileStatusResult) => ({ path: f.path, index: f.index, working_dir: f.working_dir }))
        }, 'Files to be committed');

        const finalCommitMessage = resolveCommitMessage(commitMessage, issueNumber, issueTitle);

        const result = await git.commit(finalCommitMessage);
        const commitHash = result.commit.replace(/^HEAD\s+/, '');

        logger.info({ worktreePath, commitHash, filesChanged: status.files.length, issueNumber, commitMessage: finalCommitMessage }, 'Changes committed successfully');

        return { commitHash, commitMessage: finalCommitMessage };

    } catch (error) {
        handleError(error, `Failed to commit changes in worktree ${worktreePath}`);
        throw error;
    }
}
