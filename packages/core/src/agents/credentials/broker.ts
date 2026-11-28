import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentType } from '../types.js';
import {
    CredentialStoreLeaseRevokedError, withCredentialStoreLock, type CredentialStoreLease, type CredentialStoreLockOptions,
} from './credentialStoreLock.js';
import { parseDotenv } from './dotenv.js';
import { operatorMutatedSince, readOperatorMutations, type OperatorMutationState } from './operatorMutations.js';
import {
    isLoginCredentialEntry, providerCredentialManifest, type CredentialStoreKind, type ProviderCredentialManifest,
} from './providerManifests.js';

/**
 * Credential broker: materialises a per-run copy of a provider's credential
 * store and writes refreshed tokens back afterwards.
 *
 * The API is transport-neutral. {@link CredentialBroker.materialize} returns
 * the files a run receives (`files`) and the paths it must hand back
 * (`outputs`); {@link CredentialBroker.commit} takes those returned files.
 * The Docker runtime stages the files in a per-run host directory it
 * bind-mounts; a remote runtime can upload them and download the outputs.
 */

export interface CredentialStoreRequest {
    /** Unique within one run; names the store's staging directory. */
    id: string;
    provider: AgentType;
    store: CredentialStoreKind;
    /** Canonical host directory the files are read from and refreshed tokens written to. */
    canonicalRoot: string;
}

export interface CredentialFile {
    /** POSIX path relative to the store root. */
    path: string;
    content: Buffer;
    mode: number;
    mtimeMs: number;
    /** Owner of the canonical file, so a privileged stager can preserve it like `cp -p`. */
    uid: number;
    gid: number;
    refresh: boolean;
}

export type CredentialSkipReason = 'symlink' | 'not-regular' | 'api-key-env';

export interface CredentialStoreBundle {
    id: string;
    provider: AgentType;
    store: CredentialStoreKind;
    canonicalRoot: string;
    files: CredentialFile[];
    /** Directories (relative) to create even when empty, parents first. */
    directories: string[];
    /** Refreshable paths the runtime returns after the run (present or not). */
    outputs: string[];
    skipped: Array<{ path: string; reason: CredentialSkipReason }>;
    /** sha256 of each output at materialisation; `null` when it did not exist. */
    baseline: Record<string, string | null>;
    /** The store's operator mutations, read before its files (see `operatorMutations.ts`). */
    operatorMutations: OperatorMutationState;
}

export interface CredentialBundle {
    stores: CredentialStoreBundle[];
    /** Secrets the run receives as environment variables instead of files (e.g. an API key from `.env`). */
    secretEnv: Record<string, string>;
}

export interface ReturnedCredentialFile {
    storeId: string;
    path: string;
    content: Buffer;
    mtimeMs: number;
}

export type CredentialWriteBackOutcome =
    /** Identical to what the run received. */
    | 'unchanged'
    /** The run refreshed it and the canonical copy had not moved: written back. */
    | 'written'
    /** Another writer changed the canonical copy, but the run's copy is newer: written back. */
    | 'written-newer'
    /** Another writer changed the canonical copy more recently: kept. */
    | 'kept-canonical'
    /** The operator replaced or removed the credential after the run was staged: kept. */
    | 'kept-operator-change';

export interface CredentialWriteBackResult {
    storeId: string;
    path: string;
    outcome: CredentialWriteBackOutcome;
}

export class CredentialBrokerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CredentialBrokerError';
    }
}

export interface CredentialBrokerOptions {
    lock: CredentialStoreLockOptions;
    /** Bounds a store copy so a misconfigured directory cannot be duplicated per run. */
    maxFiles?: number;
    maxBytes?: number;
    /** Test hook: runs after a replacement is prepared, immediately before it is published. */
    onBeforePublish?: (relative: string) => void;
}

export interface MaterializeOptions {
    /** Variables the run already defines (with a value): API-key runs skip token files, secret files never override. */
    definedEnv?: Iterable<string>;
}

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_SECRET_ENV_FILE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/** Token files are small; a returned file beyond this is not a credential and is ignored. */
export const MAX_RETURNED_CREDENTIAL_BYTES = 1024 * 1024;

/** Write-back attempts per store; a revoked attempt re-acquires the lock and re-decides from the then-current canonical file. */
const MAX_WRITE_BACK_ATTEMPTS = 3;

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function assertRelative(relative: string): void {
    if (!relative || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new CredentialBrokerError(`Invalid credential path: ${relative}`);
    }
}

