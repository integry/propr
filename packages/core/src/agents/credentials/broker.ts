import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentType } from '../types.js';
import { withCredentialStoreLock, type CredentialStoreLockOptions } from './credentialStoreLock.js';
import {
    providerCredentialManifest, type CredentialStoreKind, type ProviderCredentialManifest,
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
    | 'kept-canonical';

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
}

export interface MaterializeOptions {
    /** Variables the run already defines (with a value): API-key runs skip token files, secret files never override. */
    definedEnv?: Iterable<string>;
}

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_SECRET_ENV_FILE_BYTES = 64 * 1024;
/** Token files are small; a returned file beyond this is not a credential and is ignored. */
export const MAX_RETURNED_CREDENTIAL_BYTES = 1024 * 1024;

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

function parseDotenv(content: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^export\s+/, '');
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        let value = line.slice(separator + 1).trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
        values.set(line.slice(0, separator).trim(), value);
    }
    return values;
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
        if (this.files.length + 1 > this.limits.maxFiles || this.bytes + stat.size > this.limits.maxBytes) {
            throw new CredentialBrokerError(
                `Credential store ${this.root} exceeds the per-run copy limit (${this.limits.maxFiles} files / ${this.limits.maxBytes} bytes); ` +
                'trim the directory or set PROPR_AGENT_CREDENTIAL_BROKER=legacy',
            );
        }
        const content = fs.readFileSync(path.join(this.root, relative));
        this.bytes += content.length;
        this.files.push({ path: relative, content, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, uid: stat.uid, gid: stat.gid, refresh });
    }

    skip(relative: string, reason: CredentialSkipReason): void {
        this.skipped.push({ path: relative, reason });
    }

    result(): Pick<CredentialStoreBundle, 'files' | 'directories' | 'skipped'> {
        return { files: this.files, directories: this.directories, skipped: this.skipped };
    }
}

function readCanonical(root: string, relative: string): { content: Buffer; stat: fs.Stats } | undefined {
    const stat = lstatInside(root, relative);
    if (!stat || stat === 'symlink' || !stat.isFile()) return undefined;
    return { content: fs.readFileSync(path.join(root, relative)), stat };
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

/** Atomically replace `root/relative`, keeping the canonical owner and the run's refresh time. */
function writeCanonical(root: string, relative: string, file: ReturnedCredentialFile, mode: number): void {
    const target = path.join(root, relative);
    const parent = path.dirname(target);
    if (lstatInside(root, relative) === 'symlink') {
        throw new CredentialBrokerError(`Refusing to write a refreshed credential through a symlink: ${target}`);
    }
    const owner = ownerFor(root, relative);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = path.join(parent, `.${path.basename(target)}.propr-${randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temporary, 'wx', mode);
    try {
        fs.writeSync(fd, file.content);
        fs.fsyncSync(fd);
        if (process.getuid?.() === 0 && owner) fs.fchownSync(fd, owner.uid, owner.gid);
    } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    fs.closeSync(fd);
    try {
        const seconds = file.mtimeMs / 1000;
        fs.utimesSync(temporary, seconds, seconds);
        fs.renameSync(temporary, target);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
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
        const reader = new StoreReader(root, { maxFiles: this.options.maxFiles ?? DEFAULT_MAX_FILES, maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES });
        for (const source of manifest.secretEnvFiles ?? []) {
            const canonical = readCanonical(root, source.path);
            if (!canonical || canonical.stat.size > MAX_SECRET_ENV_FILE_BYTES) continue;
            const values = parseDotenv(canonical.content.toString('utf8'));
            for (const name of source.variables) {
                const value = values.get(name);
                if (value && !definedEnv.has(name) && !(name in secretEnv)) secretEnv[name] = value;
            }
        }
        const apiKeyRun = (manifest.apiKeyEnv ?? []).some(name => definedEnv.has(name));
        const outputs: string[] = [];
        for (const entry of manifest.entries) {
            const refresh = entry.type === 'file' && entry.refresh === true;
            if (refresh && apiKeyRun) { reader.skip(entry.path, 'api-key-env'); continue; }
            reader.readEntry(entry.path, entry.type, refresh);
            if (refresh) outputs.push(entry.path);
        }
        const { files, directories, skipped } = reader.result();
        const baseline: Record<string, string | null> = {};
        for (const output of outputs) {
            const staged = files.find(candidate => candidate.path === output);
            baseline[output] = staged ? sha256(staged.content) : null;
        }
        return { id: request.id, provider: request.provider, store: request.store, canonicalRoot: root, files, directories, outputs, skipped, baseline };
    }

    /**
     * Write refreshed token files back to their canonical stores. Only
     * declared outputs are considered; a file the run deleted is never
     * propagated. Each store is updated under its lock: when the canonical
     * file still matches what the run received the refreshed copy is written,
     * otherwise the more recently modified copy wins.
     */
    async commit(bundle: CredentialBundle, returned: readonly ReturnedCredentialFile[]): Promise<CredentialWriteBackResult[]> {
        const results: CredentialWriteBackResult[] = [];
        for (const store of bundle.stores) {
            const candidates = returned.filter(file => file.storeId === store.id && store.outputs.includes(file.path)
                && file.content.length <= MAX_RETURNED_CREDENTIAL_BYTES);
            const changed = candidates.filter(file => sha256(file.content) !== store.baseline[file.path]);
            for (const file of candidates) if (!changed.includes(file)) results.push({ storeId: store.id, path: file.path, outcome: 'unchanged' });
            if (changed.length === 0) continue;
            await withCredentialStoreLock(store.canonicalRoot, this.options.lock, () => {
                for (const file of changed) results.push({ storeId: store.id, path: file.path, outcome: this.writeBack(store, file) });
            });
        }
        return results;
    }

    private writeBack(store: CredentialStoreBundle, file: ReturnedCredentialFile): CredentialWriteBackOutcome {
        const current = readCanonical(store.canonicalRoot, file.path);
        const currentHash = current ? sha256(current.content) : null;
        if (currentHash === sha256(file.content)) return 'unchanged';
        const received = store.files.find(candidate => candidate.path === file.path);
        const mode = current ? current.stat.mode & 0o777 : received?.mode ?? 0o600;
        if (currentHash === store.baseline[file.path]) {
            writeCanonical(store.canonicalRoot, file.path, file, mode);
            return 'written';
        }
        if (current && current.stat.mtimeMs >= file.mtimeMs) return 'kept-canonical';
        writeCanonical(store.canonicalRoot, file.path, file, mode);
        return 'written-newer';
    }
}
