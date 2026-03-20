export function formatResetTime(resetTimestamp: number | null | undefined): string {
    if (!resetTimestamp || typeof resetTimestamp !== 'number') {
        return 'at a later time';
    }
    const resetDate = new Date(resetTimestamp * 1000);
    return `${resetDate.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} on ${resetDate.toLocaleDateString()}`;
}

/**
 * Parse reset time from Claude rate limit message format.
 * Handles formats like "resets 1am (UTC)" or "resets 12pm (UTC)"
 * @returns Unix timestamp (seconds) or null if not parseable
 */
export function parseResetTimeFromMessage(message: string): number | null {
    // Match patterns like "resets 1am (UTC)", "resets 12pm (UTC)", "resets 1:00am (UTC)"
    const match = message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
    if (!match) return null;

    const hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const isPM = match[3].toLowerCase() === 'pm';

    // Convert to 24-hour format
    let hour24 = hours;
    if (isPM && hours !== 12) {
        hour24 = hours + 12;
    } else if (!isPM && hours === 12) {
        hour24 = 0;
    }

    // Create date in UTC
    const now = new Date();
    const resetDate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hour24,
        minutes,
        0,
        0
    ));

    // If the reset time is in the past, it's for tomorrow
    if (resetDate.getTime() <= now.getTime()) {
        resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    }

    return Math.floor(resetDate.getTime() / 1000);
}

/**
 * Calculate the next round hour plus 2 minutes from now.
 * @returns Unix timestamp (seconds)
 */
export function calculateNextRoundHourPlus2Minutes(): number {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    nextHour.setUTCMinutes(2);
    nextHour.setUTCSeconds(0);
    nextHour.setUTCMilliseconds(0);
    return Math.floor(nextHour.getTime() / 1000);
}

/**
 * Format a Unix timestamp for display in a user-friendly format.
 * @returns String like "1:02 AM UTC"
 */
export function formatRetryTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC'
    }) + ' UTC';
}

/**
 * Calculate hours until a given Unix timestamp.
 * @returns Number of hours (can be fractional)
 */
export function hoursUntil(timestamp: number): number {
    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = timestamp - now;
    return Math.max(0, diffSeconds / 3600);
}

export function addModelSpecificDelay(modelName: string): Promise<void> {
    const baseDelay = 500;
    const modelHash = modelName.split('').reduce((hash, char) => {
        return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
    }, 0);
    const modelDelay = Math.abs(modelHash % 1500);
    const totalDelay = baseDelay + modelDelay;

    return new Promise(resolve => setTimeout(resolve, totalDelay));
}
