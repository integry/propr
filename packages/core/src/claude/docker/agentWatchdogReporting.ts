import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { recordAgentWatchdogTrip } from '../../utils/llmMetrics.js';
import type { AgentWatchdogTrip } from './agentActivityWatchdog.js';

export interface AgentWatchdogReportingDeps {
    database?: typeof db;
    recordMetric?: (rule: AgentWatchdogTrip['rule']) => Promise<void>;
}

/**
 * Durable observability for a watchdog trip: a task timeline (task_history)
 * entry and a per-rule metric. The terminal state, its Inbox notification and
 * the issue/PR comment follow from the task's normal completion path, which
 * sees the run's `stalled` / `degenerate_output` termination reason.
 * Best effort: reporting never changes how the run ends.
 */
export async function reportAgentWatchdogTrip(taskId: string, trip: AgentWatchdogTrip, deps: AgentWatchdogReportingDeps = {}): Promise<void> {
    const database = deps.database ?? db;
    const recordMetric = deps.recordMetric ?? recordAgentWatchdogTrip;
    logger.warn({ taskId, rule: trip.rule, threshold: trip.threshold, silentSeconds: trip.silentSeconds, degenerateDeltas: trip.degenerateDeltas }, trip.message);
    await Promise.allSettled([
        recordMetric(trip.rule),
        (async () => {
            const task = await database('tasks').where({ task_id: taskId }).first('task_id');
            if (!task) return;
            await database('task_history').insert({
                task_id: taskId,
                // A timeline entry inside the execution; the terminal transition follows it.
                state: 'claude_execution',
                timestamp: new Date().toISOString(),
                reason: trip.message,
                metadata: JSON.stringify({
                    agentWatchdog: {
                        rule: trip.rule,
                        terminationReason: trip.terminationReason,
                        threshold: trip.threshold,
                        ...(trip.silentSeconds !== undefined ? { silentSeconds: trip.silentSeconds } : {}),
                        ...(trip.degenerateDeltas !== undefined ? { degenerateDeltas: trip.degenerateDeltas } : {}),
                    },
                }),
            });
        })().catch(error => logger.warn({ taskId, error: (error as Error).message }, 'Could not record agent watchdog timeline event')),
    ]);
}
