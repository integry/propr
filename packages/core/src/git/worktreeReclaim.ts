import type { WorktreeMount } from './worktreeMounts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../utils/logger.js';
import { isSalvageRetainedWorktree } from './pushSalvage.js';
import { resolveRepositoryWorktreeRoot } from './repositoryPaths.js';
import { generatedPayloadStorage } from '../storage/generatedPayloads.js';
import { repositoryStorageLifecycle } from '../storage/lifecycle.js';

const execFileAsync = promisify(execFile);

/**
 * Why a worktree is kept. A worktree is removed only when every piece of work in it
 * is already stored somewhere else: no uncommitted or untracked files, and a HEAD
 * that a branch, remote-tracking ref or tag already contains. Ignored files
 * (node_modules, build output) are treated as disposable, as `git worktree remove` does.
 */
export type WorktreeKeepReason =
    | 'outside_worktree_root'
    | 'not_a_worktree'
    | 'salvage_retained'
    | 'locked'
    | 'operation_in_progress'
    | 'hidden_index_entries'
    | 'in_use'
    | 'uncommitted_changes'
    | 'unpublished_commits'
    | 'unknown_git_state'
    | 'remove_failed';

export type WorktreeDisposability =
    | { disposable: true; commonDir: string }
    | { disposable: false; reason: WorktreeKeepReason };

const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer'];

