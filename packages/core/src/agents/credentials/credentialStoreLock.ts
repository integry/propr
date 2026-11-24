import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CredentialStoreLockOptions {
    /** Directory holding the lock files (never the canonical store itself, which may be read-only). */
    lockRoot: string;
    timeoutMs?: number;
    /** A lock older than this is assumed to belong to a crashed writer and is broken. */
    staleMs?: number;
    pollMs?: number;
    /** Test hook: runs after a stale lock was observed, before it is broken. */
    onStaleLockObserved?: () => void;
    /** Test hook: runs after `fn` settled, before the lock is released. */
    onBeforeRelease?: () => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;

export class CredentialStoreLockTimeoutError extends Error {
    constructor(root: string, timeoutMs: number) {
        super(`Timed out after ${timeoutMs}ms waiting for the credential write-back lock of ${root}`);
        this.name = 'CredentialStoreLockTimeoutError';
    }
}

/** Writers in the same process queue here before contending for the file lock. */
const inProcess = new Map<string, Promise<unknown>>();

/** Directory holding the lock epochs of one canonical store (see {@link withCredentialStoreLock}). */
export function credentialStoreLockPath(lockRoot: string, canonicalRoot: string): string {
    const key = createHash('sha256').update(path.resolve(canonicalRoot)).digest('hex').slice(0, 32);
    return path.join(lockRoot, `${key}.lock`);
}

const EPOCH_NAME = /^(\d+)(\.released)?$/;
const releasedName = (epoch: number): string => `${epoch}.released`;

function highestEpoch(names: string[]): number {
    let highest = 0;
    for (const name of names) {
        const match = EPOCH_NAME.exec(name);
        if (match && !match[2]) highest = Math.max(highest, Number(match[1]));
    }
    return highest;
}

function mtimeOf(file: string): number | undefined {
    try { return fs.statSync(file).mtimeMs; } catch { return undefined; }
}

export interface CredentialStoreLockState {
    /** Latest acquisition (0 before the first one). */
    epoch: number;
    /** Whether that acquisition is still held, i.e. neither released nor broken. */
    held: boolean;
}

/** Current state of a store lock, for diagnostics and tests. */
export function inspectCredentialStoreLock(lockRoot: string, canonicalRoot: string): CredentialStoreLockState {
    let names: string[];
    try { names = fs.readdirSync(credentialStoreLockPath(lockRoot, canonicalRoot)); } catch { return { epoch: 0, held: false }; }
    const epoch = highestEpoch(names);
    return { epoch, held: epoch > 0 && !names.includes(releasedName(epoch)) };
}

/** Marks our own epoch released; it touches no other acquisition's file. */
function markReleased(lockDir: string, epoch: number): void {
    try {
        fs.closeSync(fs.openSync(path.join(lockDir, releasedName(epoch)), 'wx', 0o600));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

/**
 * Remove epochs at least two behind ours that are older than `staleMs`. The
 * newest two are always kept, so the highest epoch (which decides who may
 * acquire next) never regresses; see {@link tryAcquire} for why a resumed
 * acquirer cannot reuse a removed epoch number.
 */
function pruneOldEpochs(lockDir: string, names: string[], epoch: number, staleMs: number): void {
    for (const name of names) {
        const match = EPOCH_NAME.exec(name);
        if (!match || Number(match[1]) >= epoch - 1) continue;
        const file = path.join(lockDir, name);
        const mtimeMs = mtimeOf(file);
        if (mtimeMs !== undefined && Date.now() - mtimeMs > staleMs) fs.rmSync(file, { force: true });
    }
}

/**
 * One acquisition attempt. Acquisitions are numbered epochs: epoch `n` is
 * held by whoever created the file `n` (exclusively), and ends when its
 * holder creates `n.released` or, once `n` is older than `staleMs`, when a
 * reclaimer creates `n + 1`. Nobody ever removes another holder's file to
 * release or break a lock, so a holder resuming after it was judged stale
 * only marks its own, superseded epoch released and cannot free a
 * replacement holder's lock. Exclusive creation of `n + 1` lets exactly one
 * of several reclaimers (or waiters) win.
 *
 * An acquirer suspended between reading the directory and creating its
 * epoch could find that number free again after pruning removed it; it then
 * sees a higher epoch when it re-reads the directory, marks its own epoch
 * released and retries, so it never runs alongside the current holder.
 */
function tryAcquire(lockDir: string, staleMs: number, onStaleLockObserved?: () => void): number | undefined {
    const highest = highestEpoch(fs.readdirSync(lockDir));
    if (highest > 0 && !fs.existsSync(path.join(lockDir, releasedName(highest)))) {
        const mtimeMs = mtimeOf(path.join(lockDir, String(highest)));
        if (mtimeMs === undefined || Date.now() - mtimeMs <= staleMs) return undefined;
        onStaleLockObserved?.();
    }
    const epoch = highest + 1;
    try {
        fs.writeFileSync(path.join(lockDir, String(epoch)), `${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw error;
    }
    const names = fs.readdirSync(lockDir);
    if (highestEpoch(names) > epoch) {
        markReleased(lockDir, epoch);
        return undefined;
    }
    pruneOldEpochs(lockDir, names, epoch, staleMs);
    return epoch;
}

/**
 * Run `fn` holding the write-back lock of one canonical credential store.
 * The lock is a directory of exclusively created epoch files, so it also
 * serialises writers in other worker processes that share the lock
 * directory. Release and stale takeover never remove a holder's file
 * (see {@link tryAcquire}).
 */
export async function withCredentialStoreLock<T>(canonicalRoot: string, options: CredentialStoreLockOptions, fn: () => Promise<T> | T): Promise<T> {
    const lockPath = credentialStoreLockPath(options.lockRoot, canonicalRoot);
    const previous = inProcess.get(lockPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        let epoch: number | undefined;
        while (!(epoch = tryAcquire(lockPath, options.staleMs ?? DEFAULT_STALE_MS, options.onStaleLockObserved))) {
            if (Date.now() >= deadline) throw new CredentialStoreLockTimeoutError(canonicalRoot, timeoutMs);
            await new Promise(resolve => setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS));
        }
        try {
            return await fn();
        } finally {
            try { options.onBeforeRelease?.(); } finally { markReleased(lockPath, epoch); }
        }
    });
    inProcess.set(lockPath, run);
    try {
        return await run;
    } finally {
        if (inProcess.get(lockPath) === run) inProcess.delete(lockPath);
    }
}
