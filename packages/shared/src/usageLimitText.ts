// Plain text for usage-limit notices; pure so every package can format the same way.

/** The limit a provider message names ("weekly limit", "5-hour limit"), or null. */
export function describeUsageLimitKind(message: string | null | undefined): string | null {
    const match = message?.match(/\b(weekly|daily|monthly|hourly|session|\d+-hour|opus|sonnet)\s+(?:usage\s+)?limit\b/i);
    return match ? `${match[1].toLowerCase()} limit` : null;
}

/**
 * "in 4 min", "in 1 h 5 min", "in 1 day 23 h": exact enough that two notices
 * minutes apart never disagree about the same reset time.
 */
export function formatTimeUntil(timestamp: number, nowMs: number = Date.now()): string {
    const totalMinutes = Math.max(0, Math.ceil((timestamp * 1000 - nowMs) / 60_000));
    if (totalMinutes < 1) return 'in less than a minute';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}`;
    if (hours > 0) return `in ${hours} h${minutes ? ` ${minutes} min` : ''}`;
    return `in ${minutes} min`;
}
