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
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    onTimeout?.();
                    reject(new NotificationOperationTimeoutError(operation, timeoutMs));
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
