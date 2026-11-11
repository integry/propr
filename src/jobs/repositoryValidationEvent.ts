import { db, getStateManager } from '@propr/core';
import type { RepositoryValidationResult } from '@propr/core';
import type { Logger } from 'pino';

/** The `repository.validation` timeline event for one run's validation commands. */
export function repositoryValidationEvent(result: RepositoryValidationResult): { reason: string; metadata: Record<string, unknown> } {
    const counts = new Map<string, number>();
    for (const entry of result.commands) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    const detail = [...counts].map(([status, count]) => `${count} ${status.replace('_', ' ')}`).join(', ');
    return { reason: `Repository validation ${result.overall}: ${detail}`, metadata: { event: 'repository.validation', repositoryValidation: result } };
}

/**
 * Records the structured validation outcome on the task timeline without changing
 * the task's state. Best effort: a timeline write never fails the run, and a run
 * without validation commands records nothing.
 */
export async function recordRepositoryValidationEvent(
    taskId: string, result: RepositoryValidationResult | undefined, correlatedLogger: Pick<Logger, 'warn'>,
    deps: { database?: typeof db; currentState?: (taskId: string) => Promise<string | undefined> } = {},
): Promise<void> {
    if (!result?.commands.length) return;
    const database = deps.database ?? db;
    try {
        const task = await database('tasks').where({ task_id: taskId }).first('task_id');
        if (!task) return;
        const state = deps.currentState ? await deps.currentState(taskId) : (await getStateManager().getTaskState(taskId))?.state;
        const event = repositoryValidationEvent(result);
        await database('task_history').insert({
            task_id: taskId,
            // Written right after the agent container exits; it must not read as a lifecycle change.
            state: state ?? 'claude_execution',
            timestamp: new Date().toISOString(),
            reason: event.reason,
            metadata: JSON.stringify(event.metadata),
        });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message, overall: result.overall }, 'Could not record repository validation timeline event');
    }
}
