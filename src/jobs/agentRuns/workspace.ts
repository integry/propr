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
    configureGitAuthentication,
    createHooklessGit,
    createWorktreeForIssue,
    ensureGitRepository,
    ensureRepoCloned,
    getRepoUrl,
    logger as defaultLogger,
    resolveEffectiveContextRepositories,
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
    /** The primary repository's context policy; defaults to its repository settings. */
    resolveContextPolicy?: (repository: string) => Promise<string[] | undefined>;
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

/**
 * Make a reserved workspace directory (`.propr/agent-inputs`, `.propr/context`)
 * a fresh, empty, real directory and return its resolved path. The checked-out
 * repository controls these paths, so a tracked symlink or file on the way
 * (or anything already at the leaf) is removed first; otherwise host-side
 * writes could follow it outside the workspace.
 */
export async function prepareReservedDirectory(workspacePath: string, relativeDir: string): Promise<string> {
    const root = await fs.realpath(workspacePath);
    const segments = path.normalize(relativeDir).split(path.sep).filter(Boolean);
    if (segments.length === 0 || segments.includes('..')) throw new Error(`Invalid reserved workspace directory: ${relativeDir}`);
    let current = root;
    for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (stat?.isDirectory() && index < segments.length - 1) continue;
        // fs.remove unlinks a symlink itself, never its target.
        if (stat) await fs.remove(current);
        await fs.mkdir(current);
    }
    const resolved = await fs.realpath(current);
    if (resolved !== path.join(root, ...segments)) {
        throw new Error(`Reserved workspace directory ${relativeDir} resolves outside the workspace`);
    }
    return resolved;
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
    const targetDir = await prepareReservedDirectory(workspacePath, AGENT_INPUTS_DIR);
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
 * Shallow, single-branch copy of an additional repository. The destination
 * lies under a directory running agent containers can read, so the credential
 * is supplied through this command's environment only: the clone URL, and so
 * the copy's `.git/config`, never contains it, not even while the clone runs.
 */
export async function cloneContextRepository(repository: string, destination: string, githubToken: string): Promise<void> {
    const { owner, repo } = splitRepository(repository);
    const publicUrl = getRepoUrl({ repoOwner: owner, repoName: repo });
    await fs.ensureDir(path.dirname(destination));
    const git = createHooklessGit();
    configureGitAuthentication(git, githubToken);
    try {
        await git.clone(publicUrl, destination, ['--depth=1', '--single-branch', '--no-tags']);
    } catch (error) {
        throw new Error(`Could not clone ${repository}: ${(error as Error).message.split(githubToken).join('***')}`);
    }
}

/**
 * Reject additional repositories the primary repository's context policy
 * excludes. The agent's scoped token and clone mounts follow the same policy,
 * but cannot take back files already copied into the workspace.
 */
export function assertContextRepositoriesAllowed(primary: string, additional: readonly string[], allowed: readonly string[] | undefined): void {
    if (!allowed) return;
    const excluded = additional.filter(repository => !allowed.includes(repository.toLowerCase()));
    if (excluded.length > 0) {
        throw new Error(`The contextRepositories setting of ${primary} does not allow reading ${excluded.join(', ')}. Remove ${excluded.length === 1 ? 'it' : 'them'} from the agent definition or allow ${excluded.length === 1 ? 'it' : 'them'} in the repository settings.`);
    }
}

async function prepareRepositoryWorkspace(input: PrepareAgentRunWorkspaceInput, log: Logger): Promise<AgentRunWorkspace> {
    const { runId, definition, githubToken, octokit, resolveContextPolicy = resolveEffectiveContextRepositories } = input;
    const [primary, ...additional] = definition.repositories;
    const { owner, repo } = splitRepository(primary);
    if (additional.length > 0) assertContextRepositoriesAllowed(primary, additional, await resolveContextPolicy(primary));

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
        const contextRoot = additional.length > 0 ? await prepareReservedDirectory(worktree.worktreePath, AGENT_CONTEXT_DIR) : '';
        for (const repository of additional) {
            const relative = contextRepositoryDir(repository);
            await cloneContextRepository(repository, path.join(contextRoot, path.basename(relative)), githubToken);
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

/** Whether a run of this definition checks out repositories (and so needs GitHub access). */
export function definitionReadsRepositories(definition: StoredAgentDefinition): boolean {
    return definition.capabilities.includes('repository_read') && definition.repositories.length > 0;
}

/**
 * Prepare the workspace for a report run. Cleans up after itself when
 * preparation fails part way; on success the caller owns `cleanup()`.
 */
export const prepareAgentRunWorkspace: PrepareAgentRunWorkspace = async input => {
    const log = input.logger ?? (defaultLogger as unknown as Logger);
    return definitionReadsRepositories(input.definition) ? prepareRepositoryWorkspace(input, log) : prepareScratchWorkspace(input, log);
};
