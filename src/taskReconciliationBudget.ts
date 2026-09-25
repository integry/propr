export class ReconciliationDeadlineExceededError extends Error {
    constructor() {
        super('Task state reconciliation time budget was exhausted');
        this.name = 'ReconciliationDeadlineExceededError';
    }
}

export function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Task state reconciliation was aborted');
}

export function deadlineWasExhausted(error: unknown, signal: AbortSignal): boolean {
    return error instanceof ReconciliationDeadlineExceededError
        || (signal.aborted && abortReason(signal) instanceof ReconciliationDeadlineExceededError);
}

export async function runWithinRemainingBudget<T>(
    operation: () => Promise<T>,
    deadline: number,
    signal: AbortSignal,
): Promise<T> {
    if (Date.now() >= deadline) throw new ReconciliationDeadlineExceededError();
    signal.throwIfAborted();

    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(abortReason(signal));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }

        let pending: Promise<T>;
        try {
            pending = operation();
        } catch (error) {
            cleanup();
            reject(error);
            return;
        }
        pending.then(
            value => {
                cleanup();
                resolve(value);
            },
            error => {
                cleanup();
                reject(error);
            },
        );
    });
}
