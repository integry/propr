import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialStoreLeaseRevokedError, type CredentialStoreLease } from './credentialStoreLock.js';

/**
 * Operator mutations of a canonical credential store: a pasted credential set
 * or removed in Settings, or the files of an interactive login. Each one gives
 * the paths it writes a new token. A run records the state when its copy is
 * materialised; at write-back a path whose token has moved since then was
 * changed by the operator after the run was staged, so the run's refreshed
 * copy may no longer replace or recreate it on recency alone (see
 * `CredentialBroker`).
 *
 * Runs stage without the store lock (in other processes too), so the record
 * is published in two steps around the files, both under the lock:
 * {@link beginOperatorMutation} publishes the new tokens with the paths
 * marked pending, before any file is published, and
 * {@link endOperatorMutation} clears the mark once the writer publishes
 * nothing more. A run that read a path as pending may have copied the file
 * from before the mutation, so it never counts as staged after it (see
 * {@link operatorMutatedSince}); a run that read it cleared copied the
 * published file. A writer that dies in between leaves the mark, which keeps
 * fencing later runs of that path until its next operator mutation.
 *
 * The record lives in the canonical store, beside the lock's publication
 * directories, and is published like a credential, by renaming it out of the
 * lease's publication directory: a writer whose lock was taken over as stale
 * cannot roll it back.
 */

export const OPERATOR_MUTATIONS_FILE = '.propr-operator-mutations.json';
const MAX_RECORD_BYTES = 256 * 1024;

export interface OperatorMutationRecord {
    /** Changes when an unreadable record is replaced, so tokens issued before it never match again. */
    id: string;
    /** Token of each path's latest operator mutation. */
    paths: Record<string, string>;
    /** Paths whose latest mutation may not be fully published yet (see {@link beginOperatorMutation}). */
    pending: readonly string[];
}

/** The record, or `'unreadable'` (treated as every path having changed). */
export type OperatorMutationState = OperatorMutationRecord | 'unreadable';

const EMPTY: OperatorMutationRecord = Object.freeze({ id: '', paths: Object.freeze({}) as Record<string, string>, pending: Object.freeze([]) });

function parse(text: string): OperatorMutationRecord | undefined {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return undefined; }
    if (typeof value !== 'object' || value === null) return undefined;
    const { id, paths, pending = [] } = value as Record<string, unknown>;
    if (typeof id !== 'string' || typeof paths !== 'object' || paths === null || Array.isArray(paths)) return undefined;
    if (!Object.values(paths).every(token => typeof token === 'string')) return undefined;
    if (!Array.isArray(pending) || !pending.every(entry => typeof entry === 'string')) return undefined;
    return { id, paths: { ...(paths as Record<string, string>) }, pending: [...pending] };
}

/** The store's record; an empty one before the first operator mutation. */
export function readOperatorMutations(canonicalRoot: string): OperatorMutationState {
    const file = path.join(canonicalRoot, OPERATOR_MUTATIONS_FILE);
    let fd: number;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? EMPTY : 'unreadable';
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return 'unreadable';
        const content = Buffer.alloc(stat.size);
        const read = fs.readSync(fd, content, 0, content.length, 0);
        return parse(content.subarray(0, read).toString('utf8')) ?? 'unreadable';
    } catch {
        return 'unreadable';
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Whether an operator mutation of `relative` happened between `staged` and
 * `current`. A path staged while pending counts as mutated afterwards: its
 * staged file may predate the mutation even though the token matches.
 */
export function operatorMutatedSince(staged: OperatorMutationState, current: OperatorMutationState, relative: string): boolean {
    if (staged === 'unreadable' || current === 'unreadable') return true;
    if (staged.pending.includes(relative)) return true;
    return staged.id !== current.id || staged.paths[relative] !== current.paths[relative];
}

function publishRecord(canonicalRoot: string, next: OperatorMutationRecord, lease: CredentialStoreLease): void {
    const temporary = path.join(lease.publicationDir, `${randomBytes(6).toString('hex')}.mutations.tmp`);
    let fd: number;
    try { fd = fs.openSync(temporary, 'wx', 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CredentialStoreLeaseRevokedError(canonicalRoot, lease.epoch);
        throw error;
    }
    try {
        fs.writeSync(fd, `${JSON.stringify(next)}\n`);
        // Owned like the store, as the credentials beside it are.
        if (process.getuid?.() === 0) {
            const owner = fs.statSync(canonicalRoot);
            fs.fchownSync(fd, owner.uid, owner.gid);
        }
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
    } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    fs.closeSync(fd);
    try { fs.renameSync(temporary, path.join(canonicalRoot, OPERATOR_MUTATIONS_FILE)); }
    catch (error) {
        fs.rmSync(temporary, { force: true });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(lease.publicationDir)) {
            throw new CredentialStoreLeaseRevokedError(canonicalRoot, lease.epoch);
        }
        throw error;
    }
}

/**
 * Give `paths` new tokens and mark them pending. Called holding the store
 * lock, before any file of the mutation is published; pair it with
 * {@link endOperatorMutation} once the writer publishes nothing more.
 * Marks left by an earlier writer that never ended are kept.
 */
export function beginOperatorMutation(canonicalRoot: string, paths: readonly string[], lease: CredentialStoreLease): void {
    if (paths.length === 0) return;
    const current = readOperatorMutations(canonicalRoot);
    const id = current === 'unreadable' ? randomBytes(8).toString('hex') : current.id;
    const tokens: Record<string, string> = current === 'unreadable' ? {} : { ...current.paths };
    const pending = current === 'unreadable' ? [] : [...current.pending];
    for (const relative of paths) {
        tokens[relative] = randomBytes(8).toString('hex');
        if (!pending.includes(relative)) pending.push(relative);
    }
    publishRecord(canonicalRoot, { id, paths: tokens, pending }, lease);
}

/**
 * Clear the pending mark of `paths`, keeping their tokens. Called holding the
 * same lease as {@link beginOperatorMutation}, after the writer published (or
 * failed to publish) its files: from then on the files are the ones a run
 * staged under the cleared record copies.
 */
export function endOperatorMutation(canonicalRoot: string, paths: readonly string[], lease: CredentialStoreLease): void {
    if (paths.length === 0) return;
    const current = readOperatorMutations(canonicalRoot);
    // An unreadable record already fences every path; the next mutation replaces it.
    if (current === 'unreadable') return;
    const pending = current.pending.filter(relative => !paths.includes(relative));
    if (pending.length === current.pending.length) return;
    publishRecord(canonicalRoot, { ...current, pending }, lease);
}
