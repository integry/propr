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
    let resolvedWorktreePath: string;
    try {
        const worktreeStats = await fs.lstat(worktreePath);
        if (!worktreeStats.isDirectory() || worktreeStats.isSymbolicLink()) return [];
        resolvedWorktreePath = await fs.realpath(worktreePath);
    } catch {
        return [];
    }
    const targets = [resolvedWorktreePath];
    const gitFilePath = path.join(resolvedWorktreePath, '.git');

    try {
        const gitFileStats = await fs.lstat(gitFilePath);
        if (!gitFileStats.isFile() || gitFileStats.isSymbolicLink()) return targets;

        const trustedGitPath = path.join(localRepoPath, '.git');
        const trustedWorktreesPath = path.join(trustedGitPath, 'worktrees');
        const [trustedGitStats, trustedWorktreesStats] = await Promise.all([
            fs.lstat(trustedGitPath),
            fs.lstat(trustedWorktreesPath),
        ]);
        if (
            !trustedGitStats.isDirectory() || trustedGitStats.isSymbolicLink() ||
            !trustedWorktreesStats.isDirectory() || trustedWorktreesStats.isSymbolicLink()
        ) return targets;

        const [resolvedGitFilePath, resolvedTrustedGitPath, resolvedTrustedWorktreesPath] = await Promise.all([
            fs.realpath(gitFilePath),
            fs.realpath(trustedGitPath),
            fs.realpath(trustedWorktreesPath),
        ]);

        const gitdirPointer = parseSinglePath(await fs.readFile(gitFilePath, 'utf8'), 'gitdir');
        if (!gitdirPointer) return targets;

        const linkedGitDir = path.resolve(resolvedWorktreePath, gitdirPointer);
        const linkedGitDirStats = await fs.lstat(linkedGitDir);
        if (!linkedGitDirStats.isDirectory() || linkedGitDirStats.isSymbolicLink()) return targets;

        const resolvedLinkedGitDir = await fs.realpath(linkedGitDir);
        if (resolvedLinkedGitDir !== linkedGitDir) return targets;
        if (!isDescendant(resolvedTrustedWorktreesPath, resolvedLinkedGitDir)) return targets;

        const backlinkPath = path.join(resolvedLinkedGitDir, 'gitdir');
        const commonDirPath = path.join(resolvedLinkedGitDir, 'commondir');
        const [backlinkStats, commonDirStats] = await Promise.all([
            fs.lstat(backlinkPath),
            fs.lstat(commonDirPath),
        ]);
        if (
            !backlinkStats.isFile() || backlinkStats.isSymbolicLink() ||
            !commonDirStats.isFile() || commonDirStats.isSymbolicLink()
        ) return targets;

        const [backlink, commonDir] = await Promise.all([
            fs.readFile(backlinkPath, 'utf8').then(content => parseSinglePath(content)),
            fs.readFile(commonDirPath, 'utf8').then(content => parseSinglePath(content)),
        ]);
        if (!backlink || !commonDir) return targets;

        const backlinkTarget = path.resolve(resolvedLinkedGitDir, backlink);
        const commonDirTarget = path.resolve(resolvedLinkedGitDir, commonDir);
        if (backlinkTarget !== resolvedGitFilePath || commonDirTarget !== resolvedTrustedGitPath) return targets;

        const [resolvedBacklink, resolvedCommonDir] = await Promise.all([
            fs.realpath(backlinkTarget),
            fs.realpath(commonDirTarget),
        ]);
        if (resolvedBacklink !== resolvedGitFilePath || resolvedCommonDir !== resolvedTrustedGitPath) return targets;

        targets.push(resolvedLinkedGitDir);
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
