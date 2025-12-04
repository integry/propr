import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

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
