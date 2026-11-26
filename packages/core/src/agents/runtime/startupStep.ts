/**
 * Stop waiting for an operation that does not accept a signal (SDK calls, a shared
 * promise). The operation keeps running; the caller owns any late resource it yields.
 */
export async function startupStep<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([cancelled, operation()]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}
