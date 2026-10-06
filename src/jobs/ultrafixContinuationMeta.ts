import type { Logger } from 'pino';
import type { UltrafixCommandMeta, WorkerStateManager } from '@propr/core';
import { TaskStates, db } from '@propr/core';

interface ContinuationMetaInput {
    continued: boolean;
    reason: string;
    nextAction?: string;
    score?: number | null;
    cycleCount?: number;
    deferred?: boolean;
    outcome?: 'goal_reached' | 'cycles_exhausted' | 'stopped' | 'failed';
    goal?: number;
    maxCycles?: number;
    blockingChecks?: string[];
}

export function buildUltrafixHistoryMeta(
    ultrafixMeta: UltrafixCommandMeta,
    ufState: { cycleCount?: number; reviewCount?: number; fixCount?: number; goal?: number | string; maxCycles?: number } | null,
    action?: string,
): Record<string, unknown> {
    const cycle = action === 'review' ? (ufState?.reviewCount ?? ufState?.cycleCount ?? 0) + 1
        : action === 'fix' ? (ufState?.fixCount ?? ufState?.cycleCount ?? 0) + 1
        : (ufState?.cycleCount ?? 0) + 1;
    return { ultrafixCycle: cycle, ultrafixGoal: ultrafixMeta.goal ?? ufState?.goal,
        ultrafixCycleCount: ufState?.cycleCount ?? 0, ultrafixMaxCycles: ultrafixMeta.maxCycles ?? ufState?.maxCycles };
}

export function buildContinuationMeta(r: ContinuationMetaInput, ultrafixMeta?: UltrafixCommandMeta): Record<string, unknown> {
    return { ...(r.score != null && { ultrafixScore: r.score }),
        ...(r.cycleCount != null && { ultrafixCycleCount: r.cycleCount }),
        ...(r.nextAction && { ultrafixNextAction: r.nextAction }), ...(r.deferred && { ultrafixDeferred: true, ultrafixDeferralReason: r.reason }),
        ...(r.blockingChecks?.length && { ultrafixBlockingChecks: r.blockingChecks }),
        ...(!r.continued && { ultrafixStopReason: r.reason }), ...(r.outcome && { ultrafixOutcome: r.outcome }),
        ...((r.goal ?? ultrafixMeta?.goal) != null && { ultrafixGoal: r.goal ?? ultrafixMeta?.goal }),
        ...((r.maxCycles ?? ultrafixMeta?.maxCycles) != null && { ultrafixMaxCycles: r.maxCycles ?? ultrafixMeta?.maxCycles }) };
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
