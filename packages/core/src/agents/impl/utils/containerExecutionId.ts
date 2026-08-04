import { randomUUID } from 'node:crypto';

/**
 * Builds the short execution identifier used in agent container names.
 *
 * Task-backed executions retain their stable task suffix. Ad-hoc analysis
 * calls have no task ID, so include random entropy in addition to the
 * timestamp to keep parallel calls started in the same millisecond unique.
 */
export function createContainerExecutionId(taskId?: string): string {
    if (taskId) return taskId.slice(-8);
    return `${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}
