import type { Logger } from 'pino';
import type { UltrafixCommandMeta, WorkerStateManager } from '@propr/core';
import { hashTaskAttemptToken, SupersededTaskAttemptError, TaskStates, db } from '@propr/core';

interface ContinuationMetaInput {
    continued: boolean;
    reason: string;
    nextAction?: string;
    score?: number | null;
    cycleCount?: number;
}

export function buildUltrafixHistoryMeta(
    ultrafixMeta: UltrafixCommandMeta, ufState: { cycleCount?: number; goal?: number | string; maxCycles?: number } | null,
): Record<string, unknown> {
    return { ultrafixCycle: true, ultrafixGoal: ultrafixMeta.goal ?? ufState?.goal, ultrafixCycleCount: ufState?.cycleCount ?? 0, ultrafixMaxCycles: ultrafixMeta.maxCycles ?? ufState?.maxCycles };
}

export function buildContinuationMeta(r: ContinuationMetaInput): Record<string, unknown> {
    return { ...(r.score != null && { ultrafixScore: r.score }), ...(r.cycleCount != null && { ultrafixCycleCount: r.cycleCount }), ...(r.nextAction && { ultrafixNextAction: r.nextAction }), ...(!r.continued && { ultrafixStopReason: r.reason }) };
}

export async function patchUltrafixContinuationMeta(
    stateManager: WorkerStateManager,
    taskId: string,
    continuationMeta: Record<string, unknown>,
    options: { correlatedLogger: Logger; prProcessingLockToken?: string },
): Promise<void> {
    const { correlatedLogger, prProcessingLockToken } = options;
    if (prProcessingLockToken !== undefined) {
        try {
            const currentState = await stateManager.getTaskState(taskId);
            if (currentState?.prProcessingLockToken !== prProcessingLockToken) {
                throw new SupersededTaskAttemptError(taskId);
            }
        } catch (e) {
            if (e instanceof SupersededTaskAttemptError) throw e;
            correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to verify ultrafix metadata attempt ownership');
            return;
        }
    }
    try { await stateManager.updateHistoryMetadata(taskId, TaskStates.COMPLETED, continuationMeta, prProcessingLockToken); } catch (e) {
        if (e instanceof SupersededTaskAttemptError) throw e;
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into Redis history entry');
    }
    try {
        const attemptGeneration = prProcessingLockToken
            ? hashTaskAttemptToken(prProcessingLockToken)
            : undefined;
        const historyQuery = db('task_history').where({ task_id: taskId, state: 'completed' });
        if (attemptGeneration) historyQuery.andWhere('attempt_generation', attemptGeneration);
        const row = await historyQuery.orderBy('task_version', 'desc').orderBy('timestamp', 'desc').first();
        if (row) {
            const existing = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
            const updateQuery = db('task_history').where({ history_id: row.history_id });
            if (attemptGeneration) {
                const currentAttempt = db('tasks')
                    .select('task_id')
                    .whereRaw('tasks.task_id = task_history.task_id')
                    .andWhere('attempt_generation', attemptGeneration);
                updateQuery
                    .andWhere('attempt_generation', attemptGeneration)
                    .whereExists(currentAttempt);
            }
            const updatedRows = await updateQuery.update({ metadata: JSON.stringify({ ...existing, ...continuationMeta }) });
            if (attemptGeneration && updatedRows !== 1) throw new SupersededTaskAttemptError(taskId);
        }
    } catch (e) {
        if (e instanceof SupersededTaskAttemptError) throw e;
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into SQLite history entry');
    }
}
