const UNIX_SECONDS_TIMESTAMP_MAX = 10_000_000_000;

export function normalizeOpenCodeTimestamp(timestamp: unknown, fallback: string = new Date().toISOString()): string {
    if (typeof timestamp === 'string' && timestamp.trim()) return timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return fallback;
    const epochMilliseconds = Math.abs(timestamp) < UNIX_SECONDS_TIMESTAMP_MAX ? timestamp * 1000 : timestamp;
    const date = new Date(epochMilliseconds);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
