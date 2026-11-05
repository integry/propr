/** Accept only positive safe integers, including numeric configuration strings. */
function positiveInteger(value: unknown): number | undefined {
    const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Shared ceiling for main-worker startup and repository workflow policy.
 * CONFIG_REPO opts self-hosted instances into the persisted override. Without it,
 * WORKER_CONCURRENCY is authoritative (including Hosted Fleet entitlements).
 * This resolves a per-process limit, not an instance-wide admission semaphore.
 */
export function resolveWorkerConcurrency(
    setting?: unknown,
    env: { CONFIG_REPO?: string; WORKER_CONCURRENCY?: string } = process.env,
): number {
    return (env.CONFIG_REPO ? positiveInteger(setting) : undefined)
        ?? positiveInteger(env.WORKER_CONCURRENCY)
        ?? 5;
}
