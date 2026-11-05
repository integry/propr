import { repositoryStorageLifecycle } from '../storage/lifecycle.js';
import { SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    setupWorktreePermissions,
    addToSafeDirectories,
    verifyWorktreeCreation,
    setupWorktreeRemote,
    getWorktreePath
} from './worktreeOperations.js';
import { createHooklessGit } from './hooklessGit.js';
import { assertRepositoryClonePath, resolveRepositoryClonePath } from './repositoryPaths.js';
import { configureGitRemoteAuthentication, redactAuthenticatedGitUrl } from './repoBranching.js';
import { isRescueRef } from './rescueRefs.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';

/**
 * Inspect ref output rather than promise resolution: simple-git can resolve a
 * nonzero exit without stderr (including show-ref in an empty repository).
 * Listing heads gives us exact names and reports corrupt refs as Git errors.
 * Let those errors propagate rather than treating an unreadable repo as empty.
 */
async function localBranchExists(git: SimpleGit, branchName: string): Promise<boolean> {
    const ref = `refs/heads/${branchName}`;
    const refs = await git.raw(['show-ref', '--heads']);
    return refs.split('\n').some(line => line.split(' ')[1] === ref);
}

/**
 * Create a worktree branch without recording an upstream in the shared clone
 * config. Parallel issue jobs use the same clone, so implicit tracking writes
 * from `git worktree add` can race on `.git/config.lock` even though their
 * branches and worktree directories are distinct.
 */
export async function addWorktreeWithoutTracking(
    git: SimpleGit,
    worktreePath: string,
    branchName: string,
    options: {
        startPoint: string;
        resetBranch?: boolean;
    },
): Promise<string> {
    const { startPoint, resetBranch = false } = options;
    if (resetBranch) {
        const exists = await localBranchExists(git, branchName);
        if (exists) {
            await realignDivergedLocalBranch(git, branchName, startPoint);
            return git.raw(['worktree', 'add', worktreePath, branchName]);
        }
    }
    return git.raw([
        'worktree',
        'add',
        '--no-track',
        '-b',
        branchName,
        worktreePath,
        startPoint,
    ]);
}

/**
 * Brings a reused local branch onto its start point (the pull request head)
 * without losing commits. A branch behind is fast-forwarded. A branch ahead
 * keeps its unpushed commits. A diverged branch (the remote was rebased or
 * force-pushed) is treated as failed-attempt history rather than rebased here.
 * Push salvage may already have saved it remotely at refs/propr/rescue/<taskId>;
 * refs/propr/superseded/<branch>/<time>-<sha> additionally keeps the old tip
 * locally (compare commit SHAs to reconcile the backups), and the
 * branch restarts from the start point. Otherwise every later run would build
 * on the stale history and every push would be rejected. A branch checked out
 * in any worktree is never moved.
 */
async function realignDivergedLocalBranch(git: SimpleGit, branchName: string, startPoint: string): Promise<void> {
    let target: string;
    try {
        target = (await git.raw(['rev-parse', '--verify', `${startPoint}^{commit}`])).trim();
    } catch {
        return; // No start point to align with; keep the branch as it is.
    }
    const local = (await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).trim();
    if (local === target) return;
    const behind = (await git.raw(['rev-list', '--count', target, '--not', local])).trim();
    if (behind === '0') return; // Equal content or ahead: unpushed work stays on the branch.
    await restartLocalBranch(git, branchName, { from: local, to: target, reason: `align with ${startPoint}` });
}

/** Backup ref for a superseded branch tip: the second alone can repeat, so the tip's short id keeps it unique. */
function supersededBackupRef(branchName: string, tip: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `refs/propr/superseded/${branchName}/${stamp}-${tip.slice(0, 12)}`;
}

/**
 * Moves a local branch from the tip read by the caller to `to`, keeping any
 * commit only the old tip reached under refs/propr/superseded/. The branch
 * must not be checked out in any worktree (then nothing changes and false is
 * returned), and the update is compare-and-swap on the old tip, so a
 * concurrent writer makes it throw rather than be overwritten.
 */
