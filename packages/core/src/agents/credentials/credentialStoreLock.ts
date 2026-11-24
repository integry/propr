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

function tryAcquire(lockPath: string, staleMs: number): boolean {
    try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { fs.closeSync(fd); }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.rmSync(lockPath, { force: true });
    } catch { /* released meanwhile */ }
    return false;
}

/**
 * Run `fn` holding the write-back lock of one canonical credential store.
 * The lock is a file created with O_EXCL, so it also serialises writers in
 * other worker processes that share the lock directory.
 */
export async function withCredentialStoreLock<T>(canonicalRoot: string, options: CredentialStoreLockOptions, fn: () => Promise<T> | T): Promise<T> {
    const lockPath = credentialStoreLockPath(options.lockRoot, canonicalRoot);
    const previous = inProcess.get(lockPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        fs.mkdirSync(options.lockRoot, { recursive: true, mode: 0o700 });
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        while (!tryAcquire(lockPath, options.staleMs ?? DEFAULT_STALE_MS)) {
            if (Date.now() >= deadline) throw new CredentialStoreLockTimeoutError(canonicalRoot, timeoutMs);
            await new Promise(resolve => setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS));
        }
        try {
            return await fn();
        } finally {
            fs.rmSync(lockPath, { force: true });
        }
    });
    inProcess.set(lockPath, run);
    try {
        return await run;
    } finally {
        if (inProcess.get(lockPath) === run) inProcess.delete(lockPath);
    }
}
