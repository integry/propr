const DEFAULT_MAX_STALLED_COUNT = 3;

/**
 * How many times a job may stall before BullMQ fails it. A worker restart
 * stalls every running job once, and BullMQ's default (1) fails a job on the
 * second restart while its agent is still running. WORKER_MAX_STALLED_COUNT
 * overrides.
 */
export function resolveMaxStalledCount(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number.parseInt(env.WORKER_MAX_STALLED_COUNT ?? '', 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_STALLED_COUNT;
}
