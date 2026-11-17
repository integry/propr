export function formatResetTime(resetTimestamp: number | null | undefined): string {
    if (!resetTimestamp || typeof resetTimestamp !== 'number') {
        return 'at a later time';
    }
    const resetDate = new Date(resetTimestamp * 1000);
    return `${resetDate.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} on ${resetDate.toLocaleDateString()}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse reset time from Claude rate limit message format.
 * Handles "resets 1am (UTC)", "resets 12:30pm (UTC)" and the dated weekly
 * form "resets Nov 18, 4pm (UTC)" / "resets Nov 18 at 4pm (UTC)".
 * @returns Unix timestamp (seconds) or null if not parseable
 */
export function parseResetTimeFromMessage(message: string, now: Date = new Date()): number | null {
    const match = message.match(/resets?\s+(?:(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
    if (!match) return null;
    const [, monthName, dayText, hourText, minuteText, meridiem] = match;

    const hours = parseInt(hourText, 10);
    const minutes = minuteText ? parseInt(minuteText, 10) : 0;
    const isPM = meridiem.toLowerCase() === 'pm';
    if (hours < 1 || hours > 12 || minutes > 59) return null;

    // Convert to 24-hour format
    let hour24 = hours;
    if (isPM && hours !== 12) {
        hour24 = hours + 12;
    } else if (!isPM && hours === 12) {
        hour24 = 0;
    }

    if (monthName) {
        const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
        const day = parseInt(dayText, 10);
        if (month < 0 || day < 1 || day > 31) return null;
        // The year is implied: the next such date that is not in the past.
        let resetDate = new Date(Date.UTC(now.getUTCFullYear(), month, day, hour24, minutes, 0, 0));
        if (resetDate.getTime() <= now.getTime() - 24 * 60 * 60 * 1000) {
            resetDate = new Date(Date.UTC(now.getUTCFullYear() + 1, month, day, hour24, minutes, 0, 0));
        }
        return Math.floor(resetDate.getTime() / 1000);
    }

    // Create date in UTC
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
export function formatRetryTime(timestamp: number, nowMs: number = Date.now()): string {
    const date = new Date(timestamp * 1000);
    const time = date.toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC'
    }) + ' UTC';
    // A reset on another day (a weekly limit) names its date.
    const sameDay = new Date(nowMs).toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
    return sameDay ? time : `${date.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${time}`;
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
