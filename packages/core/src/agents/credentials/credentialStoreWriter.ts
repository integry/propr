import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialBrokerError, lstatInside, MAX_RETURNED_CREDENTIAL_BYTES, readRegularFileInside } from './broker.js';
import { CredentialStoreLeaseRevokedError, withCredentialStoreLock, type CredentialStoreLockOptions } from './credentialStoreLock.js';
import { credentialRunRoot } from './hostCredentialStaging.js';

/**
 * Writes files into a canonical credential store outside a run: credentials
 * pasted in Settings, and the files an interactive login on a remote runtime
 * produced. It takes the same store lock as the broker's write-back, so it
 * never interleaves with a run returning a refreshed token, and replaces each
 * file atomically with mode 0600.
 */

export interface CredentialStoreWrite {
    /** POSIX path relative to the store root. */
    path: string;
    /** New content; `null` removes the file. */
    content: Buffer | null;
}

export interface CredentialStoreWriterOptions {
    lock?: CredentialStoreLockOptions;
}

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

export async function writeCredentialStoreFiles(
    root: string, writes: readonly CredentialStoreWrite[], options: CredentialStoreWriterOptions = {},
): Promise<void> {
    const canonical = path.resolve(root);
    for (const write of writes) {
        if (lstatInside(canonical, write.path) === 'symlink') {
            throw new CredentialBrokerError(`Refusing to write a credential through a symlink: ${write.path}`);
        }
        if (write.content && write.content.length > MAX_RETURNED_CREDENTIAL_BYTES) {
            throw new CredentialBrokerError(`Credential file is too large: ${write.path}`);
        }
    }
    await withCredentialStoreLock(canonical, options.lock ?? defaultLock(), lease => {
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
