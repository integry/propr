/**
 * Sandboxed workspace for an agent report run.
 *
 * With `repository_read` the primary repository is checked out through the
 * same clone + worktree helpers every other job uses, and additional
 * repositories are shallow read-only copies under `.propr/context/`. Without
 * it the agent gets an empty `git init` directory: agents expect a git
 * workspace, but no source code is mounted. Input files are copied into
 * `.propr/agent-inputs/` either way.
 *
 * Nothing here commits or pushes. The worktree branch exists only so
 * `createWorktreeForIssue` can be reused unchanged, and it is deleted on cleanup.
 */

import path from 'node:path';
import fs from 'fs-extra';
import type { Logger } from 'pino';
import {
    cleanupWorktree,
    createHooklessGit,
    createWorktreeForIssue,
    ensureGitRepository,
    ensureRepoCloned,
    getRepoUrl,
    logger as defaultLogger,
    setupWorktreePermissions,
    type Attachment,
    type StoredAgentDefinition,
} from '@propr/core';
import type { AgentReportPromptAttachment, AgentReportPromptWorkspace } from './reportPrompt.js';

/** Where the API stores a definition's input files (`storage/agent-definitions/<definitionId>/`). */
export const AGENT_DEFINITION_INPUT_ROOT = path.join(process.cwd(), 'storage', 'agent-definitions');
/** Workspace-relative directory the input files are copied into. */
export const AGENT_INPUTS_DIR = path.join('.propr', 'agent-inputs');
/** Workspace-relative directory additional repositories are copied into. */
export const AGENT_CONTEXT_DIR = path.join('.propr', 'context');

const WORKTREES_BASE_PATH = process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees';
/** Scratch workspaces (no repository_read) live beside the repository worktrees. */
export const AGENT_RUN_SCRATCH_ROOT = path.join(WORKTREES_BASE_PATH, '_agent-runs');

export interface AgentRunWorkspace {
    worktreePath: string;
    branchName: string;
    /** Paths and repository availability as the prompt builder describes them. */
    promptWorkspace: AgentReportPromptWorkspace;
    attachments: AgentReportPromptAttachment[];
    /** Removes the worktree or scratch directory; never throws. */
    cleanup(): Promise<void>;
}

export interface PrepareAgentRunWorkspaceInput {
    runId: string;
    definition: StoredAgentDefinition;
    githubToken: string;
    /** Used to detect the default branch of the primary repository. */
    octokit?: unknown;
    logger?: Logger;
}

export type PrepareAgentRunWorkspace = (input: PrepareAgentRunWorkspaceInput) => Promise<AgentRunWorkspace>;

export function splitRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
    return { owner, repo };
}

/** Workspace-relative directory of an additional repository: `.propr/context/<owner>__<repo>`. */
export function contextRepositoryDir(repository: string): string {
    const { owner, repo } = splitRepository(repository);
    return path.join(AGENT_CONTEXT_DIR, `${owner}__${repo}`);
}

