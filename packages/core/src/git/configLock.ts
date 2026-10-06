import path from 'path';
import { SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';
import { redactAuthenticatedGitUrl } from './redactGitUrl.js';

/**
 * Parallel workers share one clone per repository. Git serializes writes to
 * `.git/config` and refs through `<file>.lock` files and fails immediately
 * (rather than waiting) when another process holds the lock. Those failures
 * are transient contention, not repository corruption. Git reports a held
 * lock as EEXIST ("File exists"); the same prefixes followed by other errors
 * (e.g. "Permission denied", "Read-only file system") are permanent and must
 * not be retried or reported as contention.
 */
const GIT_LOCK_CONTENTION_PATTERNS: RegExp[] = [
    /could not lock config file [^\n]*: file exists/i,
    /unable to create '[^']*\.lock': file exists/i,
    /another git process seems to be running/i,
    // A concurrent fetch in the same clone moved the ref first.
    /cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+/i,
];

export function isGitLockContentionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return GIT_LOCK_CONTENTION_PATTERNS.some(pattern => pattern.test(message));
}

export interface GitLockRetryOptions {
    /** Total attempts, including the first one. */
    attempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
}

const DEFAULT_LOCK_RETRY: Required<GitLockRetryOptions> = {
    attempts: 8,
    initialDelayMs: 100,
    maxDelayMs: 2000,
};

export class GitLockContentionError extends Error {
    constructor(operation: string, attempts: number, cause: unknown) {
        const detail = redactAuthenticatedGitUrl(cause instanceof Error ? cause.message : String(cause));
        super(`Git lock contention persisted while ${operation} after ${attempts} attempts; another Git process still holds a lock in the shared clone. `
            + 'The repository was left untouched. Retry once the other process finishes; if no Git process is running, '
            + `inspect and remove the stale lock file manually. Git error: ${detail}`);
        this.name = 'GitLockContentionError';
    }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Run a Git operation, retrying with bounded backoff only while it fails on a
 * lock held by another process. Other errors are rethrown unchanged, and an
 * existing lock is never removed: its owner may still be writing.
 */
export async function withGitLockRetry<T>(operation: string, run: () => Promise<T>, options: GitLockRetryOptions = {}): Promise<T> {
    const { attempts, initialDelayMs, maxDelayMs } = { ...DEFAULT_LOCK_RETRY, ...options };
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (!isGitLockContentionError(error)) throw error;
            if (attempt >= attempts) throw new GitLockContentionError(operation, attempts, error);
            const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
            logger.debug({ operation, attempt, delay }, 'Git lock is held by another process; retrying');
            await sleep(delay + Math.floor(Math.random() * initialDelayMs));
        }
    }
}

const configWriteQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize shared-config writes from this process per clone (keyed by the Git
 * common directory, so linked worktrees share the key). Writers in other
 * processes are handled by {@link withGitLockRetry}.
 */
export async function serializeSharedConfigWrite<T>(git: SimpleGit, run: () => Promise<T>): Promise<T> {
    const key = path.resolve((await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());

    const previous = configWriteQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    configWriteQueues.set(key, current);
    try {
        return await current;
    } finally {
        if (configWriteQueues.get(key) === current) configWriteQueues.delete(key);
    }
}
