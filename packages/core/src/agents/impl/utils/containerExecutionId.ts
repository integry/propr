import { randomUUID } from 'node:crypto';

/**
 * Builds the short execution identifier used in agent container names.
 *
 * The task suffix keeps names recognizable in diagnostics. Every invocation
 * also gets random entropy because separate commands can share the same task
 * suffix, and retries must not collide with an abandoned container from an
 * earlier attempt.
 */
export function createContainerExecutionId(taskId?: string): string {
    const executionNonce = randomUUID().replaceAll('-', '').slice(0, 8);
    return taskId
        ? `${taskId.slice(-8)}-${executionNonce}`
        : `${Date.now().toString(36)}-${executionNonce}`;
}