function safeFileName(name: string, used: Set<string>): string {
    const base = path.basename(name).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim() || 'input';
    let candidate = base;
    for (let index = 2; used.has(candidate.toLowerCase()); index++) {
        const extension = path.extname(base);
        candidate = `${base.slice(0, base.length - extension.length)}-${index}${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * Copy the definition's input files into `.propr/agent-inputs/`. Only files
 * inside the definition's own storage folder are copied; a stored path that
 * points elsewhere is skipped.
 */
export async function copyAgentInputFiles(
    workspacePath: string,
    definitionId: string,
    attachments: readonly Attachment[],
    { log = defaultLogger, inputRoot = AGENT_DEFINITION_INPUT_ROOT }: { log?: Pick<Logger, 'warn'>; inputRoot?: string } = {},
): Promise<AgentReportPromptAttachment[]> {
    if (attachments.length === 0) return [];
    const sourceDir = path.join(inputRoot, path.basename(definitionId));
    const targetDir = path.join(workspacePath, AGENT_INPUTS_DIR);
    await fs.ensureDir(targetDir);
    const used = new Set<string>();
    const copied: AgentReportPromptAttachment[] = [];
    for (const attachment of attachments) {
        const source = path.resolve(process.cwd(), attachment.storedPath);
        if (!source.startsWith(`${sourceDir}${path.sep}`) || !await fs.pathExists(source)) {
            log.warn({ definitionId, attachmentId: attachment.id }, 'Agent input file is missing or outside the definition folder; skipping it');
            continue;
        }
        const fileName = safeFileName(attachment.originalName, used);
        await fs.copy(source, path.join(targetDir, fileName));
        copied.push({ originalName: attachment.originalName, workspacePath: path.join(AGENT_INPUTS_DIR, fileName) });
    }
    return copied;
}

/**
 * Shallow, single-branch copy of an additional repository. The credential is
 * only used for the clone and removed from the copy's remote afterwards.
 */
async function cloneContextRepository(repository: string, destination: string, githubToken: string): Promise<void> {
    const { owner, repo } = splitRepository(repository);
    const publicUrl = getRepoUrl({ repoOwner: owner, repoName: repo });
    const authenticatedUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;
    await fs.ensureDir(path.dirname(destination));
    try {
        await createHooklessGit().clone(authenticatedUrl, destination, ['--depth=1', '--single-branch', '--no-tags']);
    } catch (error) {
        throw new Error(`Could not clone ${repository}: ${(error as Error).message.split(githubToken).join('***')}`);
    }
    await createHooklessGit(destination).remote(['set-url', 'origin', publicUrl]);
}

async function prepareRepositoryWorkspace(input: PrepareAgentRunWorkspaceInput, log: Logger): Promise<AgentRunWorkspace> {
    const { runId, definition, githubToken, octokit } = input;
    const [primary, ...additional] = definition.repositories;
    const { owner, repo } = splitRepository(primary);

    await ensureGitRepository(log);
    const localRepoPath = await ensureRepoCloned({
        repoUrl: getRepoUrl({ repoOwner: owner, repoName: repo }), owner, repoName: repo, authToken: githubToken,
    });
    const worktree = await createWorktreeForIssue(
        localRepoPath,
        { issueId: 'agent-run', issueTitle: runId, owner, repoName: repo },
        { baseBranch: null, octokit: (octokit ?? null) as never },
    );
    const cleanup = async (): Promise<void> => {
        try {
            await cleanupWorktree(localRepoPath, worktree.worktreePath, worktree.branchName, { deleteBranch: true, success: true });
        } catch (error) {
            log.warn({ runId, worktreePath: worktree.worktreePath, error: (error as Error).message }, 'Failed to clean up agent run worktree');
        }
    };

    try {
        const contextRepositories: string[] = [];
        for (const repository of additional) {
            const relative = contextRepositoryDir(repository);
            await cloneContextRepository(repository, path.join(worktree.worktreePath, relative), githubToken);
            contextRepositories.push(relative);
        }
        const attachments = await copyAgentInputFiles(worktree.worktreePath, definition.id, definition.attachments, { log });
        await setupWorktreePermissions(worktree.worktreePath, worktree.branchName, 'agent-run');
        return {
            worktreePath: worktree.worktreePath,
            branchName: worktree.branchName,
            promptWorkspace: { repositoriesReadable: true, primaryRepository: '.', contextRepositories },
            attachments,
            cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

async function prepareScratchWorkspace(input: PrepareAgentRunWorkspaceInput, log: Logger): Promise<AgentRunWorkspace> {
    const { runId, definition } = input;
    const worktreePath = path.join(AGENT_RUN_SCRATCH_ROOT, path.basename(runId));
    const branchName = `agent-run/${runId}`;
    const cleanup = async (): Promise<void> => {
        try {
            await fs.remove(worktreePath);
        } catch (error) {
            log.warn({ runId, worktreePath, error: (error as Error).message }, 'Failed to remove agent run scratch directory');
        }
    };

    try {
        await fs.remove(worktreePath);
        await fs.ensureDir(worktreePath);
        await createHooklessGit(worktreePath).init(['--initial-branch', branchName]);
        const attachments = await copyAgentInputFiles(worktreePath, definition.id, definition.attachments, { log });
        await setupWorktreePermissions(worktreePath, branchName, 'agent-run');
        return {
            worktreePath,
            branchName,
            promptWorkspace: { repositoriesReadable: false, primaryRepository: '.', contextRepositories: [] },
            attachments,
            cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

/**
 * Prepare the workspace for a report run. Cleans up after itself when
 * preparation fails part way; on success the caller owns `cleanup()`.
 */
export const prepareAgentRunWorkspace: PrepareAgentRunWorkspace = async input => {
    const log = input.logger ?? (defaultLogger as unknown as Logger);
    const readable = input.definition.capabilities.includes('repository_read') && input.definition.repositories.length > 0;
    return readable ? prepareRepositoryWorkspace(input, log) : prepareScratchWorkspace(input, log);
};