async function restartLocalBranch(git: SimpleGit, branchName: string, move: { from: string; to: string; reason: string }): Promise<boolean> {
    const branchRef = `refs/heads/${branchName}`;
    if ((await git.raw(['worktree', 'list', '--porcelain'])).split('\n').includes(`branch ${branchRef}`)) return false;
    const localOnly = (await git.raw(['rev-list', '--count', move.from, '--not', move.to])).trim();
    if (localOnly !== '0') {
        const backupRef = supersededBackupRef(branchName, move.from);
        await git.raw(['update-ref', backupRef, move.from]);
        logger.warn({ branchName, localHead: move.from, target: move.to, localOnlyCommits: Number(localOnly), backupRef },
            'Local branch carried commits its new tip lacks; they were kept under a backup ref and the branch restarts from the new tip');
    }
    // Compare-and-swap on the old value: a concurrent writer makes this fail rather than be overwritten.
    await git.raw(['update-ref', '-m', `propr: ${move.reason}`, branchRef, move.to, move.from]);
    return true;
}

/**
 * Restarts a local branch from its freshly fetched remote head when it carries
 * commits the remote lacks. Those commits belong to an attempt that is over and
 * must not be published (a cancelled request, a failed attempt whose retry
 * starts over), yet a reused branch keeps commits it is ahead by, so the next
 * worktree would inherit and push them. The commits are kept under
 * refs/propr/superseded/. Returns true once the branch holds nothing the
 * remote lacks, and false, changing nothing, when there is no remote head or
 * the branch is checked out somewhere; a concurrent move throws. The caller
 * fetches `refs/remotes/origin/<branch>` first.
 */
export async function restartBranchFromRemoteHead(git: SimpleGit, branchName: string): Promise<boolean> {
    let remote: string;
    try {
        remote = (await git.raw(['rev-parse', '--verify', `refs/remotes/origin/${branchName}^{commit}`])).trim();
    } catch {
        return false;
    }
    if (!await localBranchExists(git, branchName)) return true;
    const local = (await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).trim();
    if ((await git.raw(['rev-list', '--count', local, '--not', remote])).trim() === '0') return true;
    return restartLocalBranch(git, branchName, { from: local, to: remote, reason: `restart from origin/${branchName}` });
}

export async function cleanupExistingBranch(git: SimpleGit, branchName: string): Promise<void> {
    const exists = await localBranchExists(git, branchName);
    if (exists) throw new Error('Existing branch retained; use a new task branch');
}

async function handleExistingWorktreePath(): Promise<void> {
    throw new Error('Existing worktree retained; use a new worktree path');
}

/** Missing checkouts remain protected until their administrative history is proven recoverable. */
export async function removeStaleWorktreeRegistration(_git: SimpleGit, _worktreePath: string): Promise<boolean> {
    // Keep the legacy call signature without using it to prune protected state.
    void _git;
    void _worktreePath;
    // A missing checkout does not prove the administrative HEAD recoverable.
    return false;
}

async function handleWorktreeConflict(): Promise<void> {
    throw new Error('Existing worktree retained; branch is in use');
}

/** The worktree path named by Git when a branch is checked out elsewhere. */
export function worktreeHoldingBranch(message: string): string | null {
    return /already (?:used by worktree|checked out) at '([^']+)'/.exec(message)?.[1] ?? null;
}