/**
 * `lstat` of `root/relative` refusing symlinked components below the root,
 * so a link planted in the store cannot redirect a read or a write-back.
 */
export function lstatInside(root: string, relative: string): fs.Stats | 'symlink' | undefined {
    assertRelative(relative);
    let current = root;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(current); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
            throw error;
        }
        if (stat.isSymbolicLink()) return 'symlink';
        if (index < parts.length - 1 && !stat.isDirectory()) return undefined;
        if (index === parts.length - 1) return stat;
    }
    return undefined;
}

export interface BoundedFileRead {
    content: Buffer;
    /** `fstat` of the descriptor that was read. */
    stat: fs.Stats;
}

/**
 * Read the regular file `root/relative` without allocating more than
 * `maxBytes` (plus one read chunk): the size is checked before reading and
 * the read stops past the limit, so a file that grows meanwhile is still
 * refused. Returns `undefined` when the path is missing, a symlink (in any
 * component) or not a regular file, and `'oversized'` past the limit.
 */
export function readRegularFileInside(root: string, relative: string, maxBytes: number): BoundedFileRead | 'oversized' | undefined {
    const linkStat = lstatInside(root, relative);
    if (!linkStat || linkStat === 'symlink' || !linkStat.isFile()) return undefined;
    if (linkStat.size > maxBytes) return 'oversized';
    let fd: number;
    try {
        // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open.
        fd = fs.openSync(path.join(root, relative), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return undefined;
        throw error;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return undefined;
        if (stat.size > maxBytes) return 'oversized';
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
            const read = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (read === 0) break;
            total += read;
            if (total > maxBytes) return 'oversized';
            chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
        }
        return { content: Buffer.concat(chunks, total), stat };
    } finally {
        fs.closeSync(fd);
    }
}

class StoreReader {
    private readonly files: CredentialFile[] = [];
    private readonly directories: string[] = [];
    private readonly skipped: CredentialStoreBundle['skipped'] = [];
    private bytes = 0;

    constructor(private readonly root: string, private readonly limits: { maxFiles: number; maxBytes: number }) {}

    readEntry(relative: string, type: 'file' | 'directory', refresh: boolean): void {
        const stat = lstatInside(this.root, relative);
        if (!stat) return;
        if (stat === 'symlink') { this.skipped.push({ path: relative, reason: 'symlink' }); return; }
        if (type === 'file') {
            if (!stat.isFile()) { this.skipped.push({ path: relative, reason: 'not-regular' }); return; }
            this.addFile(relative, stat, refresh);
            return;
        }
        if (!stat.isDirectory()) { this.skipped.push({ path: relative, reason: 'not-regular' }); return; }
        this.walk(relative);
    }

    private walk(relative: string): void {
        this.directories.push(relative);
        for (const name of fs.readdirSync(path.join(this.root, relative)).sort()) {
            const child = `${relative}/${name}`;
            const stat = fs.lstatSync(path.join(this.root, child));
            if (stat.isSymbolicLink()) this.skipped.push({ path: child, reason: 'symlink' });
            else if (stat.isDirectory()) this.walk(child);
            else if (stat.isFile()) this.addFile(child, stat, false);
            else this.skipped.push({ path: child, reason: 'not-regular' });
        }
    }

    private addFile(relative: string, stat: fs.Stats, refresh: boolean): void {
        if (this.files.length + 1 > this.limits.maxFiles || this.bytes + stat.size > this.limits.maxBytes) this.overLimit();
        // Bounded by the remaining budget, so a file growing after the lstat cannot be read whole.
        const read = readRegularFileInside(this.root, relative, this.limits.maxBytes - this.bytes);
        if (read === 'oversized') this.overLimit();
        if (!read) return;
        const { content, stat: readStat } = read;
        this.bytes += content.length;
        this.files.push({ path: relative, content, mode: readStat.mode & 0o777, mtimeMs: readStat.mtimeMs, uid: readStat.uid, gid: readStat.gid, refresh });
    }

    private overLimit(): never {
        throw new CredentialBrokerError(
            `Credential store ${this.root} exceeds the per-run copy limit (${this.limits.maxFiles} files / ${this.limits.maxBytes} bytes); ` +
            'trim the directory or set PROPR_AGENT_CREDENTIAL_BROKER=legacy',
        );
    }

