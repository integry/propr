import { logger } from '@propr/core';

/** Flush buffered log lines before the process exits; bounded, so a stuck transport cannot hold the exit. */
export function flushLogs(timeoutMs = 1_000): Promise<void> {
    return new Promise(resolve => {
        const flush = (logger as unknown as { flush?: (cb?: (err?: Error) => void) => void }).flush;
        if (typeof flush !== 'function') return resolve();
        setTimeout(resolve, timeoutMs).unref();
        try {
            flush.call(logger, () => resolve());
        } catch {
            resolve();
        }
    });
}
