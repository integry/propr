import { SimpleGit, StatusResult, FileStatusResult } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { createHooklessGit } from './hooklessGit.js';
import { VISUAL_PREVIEW_RUNTIME_DIRECTORIES } from '../services/visualPreviewPaths.js';

interface Author {
    name: string;
    email: string;
}

export const AI_COMMIT_AUTHOR: Author = {
    name: process.env.PROPR_AGENT_COMMIT_AUTHOR_NAME || 'propr-dev[bot]',
    email: process.env.PROPR_AGENT_COMMIT_AUTHOR_EMAIL || `${process.env.GH_APP_ID || '1316198'}+propr-dev[bot]@users.noreply.github.com`,
};

interface CommitMessageObject {
    claudeSuggested?: string;
}

interface CommitOptions {
    issueNumber?: number;
    issueTitle?: string;
    /** Create an empty commit when a remote branch must exist before agent edits begin. */
    allowEmpty?: boolean;
    /** Exact repository-relative changed files to stage. Omitted means all changed files. */
    include?: string[];
    /** Exact repository-relative changed files to leave unstaged. */
    exclude?: string[];
}

const GENERATED_PROPR_RUNTIME_PATHS = [
    '.propr/assets',
    '.propr/cache',
    '.propr/.cache',
    '.propr/node_modules',
    ...VISUAL_PREVIEW_RUNTIME_DIRECTORIES,
];

export class InvalidCheckpointScopeError extends Error {}

function validateScopedPath(file: string): string {
    if (!file || file.trim() !== file || file.includes('\\') || file.includes('\0') || file.includes('\n') || file.includes('\r')
        || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file
        || file.split('/').some(part => part === '..' || part === '.git')) {
        throw new InvalidCheckpointScopeError(`Checkpoint path must be a normalized repository-relative file: ${JSON.stringify(file)}`);
    }
    return file;
}

function isGeneratedRuntimePath(file: string): boolean {
    return GENERATED_PROPR_RUNTIME_PATHS.some(generated => file === generated || file.startsWith(`${generated}/`));
}

async function stageCommitFiles(git: SimpleGit, options: CommitOptions): Promise<void> {
    const scoped = options.include !== undefined || options.exclude !== undefined;
    if (!scoped) {
        await git.add('.');
        for (const generatedPath of GENERATED_PROPR_RUNTIME_PATHS) {
            try { await git.raw(['reset', 'HEAD', '--', generatedPath]); } catch { /* path was not staged */ }
        }
        return;
    }
    const include = options.include?.map(validateScopedPath);
    const exclude = new Set((options.exclude ?? []).map(validateScopedPath));
    if (include?.some(file => exclude.has(file))) {
        throw new InvalidCheckpointScopeError('Checkpoint include and exclude paths must not overlap');
    }
    const before = await git.status();
    const changed = new Set(before.files.map(file => file.path));
    const missing = include?.filter(file => !changed.has(file)) ?? [];
    if (missing.length > 0) throw new InvalidCheckpointScopeError(`Checkpoint include path is not a changed file: ${missing.join(', ')}`);
    const selected = (include ?? [...changed])
        .filter(file => !exclude.has(file) && !isGeneratedRuntimePath(file));
    // The worker owns the index. Clear it before staging the declared scope so
    // unrelated parallel work cannot leak into this commit.
    await git.raw(['reset', 'HEAD', '--', '.']);
    if (selected.length > 0) await git.raw(['add', '--', ...selected.map(file => `:(literal)${file}`)]);
}

export interface CommitResult {
    commitHash: string;
    commitMessage: string;
    filesChanged?: string[];
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
    return `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}\n\nImplemented by ProPR AI. Full conversation log in PR comment.`;
}

function assertNoUnmergedEntries(status: StatusResult): void {
    if (status.conflicted.length > 0) {
        throw new Error(`Cannot commit with unresolved index entries: ${status.conflicted.join(', ')}`);
    }
}

async function getPendingMergeHead(git: SimpleGit): Promise<string | null> {
    try {
        return (await git.raw(['rev-parse', '--verify', 'MERGE_HEAD'])).trim() || null;
    } catch {
        return null;
    }
}

export async function commitChanges(worktreePath: string, commitMessage: string | CommitMessageObject, author: Author | null, options: CommitOptions = {}): Promise<CommitResult | null> {
    const { issueNumber, issueTitle, allowEmpty = false } = options;
    try {
        await validateWorktree(worktreePath, issueNumber);
    } catch (validationError) {
        logger.error({ worktreePath, issueNumber, error: (validationError as Error).message }, 'Worktree validation failed');
        throw validationError;
    }

    const git: SimpleGit = createHooklessGit(worktreePath);
    logger.debug({ worktreePath, issueNumber }, 'Initializing git operations in worktree');

    try {
        await configureGitAuthor(git, author, worktreePath, issueNumber);

        // A merge conflict is only resolved once its index entries have been
        // explicitly staged. Do not let staging below silently turn an
        // unresolved index into a commit candidate.
        assertNoUnmergedEntries(await git.status());

        await stageCommitFiles(git, options);
        const status = await git.status();
        const stagedFiles = status.files.filter((file: FileStatusResult) => file.index !== ' ' && file.index !== '?');

        logGitStatus(status, worktreePath, issueNumber);
        assertNoUnmergedEntries(status);

        // A resolved merge can legitimately have the same tree as HEAD. Git
        // still needs a commit in that case to record MERGE_HEAD as the second
        // parent and preserve the requested base in branch ancestry.
        const pendingMergeHead = await getPendingMergeHead(git);

        if (stagedFiles.length === 0 && !allowEmpty && !pendingMergeHead) {
            logger.info({ worktreePath }, 'No changes to commit');
            return null;
        }

        logger.info({
            worktreePath,
            issueNumber,
            totalFiles: stagedFiles.length,
            files: stagedFiles.map((f: FileStatusResult) => ({ path: f.path, index: f.index, working_dir: f.working_dir })),
            pendingMergeHead,
        }, pendingMergeHead && stagedFiles.length === 0 ? 'Finalizing pending merge with no tree changes' : 'Files to be committed');

        const finalCommitMessage = resolveCommitMessage(commitMessage, issueNumber, issueTitle);

        const result = allowEmpty && stagedFiles.length === 0
            ? await git.raw(['commit', '--allow-empty', '-m', finalCommitMessage])
            : await git.commit(finalCommitMessage);
        const commitHash = typeof result === 'string'
            ? (await git.revparse(['HEAD'])).trim()
            : result.commit.replace(/^HEAD\s+/, '');

        logger.info({ worktreePath, commitHash, filesChanged: stagedFiles.length, issueNumber, commitMessage: finalCommitMessage }, 'Changes committed successfully');

        return {
            commitHash,
            commitMessage: finalCommitMessage,
            filesChanged: stagedFiles.map((file: FileStatusResult) => file.path)
        };

    } catch (error) {
        handleError(error, `Failed to commit changes in worktree ${worktreePath}`);
        throw error;
    }
}
