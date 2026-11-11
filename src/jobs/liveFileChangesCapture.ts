import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface TaskFileChangesCapture {
    /** Ends the periodic capture; `finalCapture` records the worktree once more after the agent exits. */
    stop(options?: { finalCapture?: boolean }): Promise<void>;
}

export interface TaskFileChangesCaptureOptions {
    taskId: string;
    worktreePath: string;
    repository: string;
    redis: Redis;
    log: Pick<Logger, 'debug' | 'warn'>;
}

const NOOP_CAPTURE: TaskFileChangesCapture = { stop: async () => undefined };

/**
 * Live changed-file capture for an agent run (issue implementation, PR follow-up and `/fix`):
 * `task:file-changes:<taskId>` every two seconds, plus the repository's file overlap check.
 * Core is loaded lazily so suites that replace `@propr/core` with a fixed export list still link.
 */
export async function startTaskFileChangesCapture(options: TaskFileChangesCaptureOptions): Promise<TaskFileChangesCapture> {
    try {
        const core = await import('@propr/core');
        if (typeof core.startLiveFileChangesCapture !== 'function') return NOOP_CAPTURE;
        const live = core.startLiveFileChangesCapture(options);
        return {
            stop: async ({ finalCapture = false } = {}) => {
                await live.stop();
                if (!finalCapture || typeof core.updateFileChangesFromWorktree !== 'function') return;
                try {
                    await core.updateFileChangesFromWorktree(options.taskId, options.worktreePath);
                } catch (error) {
                    options.log.warn({ error: (error as Error).message }, 'Failed to capture file changes');
                }
            },
        };
    } catch (error) {
        options.log.debug({ error: (error as Error).message }, 'Live file changes capture unavailable');
        return NOOP_CAPTURE;
    }
}
