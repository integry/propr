export function formatResetTime(resetTimestamp: number | null | undefined): string {
    if (!resetTimestamp || typeof resetTimestamp !== 'number') {
        return 'at a later time';
    }
    const resetDate = new Date(resetTimestamp * 1000);
    return `${resetDate.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} on ${resetDate.toLocaleDateString()}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * One "resets …" clause: an optional month and day (a weekly limit names its
 * reset day), a time, and an optional zone in parentheses (UTC when absent).
 * Matches "resets 1am (UTC)", "resets 3:30pm (UTC)", "resets Nov 20, 1am (UTC)",
 * "resets Nov 20 at 1am (Europe/Riga)" and "reset at 5pm".
 */
const RESET_CLAUSE = /\breset(?:s)?(?:\s+at)?\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/gi;

/** Offset in ms of `timeZone` from UTC at `utcMs`; null for an unknown zone. */
function zoneOffsetMs(utcMs: number, timeZone: string): number | null {
    if (/^(?:utc|gmt|z)$/i.test(timeZone.trim())) return 0;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone.trim(), hourCycle: 'h23',
            year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
        }).formatToParts(new Date(utcMs));
        const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
        const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
        return asUtc - Math.floor(utcMs / 1000) * 1000;
    } catch {
        return null;
    }
}

/** The UTC instant of a wall-clock time in `timeZone` (UTC for an unknown zone). */
function wallClockToUtcMs(fields: [number, number, number, number, number], timeZone: string): number {
    const asUtc = Date.UTC(...fields);
    const first = zoneOffsetMs(asUtc, timeZone) ?? 0;
    const second = zoneOffsetMs(asUtc - first, timeZone) ?? first;
    return asUtc - second;
}

function resetClauseTimestamp(match: RegExpMatchArray, nowMs: number): number | null {
    const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
    const hours = parseInt(hourText, 10);
    const minutes = minuteText ? parseInt(minuteText, 10) : 0;
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    const hour24 = (hours % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    const timeZone = zone || 'UTC';
    // Calendar fields are read in the reset's zone: its date, and year, can differ from UTC's.
    const local = new Date(nowMs + (zoneOffsetMs(nowMs, timeZone) ?? 0));

    if (monthName) {
        const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
        const day = parseInt(dayText, 10);
        if (month === -1 || day < 1 || day > 31) return null;
        const year = local.getUTCFullYear();
        let resetMs = wallClockToUtcMs([year, month, day, hour24, minutes], timeZone);
        // A reset date more than a day behind is next year's (a December limit resetting in January).
        if (resetMs < nowMs - 24 * 60 * 60 * 1000) resetMs = wallClockToUtcMs([year + 1, month, day, hour24, minutes], timeZone);
        return Math.floor(resetMs / 1000);
    }

    // A time of day without a date is its next occurrence. Candidate days are
    // calendar days in the reset's zone.
    for (let dayDelta = -1; dayDelta <= 2; dayDelta++) {
        const resetMs = wallClockToUtcMs([local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayDelta, hour24, minutes], timeZone);
        if (resetMs > nowMs) return Math.floor(resetMs / 1000);
    }
    return null;
}

/**
 * Parse the reset time of the limit that was hit from a Claude rate-limit
 * message. A weekly limit names its reset day ("resets Nov 20, 1am (UTC)");
 * a five-hour limit only a time ("resets 1am (UTC)"). When the message lists
 * several limits, the reset following the text that says a limit was hit or
 * reached is used, otherwise the latest one: work cannot resume before it.
 * @returns Unix timestamp (seconds) or null if not parseable
 */
export function parseResetTimeFromMessage(message: string, nowMs: number = Date.now()): number | null {
    if (!message) return null;
    const candidates: Array<{ timestamp: number; hit: boolean }> = [];
    let previousEnd = 0;
    for (const match of message.matchAll(RESET_CLAUSE)) {
        const start = match.index ?? 0;
        // A reset belongs to the text since the previous reset: "You've hit your weekly limit · resets …".
        const describedLimit = message.slice(previousEnd, start);
        previousEnd = start + match[0].length;
        const timestamp = resetClauseTimestamp(match, nowMs);
        if (timestamp !== null) candidates.push({ timestamp, hit: /\b(?:hit|reached)\b/i.test(describedLimit) });
    }
    if (candidates.length === 0) return null;
    const hit = candidates.filter(candidate => candidate.hit);
    return Math.max(...(hit.length ? hit : candidates).map(candidate => candidate.timestamp));
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
 * @returns String like "1:02 AM UTC", or "Nov 20, 1:02 AM UTC" when more than 20 hours away
 */
export function formatRetryTime(timestamp: number, nowMs: number = Date.now()): string {
    const date = new Date(timestamp * 1000);
    const time = date.toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC'
    }) + ' UTC';
    // A weekly reset days away needs its date: a time alone reads as later today.
    if (timestamp * 1000 - nowMs <= 20 * 60 * 60 * 1000) return time;
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${day}, ${time}`;
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