function worktreesRoot(): string {
    return path.resolve(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees');
}

/** `always_keep` turns off all automatic worktree removal. */
export function worktreeRemovalDisabled(strategy = process.env.WORKTREE_RETENTION_STRATEGY): boolean {
    return strategy === 'always_keep';
}

/** Bound delays to Node's supported timer range, including job-end callers. */
export function worktreeGateWarningDelay(): number {
    const raw = process.env.WORKTREE_SWEEP_INTERVAL_MS;
    const value = Number(raw);
    return raw && /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
        ? value : 3_600_000;
}

async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
    // Discover names without running a filter. Override every repository driver;
    // disabling attributes alone would still leave in-repository .gitattributes.
    const config = await execFileAsync('git', ['-C', cwd, 'config', '--null', '--list'], { timeout: 120_000 });
    const filters = new Set(config.stdout.split('\0').map(entry => entry.split('\n')[0])
        .filter(key => /^filter\..+\.(clean|smudge|process|required)$/.test(key))
        .map(key => key.slice(0, key.lastIndexOf('.'))));
    const overrides = [...filters].flatMap(name => ['-c', `${name}.clean=`, '-c', `${name}.smudge=`,
        '-c', `${name}.process=`, '-c', `${name}.required=false`]);
    const { stdout } = await execFileAsync('git', [
        ...overrides,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=*', '-C', cwd, ...args,
    ], { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    return stdout;
}

async function exists(file: string): Promise<boolean> {
    try { await fs.lstat(file); return true; } catch { return false; }
}

function insideRoot(worktreePath: string, root: string): boolean {
    const relative = path.relative(root, path.resolve(worktreePath));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The worktree's private git directory, read from its `.git` file. */
export async function worktreeGitDir(worktreePath: string): Promise<string | null> {
    try {
        const marker = await fs.lstat(path.join(worktreePath, '.git'));
        if (!marker.isFile()) return null;
        const content = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
        const gitdir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
        return gitdir ? path.resolve(worktreePath, gitdir) : null;
    } catch {
        return null;
    }
}

/** Also used by cleanup's fallback so configured filters never run on the host. */
export async function detachRetainedWorktree(worktreePath: string): Promise<void> {
    await git(worktreePath, ['checkout', '--detach']);
}

/** Proves that removing the checkout cannot lose work. Changes nothing. */
export async function proveWorktreeDisposable(worktreePath: string, root = worktreesRoot()): Promise<WorktreeDisposability> {
    if (!insideRoot(worktreePath, root)) return { disposable: false, reason: 'outside_worktree_root' };
    try {
        const stat = await fs.lstat(worktreePath);
        if (!stat.isDirectory()) return { disposable: false, reason: 'not_a_worktree' };
    } catch {
        return { disposable: false, reason: 'not_a_worktree' };
    }
    if (await isSalvageRetainedWorktree(worktreePath)) return { disposable: false, reason: 'salvage_retained' };
    const gitDir = await worktreeGitDir(worktreePath);
    if (!gitDir) return { disposable: false, reason: 'not_a_worktree' };
    try {
        const [topLevel, commonDir] = (await git(worktreePath, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']))
            .trim().split('\n');
        if (await fs.realpath(topLevel) !== await fs.realpath(worktreePath)) return { disposable: false, reason: 'not_a_worktree' };
        if (await exists(path.join(gitDir, 'locked'))) return { disposable: false, reason: 'locked' };
        for (const marker of IN_PROGRESS_MARKERS) {
            if (await exists(path.join(gitDir, marker))) return { disposable: false, reason: 'operation_in_progress' };
        }
        // Lowercase tags mean assume-unchanged; S/s mean skip-worktree.
        // Neither status nor non-forced removal sees edits hidden by these flags.
        const entries = await git(worktreePath, ['ls-files', '-v', '-z']);
        if (entries.split('\0').some(entry => /^[a-zS] /.test(entry))) {
            return { disposable: false, reason: 'hidden_index_entries' };
        }
        if ((await git(worktreePath, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])).trim()) {
            return { disposable: false, reason: 'uncommitted_changes' };
        }
        const head = (await git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        const unpublished = (await git(worktreePath, ['rev-list', '--count', head, '--not', '--branches', '--remotes', '--tags'])).trim();
        if (unpublished !== '0') return { disposable: false, reason: 'unpublished_commits' };
        return { disposable: true, commonDir };
    } catch (error) {
        logger.warn({ worktreePath, error: (error as Error).message }, 'Could not read worktree state; keeping it');
        return { disposable: false, reason: 'unknown_git_state' };
    }
}

/** Diagnostic only: an interrupted proof never authorizes forced deletion. */
export function worktreeRemovalRecordsRoot(lifecycleRoot = repositoryStorageLifecycle.root): string {
    return path.join(lifecycleRoot, 'worktree-removals');
}

export async function interruptedWorktreeRemovals(lifecycleRoot = repositoryStorageLifecycle.root): Promise<Array<{ id: string; worktreePath?: string }>> {
    const root = worktreeRemovalRecordsRoot(lifecycleRoot);
    const names = await fs.readdir(root).catch(error => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
    });
    const records: Array<{ id: string; worktreePath?: string }> = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 100)) {
        const id = name.slice(0, -5);
        try {
            const record = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
            if (typeof record?.worktreePath !== 'string') throw new Error('Invalid removal diagnostic');
            records.push({ id, worktreePath: record.worktreePath });
        } catch {
            records.push({ id });
        }
    }
    return records;
}

/** A refusal with an intact tracked checkout needs no interrupted-removal diagnostic. */
async function removalMayBeInterrupted(worktreePath: string, commonDir: string): Promise<boolean> {
    // Concurrent successful removal needs no interrupted diagnostic.
    const registered = (await git(commonDir, ['worktree', 'list', '--porcelain', '-z']))
        .split('\0').includes(`worktree ${path.resolve(worktreePath)}`);
    if (!await exists(worktreePath) && !registered) return false;
    if (!registered) return true;
    const gitDir = await worktreeGitDir(worktreePath);
    if (!gitDir || !await exists(path.join(gitDir, 'index'))) return true;
    await git(worktreePath, ['status', '--porcelain', '--untracked-files=no']);
    return (await git(worktreePath, ['ls-files', '--deleted', '-z'])).length > 0;
}

/**
 * Removes a finished worktree (checkout and registration) when the proof passes.
 * Branches are kept. Uses `git worktree remove` without --force, so Git refuses
 * anything that became dirty after the proof, and worktrees with submodules.
 */
export async function removeWorktreeIfDisposable(
    worktreePath: string, root = worktreesRoot(),
    stillUnused?: (afterDetach: boolean) => Promise<boolean>,
): Promise<{ removed: true } | { removed: false; reason: WorktreeKeepReason }> {
    // Covers proof, deletion and record retirement. Generated-payload cleanup
    // and clone quarantine take the exclusive side of this cross-process gate.
    return repositoryStorageLifecycle.use(async () => {
        let proof = await proveWorktreeDisposable(worktreePath, root);
        if (!proof.disposable) return { removed: false, reason: proof.reason };
        if (stillUnused && !await stillUnused(false)) return { removed: false, reason: 'in_use' };
        const recordRoot = worktreeRemovalRecordsRoot();
        const recordFile = path.join(recordRoot, `${createHash('sha256').update(path.resolve(worktreePath)).digest('hex')}.json`);
        let removalStarted = false;
        let recordWritten = false;
        try {
            // Free the task branch before potentially slow recursive deletion.
            // Never force checkout, and refresh all Git evidence after detaching.
            await git(worktreePath, ['checkout', '--detach']);
            await fs.mkdir(recordRoot, { recursive: true });
            const temporaryRecord = path.join(recordRoot, `pending-${randomUUID()}`);
            await fs.writeFile(temporaryRecord, JSON.stringify({ worktreePath: path.resolve(worktreePath), startedAt: new Date().toISOString() }));
            await fs.rename(temporaryRecord, recordFile);
            recordWritten = true;
            // Earlier candidates can take minutes. Liveness snapshots from the
            // start of the sweep cannot authorize removal of a later candidate.
            if (stillUnused && !await stillUnused(true)) {
                await fs.unlink(recordFile);
                logger.warn({ worktreePath }, 'Worktree became in use after detach; checkout retained with detached HEAD');
                return { removed: false, reason: 'in_use' };
            }
            // Docker/database inspection above can await external APIs. Refresh
            // hidden-index, operation and ref evidence after those boundaries.
            proof = await proveWorktreeDisposable(worktreePath, root);
            if (!proof.disposable) {
                await fs.unlink(recordFile);
                return { removed: false, reason: proof.reason };
            }
            removalStarted = true;
            await git(proof.commonDir, ['worktree', 'remove', path.resolve(worktreePath)], 15 * 60_000);
        } catch (error) {
            let diagnosticNeeded = removalStarted;
            if (removalStarted) {
                try {
                    diagnosticNeeded = await removalMayBeInterrupted(worktreePath, proof.disposable ? proof.commonDir : root);
                } catch { /* Unknown/partial state keeps the diagnostic. */ }
            }
            if (recordWritten && !diagnosticNeeded) await fs.unlink(recordFile).catch(() => undefined);
            logger.warn({ worktreePath, recordFile, error: (error as Error).message },
                diagnosticNeeded ? 'Worktree removal failed or was interrupted; inspect the remnant and permissions before operator recovery (no forced retry)' : 'Worktree removal refused or already completed; no interrupted-removal evidence');
            return { removed: false, reason: 'remove_failed' };
        }
        await generatedPayloadStorage().forget(worktreePath).catch(error => {
            logger.warn({ worktreePath, error: (error as Error).message }, 'Could not drop generated payload records of a removed worktree');
        });
        await fs.unlink(recordFile).catch(error => {
            logger.warn({ worktreePath, error: (error as Error).message }, 'Could not retire worktree removal diagnostic');
        });
        return { removed: true };
    }, undefined, { recordUse: false, waitWarning: {
        afterMs: worktreeGateWarningDelay(),
        warn: () => logger.warn({ worktreePath }, 'Worktree removal is waiting for the storage lifecycle gate; inspect lifecycle ownership'),
    } });
}

export interface WorktreeSweepOptions {
    worktreesBasePath?: string;
    /** Only worktrees with no Git activity for this long are considered. */
    minIdleHours: number;
    /** Worktrees still referenced by live work (goals, follow-up handoffs, task repository roots). */
    protectedPaths: () => Promise<Iterable<string>>;
    /** Host paths bind-mounted into running containers. Throw when unknown. */
    mountedPaths: () => Promise<Iterable<WorktreeMount>>;
    now?: number;
}

export interface WorktreeSweepResult {
    removed: string[];
    kept: number;
    skipped: number;
}

async function lastActivity(worktreePath: string, gitDir: string): Promise<number> {
    let latest = 0;
    for (const file of [worktreePath, path.join(gitDir, 'HEAD'), path.join(gitDir, 'index'), path.join(gitDir, 'logs', 'HEAD')]) {
        try { latest = Math.max(latest, (await fs.stat(file)).mtimeMs); } catch { /* missing file */ }
    }
    return latest;
}

function containsPath(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(first: string, second: string): boolean {
    return containsPath(first, second) || containsPath(second, first);
}

/** Shared storage mounts are exempt only for recognized service containers.
 * Even services protect mounts below the root (owner/repository/checkouts). */
export function mountUsesWorktree(mount: WorktreeMount, worktreePath: string, root = worktreesRoot()): boolean {
    const source = typeof mount === 'string' ? mount : mount.source;
    if (typeof mount !== 'string' && mount.service && containsPath(source, root)) return false;
    return pathsOverlap(source, worktreePath);
}

/** Worktree directories at <root>/<owner>/<repo>/<task>. */
async function listWorktreeDirectories(root: string): Promise<string[]> {
    const directories: string[] = [];
    const children = async (dir: string) => (await fs.readdir(dir, { withFileTypes: true }).catch(error => {
        if (dir === root) throw new Error(`Cannot read worktree root ${root}: ${error.message}`);
        logger.warn({ directory: dir, error: error.message }, 'Could not enumerate worktrees');
        return [];
    }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(dir, entry.name));
    for (const owner of await children(root)) {
        for (const repo of await children(owner)) {
            // Validate the same repository layout used by worktree creation.
            try { resolveRepositoryWorktreeRoot(root, path.basename(owner), path.basename(repo)); }
            catch { continue; }
            directories.push(...await children(repo));
        }
    }
    return directories;
}

let sweeping = false;

/**
 * Removes idle worktrees left by finished work, such as runs that ended before the
 * change that made task cleanup remove them, or attempts killed by a worker restart.
 * Liveness is proven by the idle age, the caller's protected paths and the
 * container mounts; if any of these cannot be read, nothing is removed.
 */
export async function sweepIdleWorktrees(options: WorktreeSweepOptions): Promise<WorktreeSweepResult> {
    const result: WorktreeSweepResult = { removed: [], kept: 0, skipped: 0 };
    if (sweeping || worktreeRemovalDisabled()) return result;
    if (!Number.isSafeInteger(options.minIdleHours) || options.minIdleHours <= 0
        || !Number.isSafeInteger(options.minIdleHours * 3_600_000)) {
        logger.warn({ minIdleHours: options.minIdleHours }, 'Skipped idle worktree sweep: invalid retention hours');
        return result;
    }
    let inUse = 0;
    let mountAuthorityFailures = 0;
    const mountedPaths = async () => {
        try { return await options.mountedPaths(); }
        catch (error) { mountAuthorityFailures++; throw error; }
    };
    sweeping = true;
    try {
        const root = path.resolve(options.worktreesBasePath ?? worktreesRoot());
        const minIdleMs = options.minIdleHours * 3_600_000;
        const unused = async (worktreePath: string): Promise<boolean> => {
            const [protectedSnapshot, mountSnapshot] = await Promise.all([options.protectedPaths(), mountedPaths()]);
            const protectedPaths = [...protectedSnapshot].map(p => path.resolve(p));
            const mounts = [...mountSnapshot];
            if (protectedPaths.some(p => pathsOverlap(worktreePath, p)) || mounts.some(m => mountUsesWorktree(m, worktreePath, root))) return false;
            const gitDir = await worktreeGitDir(worktreePath);
            return !!gitDir && (options.now ?? Date.now()) - await lastActivity(worktreePath, gitDir) >= minIdleMs;
        };
        // Confirm authority even when no candidate directory exists.
        await options.protectedPaths();
        await mountedPaths();
        for (const worktreePath of await listWorktreeDirectories(root)) {
            const gitDir = await worktreeGitDir(worktreePath);
            if (!gitDir) { result.kept++; continue; }
            if ((options.now ?? Date.now()) - await lastActivity(worktreePath, gitDir) < minIdleMs) { result.skipped++; continue; }
            // Query liveness only inside the claim, rather than also querying
            // each candidate before waiting on the gate. Keep the second fresh
            // snapshot after detach: caching across those awaits weakens authority.
            // Detaching refreshes HEAD/index mtimes; idle age was checked above.
            const outcome = await removeWorktreeIfDisposable(worktreePath, root, async afterDetach => {
                if (!afterDetach) return unused(worktreePath);
                const [protectedSnapshot, mountSnapshot] = await Promise.all([options.protectedPaths(), mountedPaths()]);
                const protectedPaths = [...protectedSnapshot].map(p => path.resolve(p));
                const mounts = [...mountSnapshot];
                return !protectedPaths.some(p => pathsOverlap(worktreePath, p)) && !mounts.some(m => mountUsesWorktree(m, worktreePath, root));
            });
            if (outcome.removed) result.removed.push(worktreePath);
            else {
                result.kept++;
                if (outcome.reason === 'in_use') inUse++;
            }
        }
    } finally {
        sweeping = false;
        if (mountAuthorityFailures > 0 && result.removed.length === 0) {
            logger.warn({ mountAuthorityFailures, kept: result.kept, skipped: result.skipped },
                'Idle worktree sweep reclaimed nothing and container mount authority failed; inspect Docker availability and permissions');
        }
    }
    if (inUse > 0 && inUse === result.kept && result.removed.length === 0) {
        logger.warn({ inUse, kept: result.kept, skipped: result.skipped }, 'Idle worktree sweep reclaimed nothing: every idle candidate is in use; inspect durable references and container mounts');
    }
    if (result.removed.length) logger.info({ removed: result.removed.length, kept: result.kept, skipped: result.skipped }, 'Removed idle worktrees whose work is already stored in Git');
    return result;
}
