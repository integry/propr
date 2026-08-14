import fs from 'fs-extra';
import path from 'path';

/**
 * Return every path that must be writable by an agent operating in a worktree.
 *
 * A linked worktree's `.git` is a file that points at metadata stored in the
 * main clone. Recursively changing ownership of the worktree therefore does
 * not affect the directory where Git creates `index.lock`.
 */
export async function getWorktreeOwnershipTargets(worktreePath: string): Promise<string[]> {
    const targets = [worktreePath];
    const gitFilePath = path.join(worktreePath, '.git');

    try {
        const gitFileStats = await fs.lstat(gitFilePath);
        if (!gitFileStats.isFile()) return targets;

        const gitFileContent = await fs.readFile(gitFilePath, 'utf8');
        const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+?)\s*$/m);
        if (!gitdirMatch) return targets;

        const linkedGitDir = path.resolve(worktreePath, gitdirMatch[1]);
        const linkedGitDirStats = await fs.lstat(linkedGitDir);
        if (!linkedGitDirStats.isDirectory()) return targets;

        // Git creates this backlink for linked worktrees. Checking it avoids
        // following a malformed .git pointer with a privileged recursive chown.
        const backlink = (await fs.readFile(path.join(linkedGitDir, 'gitdir'), 'utf8')).trim();
        if (path.resolve(linkedGitDir, backlink) !== path.resolve(gitFilePath)) return targets;

        targets.push(linkedGitDir);
    } catch {
        // Normal repositories have a .git directory, and incomplete worktrees
        // are diagnosed elsewhere. The worktree itself remains the safe target.
    }

    return targets;
}
