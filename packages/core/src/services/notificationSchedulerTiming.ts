/** Largest delay Node schedules without coercing it to a near-immediate timer. */
export const MAX_NOTIFICATION_TIMER_DELAY_MS = 2_147_483_647;

export function isNotificationTimerDelay(value: number, allowZero = false): boolean {
    return Number.isSafeInteger(value)
        && (allowZero ? value >= 0 : value > 0)
        && value <= MAX_NOTIFICATION_TIMER_DELAY_MS;
}

export class NotificationOperationTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'NotificationOperationTimeoutError';
    }
}

export async function withNotificationDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
    onTimeout?: () => void
): Promise<T> {
    if (!isNotificationTimerDelay(timeoutMs)) {
        throw new TypeError('notification operation timeout must be a schedulable positive integer');
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    const timeoutError = new NotificationOperationTimeoutError(operation, timeoutMs);
                    try {
                        onTimeout?.();
                    } catch {
                        // Timeout cleanup is best-effort; the deadline must still reject.
                    } finally {
                        reject(timeoutError);
                    }
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    if (!isNotificationTimerDelay(timeoutMs)) {
        throw new TypeError('notification drain timeout must be a schedulable positive integer');
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise.then(() => true, () => true),
            new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
