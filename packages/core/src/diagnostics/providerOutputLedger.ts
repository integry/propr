import type { LogIdentity, ManagedLogSpool } from './managedLogSpool.js';
import { processDiagnosticState } from './redaction.js';

/** Another worker holds the spool's write lock; the attempt never ran. */
export function isStorageContention(error: unknown): boolean {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    return (typeof code === 'string' && /^SQLITE_(?:BUSY|LOCKED)/.test(code))
        || (typeof message === 'string' && /database (?:is locked|table is locked|schema is locked)/i.test(message));
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous attempts, with jittered backoff, while contention persists and
 * `deadline` allows. Any other error, or contention at the deadline, throws. */
export function untilDeadline<T>(fn: () => T, deadline?: number): T {
    for (let delay = 5; ; delay = Math.min(delay * 2, 40)) {
        try { return fn(); } catch (error) {
            const wait = delay + Math.floor(Math.random() * delay);
            if (deadline === undefined || !isStorageContention(error) || Date.now() + wait >= deadline) throw error;
            Atomics.wait(sleeper, 0, 0, wait);
        }
    }
}

/** Durable markers owed per provider source: the capture boundary, the exact
 * bytes of batches that could not be committed, and of lines shed at the buffer
 * bound while the spool was contended. Keyed by identity, so it is
 * bounded by the sources in use, not by captures or failed batches. Entries are
 * only removed once the spool has recorded them. */
interface Owed { identity: LogIdentity; interrupted: boolean; bytes: number; overflow: number }
const ledger = processDiagnosticState('provider-output-ledger@1', () => ({
    owed: new Map<string, Owed>(), timer: undefined as NodeJS.Timeout | undefined, delay: 0,
}));
export function owe(identity: LogIdentity, debt: { interrupted?: boolean; bytes?: number; overflow?: number }): void {
    const key = JSON.stringify(identity);
    const entry = ledger.owed.get(key) ?? { identity, interrupted: false, bytes: 0, overflow: 0 };
    entry.interrupted ||= debt.interrupted === true;
    entry.bytes = Math.min(Number.MAX_SAFE_INTEGER, entry.bytes + (debt.bytes ?? 0));
    entry.overflow = Math.min(Number.MAX_SAFE_INTEGER, entry.overflow + (debt.overflow ?? 0));
    ledger.owed.set(key, entry);
}
/** Record what `identity` owes before any later records; throws on failure,
 * keeping whatever was not yet recorded. */
export function settle(db: ManagedLogSpool, identity: LogIdentity, deadline?: number): void {
    const key = JSON.stringify(identity), entry = ledger.owed.get(key);
    if (!entry) return;
    if (entry.interrupted) { untilDeadline(() => db.report(identity, 'capture-interrupted'), deadline); entry.interrupted = false; }
    if (entry.overflow) { untilDeadline(() => db.report(identity, 'buffer-capacity', entry.overflow), deadline); entry.overflow = 0; }
    if (entry.bytes) { untilDeadline(() => db.report(identity, 'storage-unavailable', entry.bytes), deadline); entry.bytes = 0; }
    ledger.owed.delete(key);
}
/** Settle every source; false if anything is still owed. */
export function settleAll(db: ManagedLogSpool, deadline?: number): boolean {
    for (const { identity } of [...ledger.owed.values()]) {
        try { settle(db, identity, deadline); } catch { /* retained for the next pass */ }
    }
    return ledger.owed.size === 0;
}
/** Retry owed markers in the background with capped, jittered backoff. The
 * timer never keeps the process alive; the exit drain makes the last attempt. */
export function retryOwed(db: ManagedLogSpool, onFailure: () => void): void {
    if (ledger.timer || !ledger.owed.size) return;
    ledger.delay = Math.min(Math.max(ledger.delay * 2, 50), 1_000);
    ledger.timer = setTimeout(() => {
        ledger.timer = undefined;
        if (settleAll(db)) ledger.delay = 0;
        else { onFailure(); retryOwed(db, onFailure); }
    }, ledger.delay / 2 + Math.floor(Math.random() * ledger.delay / 2));
    ledger.timer.unref();
}
