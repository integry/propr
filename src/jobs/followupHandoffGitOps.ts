import { access } from 'node:fs/promises';
import { commitChanges, createHooklessGit, logger, releaseBranchFromSettledWorktree } from '@propr/core';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { pushPullRequestHeadBranch } from './prGitOperations.js';

/**
 * Git evidence and publication operations over a retained follow-up worktree.
 * Everything here is non-destructive to the worktree's files and commits.
 */

export type WorktreeAttachment = 'missing' | 'not_on_branch' | 'attached';

/**
 * Matches core pushBranch's non-fast-forward rejection messages. Kept local so
 * the enumerated @propr/core test mocks of the handoff suites stay valid.
 */
export function isNonFastForwardPushError(error: unknown): boolean {
    const message = (error as Error).message || '';
    return message.includes('[rejected] (fetch first)')
        || message.includes('non-fast-forward')
        || message.includes('Updates were rejected because the remote contains work that you do not');
}

export interface FollowupHandoffGitOps {
    /** 'missing' only when the path provably does not exist; any other access failure rejects. */
    worktreeAttachment(worktreePath: string, branchName: string): Promise<WorktreeAttachment>;
    /**
     * Linked worktrees the repository's Git registrations still record as
     * holding the branch — including registrations whose directory is gone.
     * Rejects when the registrations cannot be read.
     */
    branchWorktreeRegistrations(localRepoPath: string, branchName: string): Promise<string[]>;
    hasUncommittedChanges(worktreePath: string): Promise<boolean>;
    commitWork(worktreePath: string, message: string, pullRequestNumber: number): Promise<{ commitHash: string } | null>;
    hasUnpushedCommits(worktreePath: string, branchName: string): Promise<boolean>;
    head(worktreePath: string): Promise<string>;
    /** Freshly fetched remote head of the branch, null when no remote ref exists; rejects when the remote is unreachable. */
    remoteBranchHead(worktreePath: string, branchName: string): Promise<string | null>;
    /** Whether the given commit is the worktree HEAD or one of its ancestors. */
    isAncestorOfHead(worktreePath: string, sha: string): Promise<boolean>;
    push(worktreePath: string, target: { repoOwner: string; repoName: string; branchName: string }): Promise<{ commitHash?: string } | void>;
    /**
     * Frees the branch from a settled retained worktree; keeps the worktree
     * itself. Generated runtime output commits never stage does not count as
     * unsettled work.
     */
    releaseSettledWorktree(localRepoPath: string, branchName: string, worktreePath: string): Promise<boolean>;
    /** Detaches the worktree HEAD in place: commits and working-tree files all stay. */
    detachWorktreeHead(worktreePath: string): Promise<void>;
    /**
     * Restarts the clone's local branch from the freshly fetched remote head
     * when it carries commits the remote lacks, keeping them under
     * refs/propr/superseded/. A released attempt's unpublished commits would
     * otherwise stay the branch tip and be inherited, then pushed, by the
     * next worktree created from the branch. True once the branch holds
     * nothing the remote lacks; false, changing nothing, when that could not
     * be ensured (no remote head, branch still checked out, fetch failed).
     */
    restartBranchFromRemoteHead(localRepoPath: string, branchName: string): Promise<boolean>;
    /**
     * Rebuilds a deleted worktree at its recorded path on the clone's local
     * branch, so commits the agent made survive (they live in the shared
     * clone, not the deleted folder). Clears the stale registration only when
     * core proves it holds nothing beyond stored refs. False, changing
     * nothing it cannot undo, when the worktree cannot be restored safely.
     */
    restoreMissingWorktree?(localRepoPath: string, worktreePath: string, branchName: string): Promise<boolean>;
}

async function fetchRemoteBranch(worktreePath: string, branchName: string): Promise<boolean> {
    try {
        await createHooklessGit(worktreePath).raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
        return true;
    } catch {
        return false;
    }
}

