import { db, logger, probeWorktreeReclamationDocker, sweepIdleWorktrees, runningContainerMountSources, resolveRepositoryWorktreeRoot, type WorktreeSweepResult } from '@propr/core';
import { HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE } from '../jobs/followupHandoffStore.js';
import { trustManagedGitDirectoriesAtStartup } from '../gitDirectoryTrust.js';

/** Terminal goals cannot resume: both goal routes and recovery fence continuation
 * with result_state IS NULL. Unreconciled terminal results still need their checkout.
 * Tasks do not consistently persist an exact checkout path before host-side work;
 * protect their repository subtree until the latest durable state is terminal.
 */
export async function referencedWorktreePaths(database = db, reportDiagnostics = true): Promise<string[]> {
    const goals = await database('goals').whereNotNull('worktree_path')
        .where(query => query.whereNull('result_state').orWhereNull('task_reconciled_at'))
        .pluck('worktree_path') as string[];
    const handoffs = await database(PR_FOLLOWUP_HANDOFFS_TABLE).whereNot('status', HANDOFF_RELEASED)
        .pluck('worktree_path') as string[];
    const activeTasks = database('tasks as task')
        .leftJoin('task_history as latest', function () {
            this.on('latest.task_id', '=', 'task.task_id').andOn('latest.history_id', '=', database.raw(
                '(select max(history_id) from task_history where task_id = task.task_id)',
            ));
        })
        .whereNotNull('task.repository')
        .where(query => query.whereNull('latest.state').orWhereNotIn('latest.state', ['completed', 'failed', 'cancelled']));
    // Fresh authority on every call, with bounded diagnostics once per sweep.
    const repositories = await activeTasks.clone().distinct('task.repository') as Array<{ repository: string }>;
    if (reportDiagnostics && repositories.length) {
        const [{ count }] = await activeTasks.clone().count({ count: 'task.task_id' });
        const sample = await activeTasks.clone().select('task.task_id', 'task.repository', 'latest.state').orderBy('task.task_id').limit(20);
        logger.warn({ taskCount: Number(count), blockedRepositoryCount: repositories.length, sample },
            'Nonterminal tasks protect repository worktrees; inspect task IDs for stale or missing history');
    }
    const taskRoots: string[] = [];
    for (const { repository } of repositories) {
        try {
            const parts = repository.split('/');
            if (parts.length !== 2) throw new Error('Expected owner/repo');
            taskRoots.push(resolveRepositoryWorktreeRoot(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees', parts[0], parts[1]));
        } catch {
            const task = await activeTasks.clone().where('task.repository', repository).first('task.task_id');
            const task_id = task?.task_id;
            logger.warn({ taskId: task_id, repository }, 'Invalid active task repository disables worktree sweeping; repair task authority');
            throw new Error(`Invalid active task repository for task ${task_id}: ${repository}`);
        }
    }
    return [...goals, ...handoffs, ...taskRoots].filter(Boolean);
}

export { runningContainerMountSources };

export async function sweepWorktrees(): Promise<WorktreeSweepResult | null> {
    try {
        let reportDiagnostics = true;
        return await sweepIdleWorktrees({
            minIdleHours: sweepSetting('WORKTREE_RETENTION_HOURS', 24, Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000)),
            protectedPaths: () => {
                const report = reportDiagnostics;
                reportDiagnostics = false;
                return referencedWorktreePaths(db, report);
            },
            mountedPaths: runningContainerMountSources,
        });
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Skipped idle worktree sweep: could not confirm which worktrees are in use');
        return null;
    }
}

/** Reject malformed settings rather than weakening age or creating a 1ms timer. */
function sweepSetting(name: string, fallback: number, maximum: number): number {
    const raw = process.env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
    }
    return value;
}

/** Runs once at startup (in the background) and then every WORKTREE_SWEEP_INTERVAL_MS (default 1 hour). */
export function scheduleWorktreeSweep(): NodeJS.Timeout | null {
    try {
        const intervalMs = sweepSetting('WORKTREE_SWEEP_INTERVAL_MS', 60 * 60 * 1000, 2_147_483_647);
        sweepSetting('WORKTREE_RETENTION_HOURS', 24, Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000));
        void probeWorktreeReclamationDocker();
        // The first sweep reads every managed worktree, so Git must already
        // trust them (agent-owned checkouts fail with "dubious ownership"
        // otherwise); a trust failure only logs and the sweep still runs.
        void trustManagedGitDirectoriesAtStartup().catch(() => undefined).then(() => sweepWorktrees());
        return setInterval(() => { void sweepWorktrees(); }, intervalMs);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Idle worktree sweep disabled: invalid configuration');
        return null;
    }
}
