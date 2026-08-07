import type { Logger } from 'pino';
import {
    findTaskContainer,
    inspectLegacyDockerContainerLivenessForTask,
    stopDockerContainer,
} from '@propr/core';

/** Prevents a new PR attempt from overlapping either labeled or pre-label agent containers. */
export async function stopAbandonedPRTaskContainer(
    taskId: string,
    correlatedLogger: Logger,
    assertLease: () => Promise<void>,
): Promise<boolean> {
    for (;;) {
        const container = await findTaskContainer(taskId);
        if (!container) break;
        await assertLease();
        correlatedLogger.warn({ taskId, containerId: container.id, containerName: container.name }, 'Found an agent container after acquiring an unowned PR lease; stopping the abandoned execution');
        const stopped = await stopDockerContainer(container.id, 10);
        if (!stopped.success) {
            correlatedLogger.error({ taskId, containerId: container.id, error: stopped.error }, 'Could not stop abandoned agent container; rescheduling to avoid overlapping executions');
            return false;
        }
    }
    await assertLease();
    const legacyLiveness = await inspectLegacyDockerContainerLivenessForTask(taskId);
    await assertLease();
    if (legacyLiveness === 'not_found') return true;
    correlatedLogger.warn(
        { taskId, legacyLiveness },
        'A pre-label agent container may still be running; rescheduling to avoid overlapping executions',
    );
    return false;
}
