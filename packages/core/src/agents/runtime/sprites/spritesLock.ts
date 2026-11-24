import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The cross-process lock that keeps two worker processes off one Sprite.
 *
 * It is an operating-system file lock, not a file that names its owner: the
 * lock file is opened as an (empty) SQLite database and an exclusive
 * transaction is held on it, which SQLite keeps as an advisory lock on the
 * file. The kernel grants that lock to one process at a time and drops it
 * when the owner exits, however it exits. So there is no initialisation
 * window (the lock exists the moment it is granted) and no stale-lock
 * recovery to get wrong: a dead owner's lock is simply free.
 *
 * Two rules follow from how these locks work:
 * - The lock file is never removed. Unlinking it would let one process lock
 *   the old inode while another creates and locks a new file of the same name.
 * - Nothing else in the process opens the lock file. Closing any other
 *   descriptor of a locked file releases POSIX locks; SQLite guards its own
 *   descriptors against that, and also refuses a second lock within one process.
 */

interface LockDatabase {
    exec(sql: string): unknown;
    close(): unknown;
}
type LockDatabaseConstructor = new (file: string, options: { timeout: number }) => LockDatabase;

let sqlite: LockDatabaseConstructor | undefined;
/** Loaded on first use, as the other optional SQLite users do, so importing the runtime never needs the native module. */
function loadSqlite(): LockDatabaseConstructor {
    return sqlite ??= createRequire(import.meta.url)('better-sqlite3') as LockDatabaseConstructor;
}

export interface SpriteLock {
    /** Gives the lock up. The lock file stays. */
    release(): void;
}

function isBusy(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

/**
 * Takes the lock when no live process (this one included) holds it. Returns
 * undefined when it is held; throws when the lock file cannot be used at all.
 */
export function tryAcquireSpriteLock(file: string): SpriteLock | undefined {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // No busy timeout: a held lock is reported at once and the pool decides when to look again.
    const database = new (loadSqlite())(file, { timeout: 0 });
    try {
        database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
        database.close();
        if (isBusy(error)) return undefined;
        throw error;
    }
    let held = true;
    return {
        release(): void {
            if (!held) return;
            held = false;
            // Closing ends the transaction and with it the lock, also when the rollback itself fails.
            try { database.exec('ROLLBACK'); } finally { database.close(); }
        },
    };
}
