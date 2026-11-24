import { createHash, randomBytes } from 'node:crypto';
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

export function credentialStoreLockPath(lockRoot: string, canonicalRoot: string): string {
    const key = createHash('sha256').update(path.resolve(canonicalRoot)).digest('hex').slice(0, 32);
    return path.join(lockRoot, `${key}.lock`);
}

/** The holder token is the first field of the lock file; it names this acquisition, never reused. */
function readLockToken(lockPath: string): { token: string; mtimeMs: number } | undefined {
    let fd: number;
    try { fd = fs.openSync(lockPath, 'r'); } catch { return undefined; }
    try {
        const { mtimeMs } = fs.fstatSync(fd);
        const buffer = Buffer.alloc(256);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return { token: buffer.subarray(0, length).toString('utf8').trim().split(/\s+/)[0] ?? '', mtimeMs };
    } finally {
        fs.closeSync(fd);
    }
}

const takeoverPrefix = (lockPath: string, token: string): string =>
    `${lockPath}.takeover-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;

function removeTakeoverMarkers(lockPath: string, token: string): void {
    const prefix = path.basename(takeoverPrefix(lockPath, token));
    try {
        for (const name of fs.readdirSync(path.dirname(lockPath))) {
            if (name.startsWith(prefix)) fs.rmSync(path.join(path.dirname(lockPath), name), { force: true });
        }
    } catch { /* best effort */ }
}

/**
 * Break the stale lock identified by `token`, and only that one.
 *
 * Reclaimers first win an exclusive takeover marker named after the stale
 * holder's token, so exactly one of them may remove that holder's file. The
 * winner re-reads the lock before removing it: a lock file only disappears
 * when its own holder releases it or the single marker winner breaks it, so
 * a replacement created by another reclaimer is never removed by a stale
 * observation. A marker left by a reclaimer that crashed mid-takeover is
 * itself stale after `staleMs`; the next reclaimer uses the next numbered
 * marker instead of deleting it, so no marker is ever removed while a
 * reclaimer may still act on it.
 */
function breakStaleLock(lockPath: string, token: string, staleMs: number): void {
    const prefix = takeoverPrefix(lockPath, token);
    for (let attempt = 0; attempt < 64; attempt++) {
        const marker = `${prefix}.${attempt}`;
        try {
            fs.closeSync(fs.openSync(marker, 'wx', 0o600));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
                if (Date.now() - fs.statSync(marker).mtimeMs <= staleMs) return; // another reclaimer is breaking it
            } catch { return; /* cleaned up: the stale lock is gone */ }
            continue;
        }
        if (readLockToken(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
        removeTakeoverMarkers(lockPath, token);
        return;
    }
}

function tryAcquire(lockPath: string, staleMs: number, onStaleLockObserved?: () => void): string | undefined {
    const token = randomBytes(16).toString('hex');
    // Publish the lock fully written: link() is atomic and fails when a holder exists,
    // so a reader never sees an empty lock file it could mistake for another holder's.
    const pending = `${lockPath}.pending-${token}`;
    fs.writeFileSync(pending, `${token} ${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    try {
        fs.linkSync(pending, lockPath);
        return token;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
        fs.rmSync(pending, { force: true });
    }
    const holder = readLockToken(lockPath);
    if (holder && Date.now() - holder.mtimeMs > staleMs) {
        onStaleLockObserved?.();
        breakStaleLock(lockPath, holder.token, staleMs);
    }
    return undefined;
}

/** Release only our own lock: a holder judged stale may find its file already broken and replaced. */
function release(lockPath: string, token: string): void {
    if (readLockToken(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
}

/**
 * Run `fn` holding the write-back lock of one canonical credential store.
 * The lock is a file published with link(), which fails while another holder
 * exists, so it also serialises writers in other worker processes that share
 * the lock directory. Stale takeover and release only ever remove the lock
 * file of the holder they observed (see {@link breakStaleLock}).
 */
export async function withCredentialStoreLock<T>(canonicalRoot: string, options: CredentialStoreLockOptions, fn: () => Promise<T> | T): Promise<T> {
    const lockPath = credentialStoreLockPath(options.lockRoot, canonicalRoot);
    const previous = inProcess.get(lockPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        fs.mkdirSync(options.lockRoot, { recursive: true, mode: 0o700 });
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        let token: string | undefined;
        while (!(token = tryAcquire(lockPath, options.staleMs ?? DEFAULT_STALE_MS, options.onStaleLockObserved))) {
            if (Date.now() >= deadline) throw new CredentialStoreLockTimeoutError(canonicalRoot, timeoutMs);
            await new Promise(resolve => setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS));
        }
        try {
            return await fn();
        } finally {
            release(lockPath, token);
        }
    });
    inProcess.set(lockPath, run);
    try {
        return await run;
    } finally {
        if (inProcess.get(lockPath) === run) inProcess.delete(lockPath);
    }
}