/** Paths named by `git status --porcelain -z` entries, including both sides of a rename or copy. */
function porcelainPaths(status: string): string[] {
    const tokens = status.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const code = tokens[index].slice(0, 2);
        paths.push(tokens[index].slice(3));
        if (code.includes('R') || code.includes('C')) paths.push(tokens[++index] ?? '');
    }
    return paths;
}

/**
 * Detaches a worktree whose only uncommitted content is generated runtime
 * output (which commits unstage, so it can never be published) and whose HEAD
 * the freshly fetched remote branch already contains. Core's settled-worktree
 * release refuses any dirty status, which would otherwise strand such a branch
 * behind a no-change or published recovery. Files and commits all stay.
 */
async function releaseGeneratedOnlyWorktree(worktreePath: string, branchName: string): Promise<boolean> {
    // Lazy import: test suites replace @propr/core with enumerated mocks.
    const { isGeneratedRuntimePath } = await import('@propr/core');
    // A deleted worktree holds nothing to inspect (simple-git throws on a missing directory).
    if (!await pathExists(worktreePath)) return false;
    const worktreeGit = createHooklessGit(worktreePath);
    try {
        if ((await worktreeGit.raw(['branch', '--show-current'])).trim() !== branchName) return false;
        const dirty = porcelainPaths(await worktreeGit.raw(['status', '--porcelain', '-z', '--untracked-files=all']));
        if (dirty.length === 0 || !dirty.every(file => isGeneratedRuntimePath(file))) return false;
        if (!await fetchRemoteBranch(worktreePath, branchName)) return false;
        const unpushed = (await worktreeGit.raw(['rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`])).trim();
        if (unpushed !== '0') return false;
        await worktreeGit.raw(['checkout', '--detach']);
        return true;
    } catch {
        return false;
    }
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await access(target);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
    }
}

async function restoreMissingWorktree(localRepoPath: string, worktreePath: string, branchName: string, getToken: () => Promise<string>): Promise<boolean> {
    // Lazy import: test suites replace @propr/core with enumerated mocks.
    const { clearMissingWorktreeRegistration, configureGitAuthentication, setupWorktreePermissions } = await import('@propr/core');
    if (await pathExists(worktreePath) || !await pathExists(localRepoPath)) return false;
    const git = createHooklessGit(localRepoPath);
    const listing = await git.raw(['worktree', 'list', '--porcelain']);
    const registered = listing.split('\n\n').some(entry => entry.split('\n').includes(`worktree ${worktreePath}`));
    if (registered && !await clearMissingWorktreeRegistration(git, worktreePath)) return false;
    // The local branch keeps commits the agent made but never pushed; only a
    // branch the clone never had starts from the remote head.
    const local = (await git.raw(['branch', '--list', branchName])).trim();
    if (local) {
        await git.raw(['worktree', 'add', worktreePath, branchName]);
    } else {
        // The clone's origin is the clean repository URL, so the fetch is
        // authenticated per command like every other remote operation here.
        configureGitAuthentication(git, await getToken());
        await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
        await git.raw(['worktree', 'add', '--no-track', '-b', branchName, worktreePath, `refs/remotes/origin/${branchName}`]);
    }
    await setupWorktreePermissions(worktreePath, branchName, null);
    return true;
}

/** Default Git evidence and publication operations over the retained worktree. */
export function createFollowupHandoffGitOps(getToken: () => Promise<string>): FollowupHandoffGitOps {
    return {
        async worktreeAttachment(worktreePath, branchName) {
            try {
                await access(worktreePath);
            } catch (error) {
                // A permission or I/O failure is unavailable evidence, not
                // proof the worktree (or its branch registration) is gone.
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
                throw error;
            }
            const current = (await createHooklessGit(worktreePath).raw(['branch', '--show-current'])).trim();
            return current === branchName ? 'attached' : 'not_on_branch';
        },
        async branchWorktreeRegistrations(localRepoPath, branchName) {
            // Git keeps a worktree's registration (and its claim on the branch)
            // separately from the directory, so a removed directory can still
            // hold the branch until the registration itself is gone.
            const listing = await createHooklessGit(localRepoPath).raw(['worktree', 'list', '--porcelain']);
            return listing.split('\n\n').map(entry => entry.split('\n'))
                .filter(lines => lines.includes(`branch refs/heads/${branchName}`))
                .map(lines => lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? '')
                .filter(holder => holder !== localRepoPath);
        },
        async hasUncommittedChanges(worktreePath) {
            const status = await createHooklessGit(worktreePath).raw(['status', '--porcelain', '--untracked-files=all']);
            return status.trim().length > 0;
        },
        async commitWork(worktreePath, message, pullRequestNumber) {
            return commitChanges(worktreePath, message, AI_COMMIT_AUTHOR, { issueNumber: pullRequestNumber, issueTitle: 'Recovered follow-up changes' });
        },
        async hasUnpushedCommits(worktreePath, branchName) {
            // Offline comparison against the last known remote ref is still safe
            // here: it can only overestimate the unpushed work, and the push that
            // publishes it revalidates against freshly fetched remote evidence.
            await fetchRemoteBranch(worktreePath, branchName);
            try {
                const unpushed = await createHooklessGit(worktreePath).raw(['rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`]);
                return unpushed.trim() !== '0';
            } catch {
                // No remote ref yet: everything on the branch is unpublished.
                return true;
            }
        },
        async head(worktreePath) {
            return (await createHooklessGit(worktreePath).raw(['rev-parse', 'HEAD'])).trim();
        },
        async remoteBranchHead(worktreePath, branchName) {
            // Publication-binding validation treats this as current authority, so
            // an unreachable remote fails closed instead of answering with a
            // cached ref another contributor may have advanced past.
            if (!await fetchRemoteBranch(worktreePath, branchName)) {
                throw new Error(`Could not fetch refs/heads/${branchName} from origin; current remote publication evidence is unavailable`);
            }
            try {
                return (await createHooklessGit(worktreePath).raw(['rev-parse', `refs/remotes/origin/${branchName}`])).trim();
            } catch {
                return null;
            }
        },
        async isAncestorOfHead(worktreePath, sha) {
            try {
                await createHooklessGit(worktreePath).raw(['merge-base', '--is-ancestor', sha, 'HEAD']);
                return true;
            } catch {
                return false;
            }
        },
        async push(worktreePath, target) {
            return pushPullRequestHeadBranch({
                worktreePath,
                target: { ...target, isFork: false },
                authToken: await getToken(),
                // Recovery must fail closed when another actor advanced the PR
                // head: the rejection is held for an operator, never rebased over.
                rebaseOnNonFastForward: false,
            }) as Promise<{ commitHash?: string } | void>;
        },
        async releaseSettledWorktree(localRepoPath, branchName, worktreePath) {
            return await releaseBranchFromSettledWorktree(createHooklessGit(localRepoPath), branchName, worktreePath)
                || await releaseGeneratedOnlyWorktree(worktreePath, branchName);
        },
        async detachWorktreeHead(worktreePath) {
            await createHooklessGit(worktreePath).raw(['checkout', '--detach']);
        },
        async restartBranchFromRemoteHead(localRepoPath, branchName) {
            // Lazy import: test suites replace @propr/core with enumerated mocks.
            const { configureGitAuthentication, restartBranchFromRemoteHead } = await import('@propr/core');
            const git = createHooklessGit(localRepoPath);
            try {
                // The clone's origin is the clean repository URL; the fetch is authenticated per command.
                configureGitAuthentication(git, await getToken());
                await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
                return await restartBranchFromRemoteHead(git, branchName);
            } catch (error) {
                logger.warn({ localRepoPath, branchName, error: (error as Error).message },
                    'Could not restart the local branch from the remote head after a release');
                return false;
            }
        },
        async restoreMissingWorktree(localRepoPath, worktreePath, branchName) {
            return restoreMissingWorktree(localRepoPath, worktreePath, branchName, getToken);
        },
    };
}
