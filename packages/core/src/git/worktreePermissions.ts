import fs from 'fs-extra';
import path from 'path';

function parseSinglePath(content: string, prefix = ''): string | null {
    const pattern = prefix
        ? new RegExp(`^${prefix}:[ \\t]+([^\\r\\n]+)\\r?\\n?$`)
        : /^([^\r\n]+)\r?\n?$/;
    const match = content.match(pattern);
    const value = match?.[1].trim();
    return value && !value.includes('\0') ? value : null;
}

function isDescendant(parentPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(parentPath, candidatePath);
    return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isPlainDirectory(stats: fs.Stats): boolean {
    return stats.isDirectory() && !stats.isSymbolicLink();
}

function isPlainFile(stats: fs.Stats): boolean {
    return stats.isFile() && !stats.isSymbolicLink();
}

interface TrustedMetadataPaths {
    gitPath: string;
    worktreesPath: string;
}

interface WorktreeMetadataContext extends TrustedMetadataPaths {
    gitFilePath: string;
}

async function resolveWorktreePath(worktreePath: string): Promise<string | null> {
    try {
        const worktreeStats = await fs.lstat(worktreePath);
        if (!isPlainDirectory(worktreeStats)) return null;
        return fs.realpath(worktreePath);
    } catch {
        return null;
    }
}

async function resolveTrustedMetadataPaths(localRepoPath: string): Promise<TrustedMetadataPaths | null> {
    const gitPath = path.join(localRepoPath, '.git');
    const worktreesPath = path.join(gitPath, 'worktrees');
    const [gitStats, worktreesStats] = await Promise.all([
        fs.lstat(gitPath),
        fs.lstat(worktreesPath),
    ]);
    if (!isPlainDirectory(gitStats) || !isPlainDirectory(worktreesStats)) return null;

    const [resolvedGitPath, resolvedWorktreesPath] = await Promise.all([
        fs.realpath(gitPath),
        fs.realpath(worktreesPath),
    ]);
    return { gitPath: resolvedGitPath, worktreesPath: resolvedWorktreesPath };
}

async function hasValidMetadataPointers(
    linkedGitDir: string,
    context: WorktreeMetadataContext,
): Promise<boolean> {
    const backlinkPath = path.join(linkedGitDir, 'gitdir');
    const commonDirPath = path.join(linkedGitDir, 'commondir');
    const [backlinkStats, commonDirStats] = await Promise.all([
        fs.lstat(backlinkPath),
        fs.lstat(commonDirPath),
    ]);
    if (!isPlainFile(backlinkStats) || !isPlainFile(commonDirStats)) return false;

    const [backlink, commonDir] = await Promise.all([
        fs.readFile(backlinkPath, 'utf8').then(content => parseSinglePath(content)),
        fs.readFile(commonDirPath, 'utf8').then(content => parseSinglePath(content)),
    ]);
    if (!backlink || !commonDir) return false;

    const backlinkTarget = path.resolve(linkedGitDir, backlink);
    const commonDirTarget = path.resolve(linkedGitDir, commonDir);
    if (backlinkTarget !== context.gitFilePath || commonDirTarget !== context.gitPath) return false;

    const [resolvedBacklink, resolvedCommonDir] = await Promise.all([
        fs.realpath(backlinkTarget),
        fs.realpath(commonDirTarget),
    ]);
    return resolvedBacklink === context.gitFilePath && resolvedCommonDir === context.gitPath;
}

async function resolveLinkedGitDir(
    resolvedWorktreePath: string,
    trustedPaths: TrustedMetadataPaths,
): Promise<string | null> {
    const gitFilePath = path.join(resolvedWorktreePath, '.git');
    const gitFileStats = await fs.lstat(gitFilePath);
    if (!isPlainFile(gitFileStats)) return null;

    const resolvedGitFilePath = await fs.realpath(gitFilePath);
    const gitdirPointer = parseSinglePath(await fs.readFile(gitFilePath, 'utf8'), 'gitdir');
    if (!gitdirPointer) return null;

    const linkedGitDir = path.resolve(resolvedWorktreePath, gitdirPointer);
    const linkedGitDirStats = await fs.lstat(linkedGitDir);
    if (!isPlainDirectory(linkedGitDirStats)) return null;

    const resolvedLinkedGitDir = await fs.realpath(linkedGitDir);
    if (resolvedLinkedGitDir !== linkedGitDir) return null;
    if (!isDescendant(trustedPaths.worktreesPath, resolvedLinkedGitDir)) return null;

    const pointersAreValid = await hasValidMetadataPointers(resolvedLinkedGitDir, {
        ...trustedPaths,
        gitFilePath: resolvedGitFilePath,
    });
    return pointersAreValid ? resolvedLinkedGitDir : null;
}

export type WorktreeOwnershipExecutor = (targets: readonly string[]) => void | Promise<void>;

/**
 * Return every path that must be writable by an agent operating in a worktree.
 *
 * A linked worktree's `.git` file points at metadata in the main clone, where
 * Git creates `index.lock`. The main clone path is trusted configuration; the
 * worktree pointer is not, so metadata is included only when it resolves below
 * that clone's canonical `.git/worktrees` directory and links back to this
 * checkout. Any incomplete or malformed relationship fails closed to the
 * checkout-only target.
 */
export async function getWorktreeOwnershipTargets(worktreePath: string, localRepoPath: string): Promise<string[]> {
    const resolvedWorktreePath = await resolveWorktreePath(worktreePath);
    if (!resolvedWorktreePath) return [];

    const targets = [resolvedWorktreePath];

    try {
        const trustedPaths = await resolveTrustedMetadataPaths(localRepoPath);
        if (!trustedPaths) return targets;

        const linkedGitDir = await resolveLinkedGitDir(resolvedWorktreePath, trustedPaths);
        if (linkedGitDir) targets.push(linkedGitDir);
    } catch {
        // A normal repository has a .git directory, while incomplete linked
        // metadata is unsafe to pass to a privileged recursive ownership change.
    }

    return targets;
}

export async function applyWorktreeOwnership(
    worktreePath: string,
    localRepoPath: string,
    executeOwnershipChange: WorktreeOwnershipExecutor,
): Promise<string[]> {
    const ownershipTargets = await getWorktreeOwnershipTargets(worktreePath, localRepoPath);
    if (ownershipTargets.length === 0) return ownershipTargets;
    await executeOwnershipChange(ownershipTargets);
    return ownershipTargets;
}
