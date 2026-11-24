import path from 'node:path';
import { MAX_RETURNED_CREDENTIAL_BYTES } from '../../credentials/broker.js';
import { isMissingSpriteFile, type SpriteFilesystemLike } from './spritesSdk.js';

/**
 * Reads files the launcher exported (refreshed credentials, the workspace
 * result) back to the worker.
 *
 * The launcher writes them into root-owned directories no agent process can
 * reach. The worker still treats each one as untrusted: it takes the entry's
 * own type (`lstat` semantics: the filesystem API reports a symlink as a
 * symlink and never resolves it for `stat`), accepts plain regular files only,
 * and refuses anything over its size limit, both before and after reading.
 */

export type SpriteExportRefusal = 'missing' | 'symlink' | 'not-regular' | 'oversize';

export type SpriteExportRead =
    | { ok: true; content: Buffer }
    | { ok: false; reason: SpriteExportRefusal };

/** `name` must be one plain path component: the reader never leaves `directory`. */
function assertPlainName(name: string): void {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error(`Invalid export file name: ${JSON.stringify(name)}`);
}

export async function readSpriteExportFile(
    filesystem: SpriteFilesystemLike, directory: string, name: string, maxBytes: number,
): Promise<SpriteExportRead> {
    assertPlainName(name);
    const file = path.posix.join(directory, name);
    let entry;
    try {
        entry = await filesystem.stat(file);
    } catch (error) {
        if (isMissingSpriteFile(error)) return { ok: false, reason: 'missing' };
        throw error;
    }
    if (entry.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (entry.isDirectory() || !entry.isFile()) return { ok: false, reason: 'not-regular' };
    if (typeof entry.size === 'number' && entry.size > maxBytes) return { ok: false, reason: 'oversize' };
    let content: Buffer;
    try {
        content = await filesystem.readFile(file, null);
    } catch (error) {
        if (isMissingSpriteFile(error)) return { ok: false, reason: 'missing' };
        throw error;
    }
    // The size reported before the read is not trusted either.
    if (content.length > maxBytes) return { ok: false, reason: 'oversize' };
    return { ok: true, content };
}

export interface SpriteCredentialExport {
    content: Buffer;
    mtimeMs: number;
}

/**
 * One refreshed credential from the launcher's export directory (`<index>`
 * with its modification time in `<index>.mtime`), or the reason it is not
 * taken. The time is clamped to now: a file dated in the future would
 * otherwise win every later write-back decision.
 */
export async function readSpriteCredentialExport(
    filesystem: SpriteFilesystemLike, directory: string, index: number, now = Date.now(),
): Promise<SpriteCredentialExport | SpriteExportRefusal> {
    const file = await readSpriteExportFile(filesystem, directory, String(index), MAX_RETURNED_CREDENTIAL_BYTES);
    if (!file.ok) return file.reason;
    const stamp = await readSpriteExportFile(filesystem, directory, `${index}.mtime`, 64);
    const seconds = stamp.ok ? stamp.content.toString('utf8').trim() : '';
    const mtimeMs = /^\d{1,12}$/.test(seconds) ? Math.min(Number(seconds) * 1000, now) : now;
    return { content: file.content, mtimeMs };
}