/** Resolve symlinked ancestors even when the checkout (and its .git file) is gone. */
async function canonicalMissingPath(target: string): Promise<string> {
    try {
        return await fs.realpath(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(target);
        if (parent === target) throw error;
        return path.join(await canonicalMissingPath(parent), path.basename(target));
    }
}

/**
 * Frees a branch held only by the registration of a worktree whose checkout
 * directory is gone (removed while worktree pruning is disabled). With no
 * checkout the index may still hold staged changes; it is retained. The
 * branch ref keeps the current commit, so the registration's HEAD is detached
 * at that commit. The registration itself is kept, as retention requires.
 */
async function detachMissingWorktreeRegistration(git: SimpleGit, branchName: string, holderPath: string): Promise<boolean> {
    const commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const registrations = path.join(commonDir, 'worktrees');
    if (!await fs.pathExists(registrations)) return false;
    for (const id of await fs.readdir(registrations)) {
        const admin = path.join(registrations, id);
        const gitdir = (await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim();
        if (!gitdir || await canonicalMissingPath(gitdir) !== await canonicalMissingPath(path.join(holderPath, '.git'))) continue;
        const head = (await fs.readFile(path.join(admin, 'HEAD'), 'utf8').catch(() => '')).trim();
        if (head !== `ref: refs/heads/${branchName}`) return false;
        const commit = (await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).trim();
        await git.raw(['update-ref', '--no-deref', `worktrees/${id}/HEAD`, commit]);
        logger.warn({ branchName, holderPath, commit }, 'Released branch from the registration of a worktree whose checkout is missing; the registration is kept with a detached HEAD');
        return true;
    }
    return false;
}

/** Git's refusal to add a worktree at a path whose checkout is gone but whose registration remains. */
export function isMissingRegisteredWorktreeError(message: string): boolean {
    return /is a missing but already registered worktree/.test(message);
}

/**
 * Clears the registration of a worktree whose checkout directory is gone, so the
 * same path can be checked out again (a continued goal rebuilds its saved path).
 * Only the current HEAD and index are proven recoverable: a branch,
 * remote-tracking ref or tag must contain HEAD, and the index must match it.
 * Locked registrations and operations in progress are retained. Historical
 * logs/HEAD entries are discarded, just as with git worktree remove; abandoned
 * detached commits anchored only by that reflog may become unreachable.
 * Returns false, changing nothing, when the proof fails.
 */
export async function clearMissingWorktreeRegistration(git: SimpleGit, worktreePath: string): Promise<boolean> {
    if (await fs.pathExists(worktreePath)) return false;
    const commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const registrations = path.join(commonDir, 'worktrees');
    if (!await fs.pathExists(registrations)) return false;
    for (const id of await fs.readdir(registrations)) {
        const admin = path.join(registrations, id);
        const gitdir = (await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim();
        if (!gitdir || await canonicalMissingPath(gitdir) !== await canonicalMissingPath(path.join(worktreePath, '.git'))) continue;
        if (await fs.pathExists(path.join(admin, 'locked'))) return false;
        const head = (await fs.readFile(path.join(admin, 'HEAD'), 'utf8').catch(() => '')).trim();
        const symbolic = /^ref: (refs\/heads\/.+)$/.exec(head)?.[1];
        const commit = symbolic
            ? (await git.raw(['rev-parse', '--verify', `${symbolic}^{commit}`])).trim()
            : /^[0-9a-f]{40,64}$/.test(head) ? head : null;
        if (!commit) return false;
        // Read a count rather than an exit status (see localBranchExists).
        const unpublished = (await git.raw(['rev-list', '--count', commit, '--not', '--branches', '--remotes', '--tags'])).trim();
        if (unpublished !== '0') return false;
        // A deleted checkout can still have staged work recoverable only from
        // this index. Never infer a clean index from a recoverable HEAD.
        if (!await fs.pathExists(path.join(admin, 'index'))) return false;
        const staged = await createHooklessGit(admin).raw(['diff-index', '--cached', '--name-only', commit, '--']);
        if (staged.trim()) return false;
        // Refresh filesystem guards after the awaited Git inspection. External
        // Git processes can still race these checks; this is not an atomic lock.
        if (await fs.pathExists(worktreePath) || await fs.pathExists(path.join(admin, 'locked'))) return false;
        for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']) {
            if (await fs.pathExists(path.join(admin, marker))) return false;
        }
        if ((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim() !== head) return false;
        await fs.remove(admin);
        logger.warn({ worktreePath, commit }, 'Cleared missing worktree registration: current HEAD is stored in Git and index matches; administrative HEAD reflog history is discarded');
        return true;
    }
    return false;
}

/**
 * Frees a branch held by a worktree that has nothing left to lose: no
 * uncommitted or untracked changes, and a HEAD already contained in the
 * freshly fetched remote branch. Such a holder is typically left by an attempt
 * that was killed before cleanup (a worker restart), and would otherwise block
 * every later job on the branch. Like failure cleanup, the worktree is kept and
 * only its HEAD is detached. Returns false, changing nothing, when it is unsafe.
 */
export async function releaseBranchFromSettledWorktree(git: SimpleGit, branchName: string, holderPath: string): Promise<boolean> {
    if (!await fs.pathExists(holderPath)) {
        return detachMissingWorktreeRegistration(git, branchName, holderPath).catch(error => {
            logger.warn({ branchName, holderPath, error: redactAuthenticatedGitUrl((error as Error).message) }, 'Could not release the branch from a missing worktree\'s registration');
            return false;
        });
    }
    const holderGit = createHooklessGit(holderPath);
    const holder = (args: string[]) => holderGit.raw(['-c', `safe.directory=${holderPath}`, ...args]);
    try {
        if ((await holder(['branch', '--show-current'])).trim() !== branchName) return false;
        if ((await holder(['status', '--porcelain', '--untracked-files=all'])).trim()) return false;
        const head = (await holder(['rev-parse', 'HEAD'])).trim();
        // Read a count rather than an exit status: simple-git can resolve a
        // nonzero exit without stderr, as `merge-base --is-ancestor` produces.
        const unpushed = (await git.raw(['rev-list', '--count', head, '--not', `refs/remotes/origin/${branchName}`])).trim();
        if (unpushed !== '0') return false;
        await holder(['checkout', '--detach']);
        logger.warn({ branchName, holderPath, head }, 'Released branch from a settled worktree left by an earlier attempt; the worktree is kept with a detached HEAD');
        return true;
    } catch (error) {
        logger.warn({ branchName, holderPath, error: redactAuthenticatedGitUrl((error as Error).message) }, 'Could not check whether the worktree holding the branch is settled');
        return false;
    }
}

/**
 * Detaches a failed attempt's worktree from its branch, as failure cleanup
 * would have: the worktree is kept with every file, uncommitted changes
 * included, and only its HEAD is detached. Callers must know the attempt is
 * over. Returns false, changing nothing, unless the holder exists and is on
 * that branch.
 */
export async function releaseBranchFromLostAttemptWorktree(branchName: string, holderPath: string): Promise<boolean> {
    if (!await fs.pathExists(holderPath)) return false;
    const holderGit = createHooklessGit(holderPath);
    const holder = (args: string[]) => holderGit.raw(['-c', `safe.directory=${holderPath}`, ...args]);
    try {
        if ((await holder(['branch', '--show-current'])).trim() !== branchName) return false;
        const changes = (await holder(['status', '--porcelain', '--untracked-files=all'])).trim();
        await holder(['checkout', '--detach']);
        logger.warn({ branchName, holderPath, retainedChanges: changes ? changes.split('\n').length : 0 },
            'Released the replaced attempt\'s branch from its retained worktree; the worktree keeps its files with a detached HEAD');
        return true;
    } catch (error) {
        logger.warn({ branchName, holderPath, error: redactAuthenticatedGitUrl((error as Error).message) }, 'Could not release the replaced attempt\'s branch from its worktree');
        return false;
    }
}

/**
 * Frees a failed attempt's work branch for its replacement. An attempt killed
 * before its cleanup (a worker restart) leaves its worktree on the branch, and
 * the replacement, which continues that branch, could never check it out.
 * Returns the released worktree's path, or null when no worktree holds it.
 */
export async function releaseLostAttemptBranch(owner: string, repoName: string, branchName: string, clonesRoot = CLONES_BASE_PATH): Promise<string | null> {
    const localRepoPath = resolveRepositoryClonePath(clonesRoot, owner, repoName);
    if (!await fs.pathExists(path.join(localRepoPath, '.git'))) return null;
    const listing = await createHooklessGit(localRepoPath).raw(['worktree', 'list', '--porcelain']);
    const holder = listing.split('\n\n').map(entry => entry.split('\n'))
        .find(lines => lines.includes(`branch refs/heads/${branchName}`))
        ?.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!holder || holder === localRepoPath) return null;
    if (!await fs.pathExists(holder)) {
        return await detachMissingWorktreeRegistration(createHooklessGit(localRepoPath), branchName, holder) ? holder : null;
    }
    return await releaseBranchFromLostAttemptWorktree(branchName, holder) ? holder : null;
}

async function handleImproperWorktree(_worktreePath: string, _branchName: string, error: Error): Promise<void> {
    throw error;
}

async function handleWorktreeCreationError(git: SimpleGit, branchName: string, error: Error): Promise<void> {
    logger.error({ branchName, error: error.message }, 'Failed to create worktree from remote branch');

    try {
        const remoteBranches = await git.branch(['-r']);
        const remoteBranchExists = remoteBranches.all.includes(`origin/${branchName}`);
        if (!remoteBranchExists) {
            throw new Error(`Cannot create worktree: branch '${branchName}' not found on remote`);
        } else {
            throw new Error(`Cannot create worktree: ${error.message}`);
        }
    } catch {
        throw new Error(`Cannot create worktree: ${error.message}`);
    }
}

/** Try each targeted recovery at most once, including conflicts revealed by a retry. */
async function addWorktreeFromRemoteWithRecovery(git: SimpleGit, worktreePath: string, branchName: string): Promise<string> {
    const addWorktree = () => addWorktreeWithoutTracking(
        git,
        worktreePath,
        branchName,
        { startPoint: `origin/${branchName}`, resetBranch: true },
    );
    let clearedMissing = false;
    let releasedHolder = false;
    for (;;) {
        try {
            return await addWorktree();
        } catch (error) {
            const message = (error as Error).message || '';
            if (!clearedMissing && isMissingRegisteredWorktreeError(message)) {
                const cleared = await clearMissingWorktreeRegistration(git, worktreePath).catch(inspectionError => {
                    logger.warn({ worktreePath, error: redactAuthenticatedGitUrl((inspectionError as Error).message) }, 'Could not clear the missing worktree registration');
                    return false;
                });
                if (!cleared) throw error;
                clearedMissing = true;
            } else {
                const holderPath = worktreeHoldingBranch(message);
                if (releasedHolder || !holderPath || !await releaseBranchFromSettledWorktree(git, branchName, holderPath)) throw error;
                releasedHolder = true;
            }
        }
    }
}

async function createWorktreeFromRemote(git: SimpleGit, worktreePath: string, branchName: string, localRepoPath: string): Promise<void> {
    try {
        const worktreeMetadataDir = path.join(localRepoPath, '.git', 'worktrees');
        await fs.ensureDir(worktreeMetadataDir);

        const mainRepoGitPath = path.join(localRepoPath, '.git');
        if (!await fs.pathExists(mainRepoGitPath)) {
            throw new Error(`Main repository is invalid - no .git found at ${localRepoPath}`);
        }

        try {
            const existingWorktrees = await git.raw(['worktree', 'list', '--porcelain']);
            logger.debug({ localRepoPath, existingWorktrees: existingWorktrees.trim() }, 'Current worktrees before adding new one');
        } catch (listError) {
            logger.warn({ error: (listError as Error).message }, 'Failed to list existing worktrees');
        }

        const worktreeAddResult = await addWorktreeFromRemoteWithRecovery(git, worktreePath, branchName);
        logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Git worktree add command completed');

    } catch (error) {
        if ((error as Error).message && (error as Error).message.includes('is already used by worktree')) {
            await handleWorktreeConflict();
        } else if ((error as Error).message && (error as Error).message.includes('.git is a directory')) {
            await handleImproperWorktree(worktreePath, branchName, error as Error);
        } else {
            await handleWorktreeCreationError(git, branchName, error as Error);
        }
    }
}

interface RemoteRef {
    name: string;
    refs: {
        fetch?: string;
    };
}

async function verifyFinalWorktreeSetup(worktreeGit: SimpleGit, worktreePath: string, branchName: string): Promise<void> {
    try {
        const finalRemotes = await worktreeGit.getRemotes(true) as RemoteRef[];
        const hasOrigin = finalRemotes.some(r => r.name === 'origin');

        if (!hasOrigin) throw new Error('Worktree was created but origin remote is missing');

        logger.info({ worktreePath, branchName, remoteNames: finalRemotes.map(remote => remote.name) }, 'Git worktree created successfully from existing branch with remotes configured');
    } catch (verifyError) {
        const safeMessage = redactAuthenticatedGitUrl((verifyError as Error).message);
        logger.error({ worktreePath, error: safeMessage }, 'Final verification failed - worktree may not be properly configured');
        throw new Error(`Worktree setup incomplete: ${safeMessage}`);
    }
}

interface CreateWorktreeFromExistingBranchOptions {
    worktreeDirName: string;
    owner: string;
    repoName: string;
}

interface WorktreeResult {
    worktreePath: string;
    branchName: string;
}

export async function createWorktreeFromExistingBranch(localRepoPath: string, branchName: string, options: CreateWorktreeFromExistingBranchOptions): Promise<WorktreeResult> {
    return repositoryStorageLifecycle.use(() => createWorktreeFromExistingBranchInternal(localRepoPath, branchName, options));
}

async function createWorktreeFromExistingBranchInternal(localRepoPath: string, branchName: string, options: CreateWorktreeFromExistingBranchOptions): Promise<WorktreeResult> {
    const { worktreeDirName, owner, repoName } = options;
    // Rescue refs preserve rejected pushes; they are never a branch a task works on.
    if (isRescueRef(branchName)) throw new Error(`Refusing to use push salvage rescue ref ${branchName} as a task branch`);
    assertRepositoryClonePath(localRepoPath, CLONES_BASE_PATH, owner, repoName);
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);

    try {
        const git: SimpleGit = createHooklessGit(localRepoPath);

        if (await fs.pathExists(worktreePath)) {
            await handleExistingWorktreePath();
        }

        await fs.ensureDir(path.dirname(worktreePath));

        logger.info({ localRepoPath, worktreePath, branchName }, 'Creating Git worktree from existing branch...');

        // Use explicit refspec to ensure remote tracking ref is updated
        // Simple `git fetch origin <branch>` may only update FETCH_HEAD without
        // updating refs/remotes/origin/<branch> in some git configurations
        await configureGitRemoteAuthentication(git);
        await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`, '--prune']);
        logger.debug({ branchName }, 'Fetched latest changes for branch with explicit refspec');

        await createWorktreeFromRemote(git, worktreePath, branchName, localRepoPath);

        await verifyWorktreeCreation(worktreePath);
        await setupWorktreePermissions(worktreePath, branchName, null);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId: null });

        const worktreeGit: SimpleGit = createHooklessGit(worktreePath);
        await setupWorktreeRemote(worktreeGit, git, worktreePath);

        await verifyFinalWorktreeSetup(worktreeGit, worktreePath, branchName);

        return { worktreePath, branchName };

    } catch (error) {
        handleError(error, `Failed to create worktree from branch ${branchName}`);
        throw error;
    }
}
