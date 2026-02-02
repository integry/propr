import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';
import type { FileChange } from './worktreeMonitorService.js';

/**
 * Map git status codes to FileChange status
 */
function mapStatusCode(statusCode: string): FileChange['status'] {
    switch (statusCode) {
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'R':
        case 'R100':
            return 'renamed';
        case 'M':
        default:
            return 'modified';
    }
}

/**
 * Count added and removed lines from diff output
 */
function countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
    let linesAdded = 0;
    let linesRemoved = 0;

    if (diff) {
        const diffLines = diff.split('\n');
        for (const diffLine of diffLines) {
            if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
                linesAdded++;
            } else if (diffLine.startsWith('-') && !diffLine.startsWith('---')) {
                linesRemoved++;
            }
        }
    }

    return { linesAdded, linesRemoved };
}

/**
 * Extracts file changes from a specific git commit
 *
 * @param repoPath - Path to the git repository
 * @param commitHash - The commit hash to extract changes from
 * @returns Array of FileChange objects representing the changes in the commit
 */
export async function getChangesFromCommit(repoPath: string, commitHash: string): Promise<FileChange[]> {
    const git: SimpleGit = simpleGit({ baseDir: repoPath });
    const fileChanges: FileChange[] = [];

    try {
        // Get list of changed files with their status
        // Format: status\tfilename or status\told_filename\tnew_filename for renames
        const diffNameStatus = await git.raw([
            'diff-tree',
            '--no-commit-id',
            '--name-status',
            '-r',
            commitHash
        ]);

        if (!diffNameStatus.trim()) {
            logger.debug({ repoPath, commitHash }, 'No changes found in commit');
            return [];
        }

        const statusLines = diffNameStatus.trim().split('\n');

        for (const line of statusLines) {
            const parts = line.split('\t');
            if (parts.length < 2) continue;

            const statusCode = parts[0].charAt(0); // Get first character (R100 -> R, M -> M, etc.)
            const isRename = statusCode === 'R';
            const filePath = isRename && parts.length >= 3 ? parts[2] : parts[1];
            const oldPath = isRename && parts.length >= 3 ? parts[1] : undefined;

            const status = mapStatusCode(statusCode);

            // Get diff content for this file
            let diff = '';
            try {
                if (isRename && oldPath) {
                    // For renames, show diff between old and new file
                    diff = await git.raw([
                        'diff',
                        `${commitHash}^:${oldPath}`,
                        `${commitHash}:${filePath}`
                    ]);
                } else if (status === 'added') {
                    // For added files, show the entire content as additions
                    diff = await git.raw([
                        'show',
                        `${commitHash}:${filePath}`
                    ]).then(content => {
                        const lines = content.split('\n');
                        return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
                            lines.map(l => `+${l}`).join('\n');
                    });
                } else if (status === 'deleted') {
                    // For deleted files, show the entire content as deletions
                    diff = await git.raw([
                        'show',
                        `${commitHash}^:${filePath}`
                    ]).then(content => {
                        const lines = content.split('\n');
                        return `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
                            lines.map(l => `-${l}`).join('\n');
                    });
                } else {
                    // For modified files, get the actual diff
                    diff = await git.raw([
                        'diff',
                        `${commitHash}^`,
                        commitHash,
                        '--',
                        filePath
                    ]);
                }
            } catch (diffError) {
                logger.debug({ filePath, commitHash, error: (diffError as Error).message }, 'Failed to get diff for file, trying alternative method');

                // Fallback: try using show for the diff
                try {
                    diff = await git.raw([
                        'show',
                        '--format=',
                        commitHash,
                        '--',
                        filePath
                    ]);
                } catch (fallbackError) {
                    logger.warn({ filePath, commitHash, error: (fallbackError as Error).message }, 'Failed to get diff using fallback method');
                }
            }

            const { linesAdded, linesRemoved } = countDiffLines(diff);

            fileChanges.push({
                path: filePath,
                linesAdded,
                linesRemoved,
                diff,
                status
            });
        }

        logger.debug({ repoPath, commitHash, fileCount: fileChanges.length }, 'Successfully extracted file changes from commit');
        return fileChanges;

    } catch (error) {
        logger.error({ repoPath, commitHash, error: (error as Error).message }, 'Error getting changes from commit');
        throw error;
    }
}
