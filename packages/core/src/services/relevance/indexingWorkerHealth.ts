export const INDEXING_WORKER_HEARTBEAT_KEY = 'system:status:indexing-worker';
export const INDEXING_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
// Keep the key beyond the full stale tolerance so Redis expiry cannot report a
// disconnect before the status sampler's advertised threshold.
export const INDEXING_WORKER_HEARTBEAT_TTL_SECONDS = 150;
export const INDEXING_WORKER_HEARTBEAT_STALE_MS = 120_000;