    skip(relative: string, reason: CredentialSkipReason): void {
        this.skipped.push({ path: relative, reason });
    }

    result(): Pick<CredentialStoreBundle, 'files' | 'directories' | 'skipped'> {
        return { files: this.files, directories: this.directories, skipped: this.skipped };
    }
}


function ownerFor(root: string, relative: string): { uid: number; gid: number } | undefined {
    let current = path.join(root, relative);
    while (current.startsWith(root)) {
        try { const stat = fs.statSync(current); return { uid: stat.uid, gid: stat.gid }; } catch { /* missing: try the parent */ }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return undefined;
}

const isMissingPath = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/**
 * Atomically replace `root/relative`, keeping the canonical owner and mode and
 * the run's refresh time. The replacement is prepared in the lease's
 * publication directory and renamed out of it, so once a stale takeover has
 * revoked the lease the rename fails rather than overwriting a newer token.
 */
function writeCanonical(
    root: string, file: ReturnedCredentialFile, mode: number, publication: { lease: CredentialStoreLease; onBeforePublish?: (relative: string) => void },
): void {
    const relative = file.path;
    const { lease, onBeforePublish } = publication;
    const target = path.join(root, relative);
    const parent = path.dirname(target);
    if (lstatInside(root, relative) === 'symlink') {
        throw new CredentialBrokerError(`Refusing to write a refreshed credential through a symlink: ${target}`);
    }
    const owner = ownerFor(root, relative);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = path.join(lease.publicationDir, `${randomBytes(6).toString('hex')}.tmp`);
    let fd: number;
    try { fd = fs.openSync(temporary, 'wx', mode); } catch (error) {
        if (isMissingPath(error)) throw new CredentialStoreLeaseRevokedError(root, lease.epoch);
        throw error;
    }
    try {
        fs.writeSync(fd, file.content);
        if (process.getuid?.() === 0 && owner) fs.fchownSync(fd, owner.uid, owner.gid);
        // open() applied the worker's umask; the rename must carry the canonical mode exactly.
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
    } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    fs.closeSync(fd);
    try {
        const seconds = file.mtimeMs / 1000;
        fs.utimesSync(temporary, seconds, seconds);
        onBeforePublish?.(relative);
        fs.renameSync(temporary, target);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        // The prepared file moved away with the revoked publication directory.
        if (isMissingPath(error) && !fs.existsSync(lease.publicationDir)) throw new CredentialStoreLeaseRevokedError(root, lease.epoch);
        throw error;
    }
}

export class CredentialBroker {
    constructor(private readonly options: CredentialBrokerOptions) {}

    materialize(requests: readonly CredentialStoreRequest[], options: MaterializeOptions = {}): CredentialBundle {
        const definedEnv = new Set(options.definedEnv ?? []);
        const ids = new Set<string>();
        const secretEnv: Record<string, string> = {};
        const stores = requests.map(request => {
            if (ids.has(request.id) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.id)) throw new CredentialBrokerError(`Invalid or duplicate credential store id: ${request.id}`);
            ids.add(request.id);
            const manifest = providerCredentialManifest(request.provider, request.store);
            if (!manifest) throw new CredentialBrokerError(`No credential manifest for ${request.provider} ${request.store} store`);
            return this.materializeStore(request, manifest, definedEnv, secretEnv);
        });
        return { stores, secretEnv };
    }

    private materializeStore(
        request: CredentialStoreRequest, manifest: ProviderCredentialManifest, definedEnv: Set<string>, secretEnv: Record<string, string>,
    ): CredentialStoreBundle {
        const root = path.resolve(request.canonicalRoot);
        // Read before the files: a mutation landing in between then counts as
        // after staging, which only withholds the recency rule (below).
        const operatorMutations = readOperatorMutations(root);
        const reader = new StoreReader(root, { maxFiles: this.options.maxFiles ?? DEFAULT_MAX_FILES, maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES });
        for (const source of manifest.secretEnvFiles ?? []) {
            const canonical = readRegularFileInside(root, source.path, MAX_SECRET_ENV_FILE_BYTES);
            if (!canonical || canonical === 'oversized') continue;
            const values = parseDotenv(canonical.content.toString('utf8'));
            for (const name of source.variables) {
                const value = values.get(name);
                if (value && !definedEnv.has(name) && !(name in secretEnv)) secretEnv[name] = value;
            }
        }
        // A key the run defines itself or one the broker extracted above (a
        // nonempty value in the store's secret file) both make this an API-key
        // run, so the stored login is withheld either way.
        const apiKeyRun = (manifest.apiKeyEnv ?? []).some(name => definedEnv.has(name) || Boolean(secretEnv[name]));
        const outputs: string[] = [];
        for (const entry of manifest.entries) {
            const refresh = entry.type === 'file' && entry.refresh === true;
            if (apiKeyRun && isLoginCredentialEntry(entry)) { reader.skip(entry.path, 'api-key-env'); continue; }
            reader.readEntry(entry.path, entry.type, refresh);
            if (refresh) outputs.push(entry.path);
        }
        const { files, directories, skipped } = reader.result();
        const baseline: Record<string, string | null> = {};
        for (const output of outputs) {
            const staged = files.find(candidate => candidate.path === output);
            baseline[output] = staged ? sha256(staged.content) : null;
        }
        return { id: request.id, provider: request.provider, store: request.store, canonicalRoot: root, files, directories, outputs, skipped, baseline, operatorMutations };
    }

    /**
     * Write refreshed token files back to their canonical stores. Only
     * declared outputs are considered; a file the run deleted is never
     * propagated. Each store is updated under its lock: when the canonical
     * file still matches what the run received the refreshed copy is written,
     * otherwise the more recently modified copy wins, unless the operator
     * replaced or removed the file after the run was staged: that change is
     * kept, and a removed file is not recreated. A write-back whose lock
     * was taken over as stale before it published re-acquires the lock and
     * decides again against the then-current canonical file.
     */
    async commit(bundle: CredentialBundle, returned: readonly ReturnedCredentialFile[]): Promise<CredentialWriteBackResult[]> {
        const results: CredentialWriteBackResult[] = [];
        for (const store of bundle.stores) {
            const candidates = returned.filter(file => file.storeId === store.id && store.outputs.includes(file.path)
                && file.content.length <= MAX_RETURNED_CREDENTIAL_BYTES);
            const changed = candidates.filter(file => sha256(file.content) !== store.baseline[file.path]);
            for (const file of candidates) if (!changed.includes(file)) results.push({ storeId: store.id, path: file.path, outcome: 'unchanged' });
            let pending = changed;
            for (let attempt = 1; pending.length > 0; attempt++) {
                try {
                    await withCredentialStoreLock(store.canonicalRoot, this.options.lock, lease => {
                        while (pending.length > 0) {
                            results.push({ storeId: store.id, path: pending[0].path, outcome: this.writeBack(store, pending[0], lease) });
                            pending = pending.slice(1);
                        }
                    });
                } catch (error) {
                    if (!(error instanceof CredentialStoreLeaseRevokedError) || attempt >= MAX_WRITE_BACK_ATTEMPTS) throw error;
                }
            }
        }
        return results;
    }

    private writeBack(store: CredentialStoreBundle, file: ReturnedCredentialFile, lease: CredentialStoreLease): CredentialWriteBackOutcome {
        // Bounded like the store copy: the canonical file may have grown since the run started.
        const current = readRegularFileInside(store.canonicalRoot, file.path, this.options.maxBytes ?? DEFAULT_MAX_BYTES);
        if (current === 'oversized') {
            throw new CredentialBrokerError(`Canonical credential ${path.join(store.canonicalRoot, file.path)} exceeds the per-run copy limit; not writing back over it`);
        }
        const currentHash = current ? sha256(current.content) : null;
        if (currentHash === sha256(file.content)) return 'unchanged';
        const received = store.files.find(candidate => candidate.path === file.path);
        const mode = current ? current.stat.mode & 0o777 : received?.mode ?? 0o600;
        if (currentHash === store.baseline[file.path]) {
            writeCanonical(store.canonicalRoot, file, mode, { lease, onBeforePublish: this.options.onBeforePublish });
            return 'written';
        }
        // An operator change after staging is never overridden on recency: the
        // run's token belongs to the replaced or removed login.
        if (operatorMutatedSince(store.operatorMutations, readOperatorMutations(store.canonicalRoot), file.path)) return 'kept-operator-change';
        if (current && current.stat.mtimeMs >= file.mtimeMs) return 'kept-canonical';
        writeCanonical(store.canonicalRoot, file, mode, { lease, onBeforePublish: this.options.onBeforePublish });
        return 'written-newer';
    }
}
