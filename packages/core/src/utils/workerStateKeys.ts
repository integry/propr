import type { WorkerStateManagerOptions } from './workerStateManager.types.js';

export const DEFAULT_WORKER_STATE_KEY_PREFIX = 'worker:state:';

export function getWorkerStateRedisKeys(
    taskId: string,
    options: Pick<WorkerStateManagerOptions, 'keyPrefix' | 'revisionKeyPrefix'> = {},
): { stateKey: string; revisionKey: string } {
    const keyPrefix = options.keyPrefix ?? DEFAULT_WORKER_STATE_KEY_PREFIX;
    const revisionKeyPrefix = options.revisionKeyPrefix ?? `revision:${keyPrefix}`;
    return {
        stateKey: `${keyPrefix}${taskId}`,
        revisionKey: `${revisionKeyPrefix}${taskId}`,
    };
}
