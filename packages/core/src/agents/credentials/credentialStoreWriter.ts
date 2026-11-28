import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialBrokerError, lstatInside, MAX_RETURNED_CREDENTIAL_BYTES, readRegularFileInside } from './broker.js';
import { CredentialStoreLeaseRevokedError, withCredentialStoreLock, type CredentialStoreLockOptions } from './credentialStoreLock.js';
import { credentialRunRoot } from './hostCredentialStaging.js';
import { recordOperatorMutation } from './operatorMutations.js';

/**
 * Writes files into a canonical credential store outside a run: credentials
 * pasted in Settings, and the files an interactive login on a remote runtime
 * produced. It takes the same store lock as the broker's write-back, so it
 * never interleaves with a run returning a refreshed token, and replaces each
 * file atomically with mode 0600.
 *
 * Every write is an operator mutation: it is recorded (see
 * `operatorMutations.ts`) before anything is published, so a run staged
 * before it cannot later overwrite the change or recreate a removed file
 * with its own refreshed copy.
 */

export interface CredentialStoreWrite {
    /** POSIX path relative to the store root. */
    path: string;
    /** New content; `null` removes the file. */
    content: Buffer | null;
}

export interface CredentialStoreWriterOptions {
    lock?: CredentialStoreLockOptions;
    /**
     * Ends the write: checked while holding the store lock, immediately before
     * anything is published, so a writer cancelled while it waited for the lock
     * changes nothing.
     */
    signal?: AbortSignal;
}

/**
 * The files to write, or a function computing them. A function runs while
 * holding the store lock, so a read-modify-write (for example merging a pasted
 * credential into settings.json) sees every earlier writer's result.
 */
export type CredentialStoreWrites = readonly CredentialStoreWrite[] | (() => readonly CredentialStoreWrite[]);

const defaultLock = (): CredentialStoreLockOptions => ({ lockRoot: path.join(credentialRunRoot(), '.locks') });

/** The regular file `root/relative`, or undefined when it is missing, a symlink or not a file. */
export function readCredentialStoreFile(root: string, relative: string): Buffer | undefined {
    const read = readRegularFileInside(root, relative, MAX_RETURNED_CREDENTIAL_BYTES);
    if (read === 'oversized') throw new CredentialBrokerError(`Credential file is too large: ${relative}`);
    return read?.content;
}

function ownerOf(root: string, relative: string): { uid: number; gid: number } | undefined {
    const stat = lstatInside(root, relative);
    if (stat && stat !== 'symlink') return { uid: stat.uid, gid: stat.gid };
    try {
        const rootStat = fs.statSync(root);
        return { uid: rootStat.uid, gid: rootStat.gid };
    } catch { return undefined; }
}

function checkWrites(canonical: string, writes: readonly CredentialStoreWrite[]): void {
    for (const write of writes) {
        if (lstatInside(canonical, write.path) === 'symlink') {
            throw new CredentialBrokerError(`Refusing to write a credential through a symlink: ${write.path}`);
        }
        if (write.content && write.content.length > MAX_RETURNED_CREDENTIAL_BYTES) {
            throw new CredentialBrokerError(`Credential file is too large: ${write.path}`);
        }
    }
}

export async function writeCredentialStoreFiles(
    root: string, input: CredentialStoreWrites, options: CredentialStoreWriterOptions = {},
): Promise<void> {
    const canonical = path.resolve(root);
    options.signal?.throwIfAborted();
    if (typeof input !== 'function') checkWrites(canonical, input);
    await withCredentialStoreLock(canonical, options.lock ?? defaultLock(), lease => {
        const writes = typeof input === 'function' ? input() : input;
        checkWrites(canonical, writes);
        options.signal?.throwIfAborted();
        recordOperatorMutation(canonical, writes.map(write => write.path), lease);
        for (const write of writes) {
            const target = path.join(canonical, write.path);
            if (write.content === null) {
                if (lstatInside(canonical, write.path)) fs.rmSync(target, { force: true });
                continue;
            }
            const owner = ownerOf(canonical, write.path);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            const temporary = path.join(lease.publicationDir, `${randomBytes(6).toString('hex')}.tmp`);
            let fd: number;
            try { fd = fs.openSync(temporary, 'wx', 0o600); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CredentialStoreLeaseRevokedError(canonical, lease.epoch);
                throw error;
            }
            try {
                fs.writeSync(fd, write.content);
                if (process.getuid?.() === 0 && owner) fs.fchownSync(fd, owner.uid, owner.gid);
                fs.fchmodSync(fd, 0o600);
                fs.fsyncSync(fd);
            } catch (error) {
                fs.closeSync(fd);
                fs.rmSync(temporary, { force: true });
                throw error;
            }
            fs.closeSync(fd);
            try { fs.renameSync(temporary, target); }
            catch (error) {
                fs.rmSync(temporary, { force: true });
                throw error;
            }
        }
    });
}
