import path from 'path';
import logger from '../utils/logger.js';
import { executeDockerCommand } from './docker/dockerExecutor.js';

export async function setWorktreeOwnership(
    worktreePath: string,
    issueNumber: number,
    options: { protectGitMetadata?: boolean } = {},
): Promise<void> {
    try {
        await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', worktreePath], { timeout: 10000 });
        if (options.protectGitMetadata) {
            await executeDockerCommand('sudo', ['chown', 'root:root', path.join(worktreePath, '.git')], { timeout: 10000 });
        }
        logger.debug({ issueNumber, worktreePath }, 'Set worktree ownership to UID 1000 for container compatibility');
    } catch (chownError) {
        const error = chownError as Error;
        logger.warn({ issueNumber, worktreePath, error: error.message }, 'Failed to set worktree ownership - container may have permission issues');
        if (options.protectGitMetadata) throw error;
    }
}
