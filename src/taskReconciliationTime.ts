function timestampMilliseconds(value: string | number): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value).trim();
    if (/^\d{10,}$/.test(text)) {
        const numeric = Number(text);
        if (Number.isFinite(numeric)) {
            return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
        }
    }
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
}

export function taskAgeMs(updatedAt: string | number, now = Date.now()): number | null {
    const timestamp = timestampMilliseconds(updatedAt);
    if (timestamp === null || timestamp > now) return null;
    return now - timestamp;
}
