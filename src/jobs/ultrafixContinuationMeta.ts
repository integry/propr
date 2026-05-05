import type { Logger } from 'pino';
import type { UltrafixCommandMeta, WorkerStateManager } from '@propr/core';
import { TaskStates, db } from '@propr/core';

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
    stateManager: WorkerStateManager, taskId: string, continuationMeta: Record<string, unknown>, correlatedLogger: Logger,
): Promise<void> {
    try { await stateManager.updateHistoryMetadata(taskId, TaskStates.COMPLETED, continuationMeta); } catch (e) {
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into Redis history entry');
    }
    try {
        const row = await db('task_history').where({ task_id: taskId, state: 'completed' }).orderBy('timestamp', 'desc').first();
        if (row) {
            const existing = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
            await db('task_history').where({ history_id: row.history_id }).update({ metadata: JSON.stringify({ ...existing, ...continuationMeta }) });
        }
    } catch (e) {
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into SQLite history entry');
    }
}
