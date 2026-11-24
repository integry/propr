import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../utils/logger.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from '../credentials/broker.js';
import {
    canWriteBack, credentialRunRoot, definedVariables, STAGING_RETAINED_FILE, type CredentialBindMount,
} from '../credentials/hostCredentialStaging.js';
import type { AgentRunFile, AgentRunFileRead, AgentRunHandle, AgentRunMount, AgentRunSpec } from './types.js';

/**
 * Upload transport for runtimes without bind mounts (Fly Machines and other
 * remote sandboxes): the bind sources a run declares are delivered as files
 * written into the run before it starts, and the credential broker's
 * refreshable outputs are read back through the runtime file API afterwards.
 *
 * - A credential store bind gets the broker's per-run copy (only the
 *   provider manifest's files); refreshed tokens are read back through the
 *   runtime's confined credential reader (no symlinks on the path) and
 *   written to the canonical store when the run finished, ordered by their
 *   modification time in the run. A writable store the worker cannot write
 *   back to refuses the run before launch. A refresh that cannot be written back is saved to a
 *   retained recovery directory beside the host staging copies; one that
 *   cannot be read (or saved) keeps the run itself, which is then never
 *   released automatically. A store a run needs to keep provider session
 *   state in between launches (`perRun: false`, e.g. a goal session resumed
 *   by id) refuses the run before launch: the copy carries credential files
 *   only, and nothing else the run writes there comes back.
 * - Any other bind is copied in (bounded, regular files only, symlinks
 *   skipped); writes to it stay in the sandbox. Log directories are created
 *   empty. A writable copy is never written back.
 * - Every entry uploaded for a read-only bind (credential store or not) is
 *   marked `readOnly`: the runtime enforces that in the run or refuses it.
 * - Before refreshed credentials are read back, the run is retained (and that
 *   awaited), so a runtime that removes finished runs on its own cannot do so
 *   while the only copy of a refreshed credential is being read.
 * - Workspace and git binds are left alone: the clone workspace transport
 *   removes them, and a run still carrying one is refused by the capability check.
 */

/** A copied (non-credential) bind source larger than this refuses the run instead of silently truncating it. */
export const MAX_UPLOADED_BIND_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOADED_BIND_FILES = 2_000;

type BindMount = Extract<AgentRunMount, { type: 'bind' }>;
type Environment = Record<string, string | undefined>;

export class AgentRunFileUploadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentRunFileUploadError';
    }
}

export interface UploadedAgentRunFiles {
    /** The spec with each uploadable bind replaced by `files` entries. */
    spec: AgentRunSpec;
    /** Secret variables for the launch environment; the spec names them without values. */
    secretEnv: Record<string, string>;
    bundle: CredentialBundle;
    /** Read refreshed credentials back through the handle and write them to their canonical stores. Never throws. */
    collect(handle: AgentRunHandle): Promise<CredentialCollection>;
}

export interface CredentialCollection {
    results: CredentialWriteBackResult[];
    /** Refreshed credentials that were not written back were saved here (retained; never swept). */
    recoveryDir?: string;
    /**
     * The run may hold the only copy of a refreshed credential (it could not
     * be read back, or not saved after a failed write-back): it must be kept.
     */
    keepRun: boolean;
    /**
     * The run was confirmed kept before its refreshed credentials were read
     * (or there was nothing to read). False when the runtime could not
     * establish retention: the run may have been removed meanwhile.
     */
    retained: boolean;
}

interface UploadOptions {
    environment?: Environment;
    launchEnvironment?: Environment;
    broker?: CredentialBroker;
}

interface StoreTarget { mount: CredentialBindMount; storeId: string; writeBack: boolean }

function uploadable(mount: AgentRunMount): mount is BindMount {
    return mount.type === 'bind' && mount.purpose !== 'workspace' && mount.purpose !== 'git';
}

function isCredentialStore(mount: BindMount): mount is CredentialBindMount {
    return !!mount.credentialStore;
}

/** Bounded copy of a bind source: a file, or a directory tree of regular files. */
function copyBindSource(mount: BindMount): AgentRunFile[] {
    const files: AgentRunFile[] = [];
    const restriction = mount.readOnly ? { readOnly: true } : {};
    let bytes = 0;
    const add = (source: string, target: string, stat: fs.Stats): void => {
        if (files.length >= MAX_UPLOADED_BIND_FILES || bytes + stat.size > MAX_UPLOADED_BIND_BYTES) {
            throw new AgentRunFileUploadError(`Bind source ${mount.source} exceeds the upload limit (${MAX_UPLOADED_BIND_FILES} files, ${MAX_UPLOADED_BIND_BYTES} bytes)`);
        }
        bytes += stat.size;
        files.push({ type: 'file', path: target, content: fs.readFileSync(source), mode: stat.mode & 0o777, purpose: mount.purpose, ...restriction });
    };
    const walk = (source: string, target: string): void => {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) { add(source, target, stat); return; }
        if (!stat.isDirectory()) return;
        files.push({ type: 'directory', path: target, mode: stat.mode & 0o777, purpose: mount.purpose, ...restriction });
        for (const entry of fs.readdirSync(source).sort()) walk(path.join(source, entry), path.posix.join(target, entry));
    };
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(mount.source);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // `--mount` refuses a missing source; `-v` creates an empty directory.
        if (mount.syntax === 'mount') throw new AgentRunFileUploadError(`Bind source ${mount.source} for ${mount.target} does not exist`);
        return [{ type: 'directory', path: mount.target, mode: 0o755, purpose: mount.purpose, ...restriction }];
    }
    if (stat.isSymbolicLink()) {
        // Docker follows a symlinked source; resolve it once, then copy without following links below it.
        return copyBindSource({ ...mount, source: fs.realpathSync(mount.source) });
    }
    // Logs a run writes are not read back from the sandbox; give it the directory only.
    if (mount.purpose === 'logs' && stat.isDirectory()) return [{ type: 'directory', path: mount.target, mode: 0o777, purpose: 'logs', ...restriction }];
    walk(mount.source, mount.target);
    return files;
}

/**
 * A refreshable output read back from the run, bounded before its content is
 * transferred, through the runtime's credential reader only: it refuses a
 * symlink anywhere on the path, which the run could otherwise plant to have
 * the runtime's privileged reader return a file outside the store. A handle
 * without that reader cannot return credentials safely, so the output counts
 * as unread (the run is kept).
 */
async function readReturnedCredential(handle: AgentRunHandle, root: string, relative: string): Promise<AgentRunFileRead | 'oversized' | null> {
    if (!handle.readCredentialFile) throw new Error('The runtime offers no confined credential reader');
    return handle.readCredentialFile(root, relative, { maxBytes: MAX_RETURNED_CREDENTIAL_BYTES });
}

function changedOutputs(bundle: CredentialBundle, returned: readonly ReturnedCredentialFile[]): ReturnedCredentialFile[] {
    return returned.filter(file => {
        const store = bundle.stores.find(candidate => candidate.id === file.storeId);
        return !!store && createHash('sha256').update(file.content).digest('hex') !== store.baseline[file.path];
    });
}

/**
 * Durably save refreshed credentials that were not written back, in a
 * root-only directory marked retained (the staging sweep never removes it),
 * laid out like a retained host staging copy. Returns the directory, or
 * undefined when it could not be saved completely.
 */
function saveRecoveryCopy(root: string, run: { name: string; bundle: CredentialBundle }, files: ReturnedCredentialFile[], error: string): string | undefined {
    const { name: runName, bundle } = run;
    const safeName = runName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-80);
    const directory = path.join(root, `${safeName}-recovered-${randomBytes(6).toString('hex')}`);
    const writeDurably = (target: string, content: Buffer): void => {
        const fd = fs.openSync(target, 'wx', 0o600);
        try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fs.mkdirSync(directory, { mode: 0o700 });
        const saved = files.map(file => {
            const store = bundle.stores.find(candidate => candidate.id === file.storeId)!;
            const target = path.join(directory, store.id, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            writeDurably(target, file.content);
            const seconds = file.mtimeMs / 1000;
            if (seconds > 0) fs.utimesSync(target, seconds, seconds);
            return { staged: target, canonical: path.join(store.canonicalRoot, file.path) };
        });
        writeDurably(path.join(directory, STAGING_RETAINED_FILE), Buffer.from(`${JSON.stringify({ retainedAt: new Date().toISOString(), error, files: saved }, null, 2)}\n`));
        logger.error(
            { run: runName, recoveryDir: directory, error, files: saved },
            'Credential broker could not write back refreshed credentials from the run; saved them for recovery. Restore each saved file that is newer than its canonical file, then delete the directory',
        );
        return directory;
    } catch (saveError) {
        logger.error({ run: runName, recoveryDir: directory, error, saveError: (saveError as Error).message }, 'Could not save refreshed credentials that were not written back');
        return undefined;
    }
}

function storeFiles(bundle: CredentialBundle, targets: StoreTarget[]): AgentRunFile[] {
    const files: AgentRunFile[] = [];
    for (const target of targets) {
        const store = bundle.stores.find(candidate => candidate.id === target.storeId)!;
        const root = target.mount.target;
        const entry = { purpose: target.mount.purpose, ...(target.mount.readOnly ? { readOnly: true } : {}) };
        files.push({ type: 'directory', path: root, mode: 0o700, ...entry });
        for (const directory of store.directories) files.push({ type: 'directory', path: path.posix.join(root, directory), mode: 0o700, ...entry });
        for (const file of store.files) {
            files.push({ type: 'file', path: path.posix.join(root, file.path), content: file.content, mode: file.mode & 0o777, ...entry });
        }
    }
    return files;
}

/**
 * Replace every uploadable bind in `spec` with files written into the run.
 * Throws before anything is launched when a copied source exceeds the limit
 * or a strict (`--mount`) source is missing.
 */
export function uploadAgentRunFiles(spec: AgentRunSpec, options: UploadOptions = {}): UploadedAgentRunFiles {
    const environment = options.environment ?? process.env;
    const binds = spec.mounts.filter(uploadable).sort((left, right) => left.order - right.order);
    const credentialMounts = binds.filter(isCredentialStore);
    const targets: StoreTarget[] = credentialMounts.map(mount => ({
        mount, storeId: `${mount.credentialStore.provider}-${mount.credentialStore.store}`,
        // A writable store the worker cannot write back to is refused below.
        writeBack: !mount.readOnly && canWriteBack(mount),
    }));
    // A run relying on provider state that persists in the store between launches (session history a
    // resumed session reads, and later launches resume) needs the canonical store mounted: a per-run copy
    // holds only the manifest's credential files, and only refreshed credentials are written back.
    const sessionStores = targets.filter(target => !target.mount.credentialStore.perRun);
    if (sessionStores.length > 0) {
        const stores = sessionStores.map(target => `${target.mount.credentialStore.provider} ${target.mount.credentialStore.store}`).join(', ');
        logger.error({ run: spec.name, stores: sessionStores.map(target => target.storeId) }, 'Run keeps provider session state in its credential store, which this runtime cannot mount; refusing the run');
        throw new AgentRunFileUploadError(
            `${spec.name} keeps provider session state in the ${stores} credential ${sessionStores.length === 1 ? 'store' : 'stores'} between launches (a resumable session), `
            + 'but this runtime cannot mount credential stores: it uploads per-run copies of the credential files only, without session state. '
            + 'Run resumable sessions on a runtime with bind mounts (docker)',
        );
    }
    // Without bind mounts there is no direct mount to fall back to: a refresh the
    // worker cannot write back would be destroyed with the run, so refuse it.
    const unwritable = targets.filter(target => !target.mount.readOnly && !target.writeBack);
    if (unwritable.length > 0) {
        const stores = unwritable.map(target => ({ provider: target.mount.credentialStore.provider, store: target.mount.credentialStore.store, source: target.mount.source }));
        logger.error({ run: spec.name, stores }, 'Credential store is not writable from the worker; refusing the run because the runtime cannot mount it directly');
        throw new AgentRunFileUploadError(
            `The worker cannot write refreshed tokens back to the ${stores.map(store => `${store.provider} ${store.store}`).join(', ')} credential `
            + `${stores.length === 1 ? 'store' : 'stores'} for ${spec.name}, and this runtime cannot mount ${stores.length === 1 ? 'it' : 'them'} directly. `
            + `Make ${stores.map(store => store.source).join(', ')} writable from the worker`,
        );
    }
    const broker = options.broker ?? new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(environment), '.locks') } });
    const requests: CredentialStoreRequest[] = targets.map(target => ({
        id: target.storeId, provider: target.mount.credentialStore.provider, store: target.mount.credentialStore.store, canonicalRoot: target.mount.source,
    }));
    const bundle: CredentialBundle = requests.length > 0
        ? broker.materialize(requests, { definedEnv: definedVariables(spec, { ...process.env, ...options.launchEnvironment }) })
        : { stores: [], secretEnv: {} };
    const uploaded: Array<{ order: number; files: AgentRunFile[] }> = [
        { order: -1, files: storeFiles(bundle, targets) },
        ...binds.filter(mount => !isCredentialStore(mount)).map(mount => ({ order: mount.order, files: copyBindSource(mount) })),
    ];
    for (const store of bundle.stores) {
        if (store.skipped.length > 0) logger.info({ run: spec.name, store: store.id, skipped: store.skipped }, 'Credential broker skipped store entries');
    }
    let nextOrder = Math.max(0, ...spec.mounts.map(mount => mount.order), ...spec.env.map(variable => variable.order), ...spec.envFiles.map(file => file.order)) + 1;
    const uploadedSpec: AgentRunSpec = {
        ...spec,
        mounts: spec.mounts.filter(mount => !uploadable(mount)),
        files: [...(spec.files ?? []), ...uploaded.sort((left, right) => left.order - right.order).flatMap(entry => entry.files)],
        // Name only: the value travels in the launch environment, never in the spec.
        env: [...spec.env, ...Object.keys(bundle.secretEnv).map(name => ({ name, order: nextOrder++ }))],
    };
    const refreshable = targets.some(target => target.writeBack && bundle.stores.find(store => store.id === target.storeId)!.outputs.length > 0);
    let collection: Promise<CredentialCollection> | undefined;
    const collect = (handle: AgentRunHandle): Promise<CredentialCollection> => collection ??= (async () => {
        const returned: ReturnedCredentialFile[] = [];
        const unread: string[] = [];
        // Keep the run before reading: a runtime that removes finished runs on its own (a lingering
        // Machine) must not do so while a refreshed credential is still being read from it.
        const retained = refreshable ? await retainForCollection(handle, spec.name) : true;
        for (const target of targets.filter(candidate => candidate.writeBack)) {
            const store = bundle.stores.find(candidate => candidate.id === target.storeId)!;
            for (const output of store.outputs) {
                const guestPath = path.posix.join(target.mount.target, output);
                try {
                    const read = await readReturnedCredential(handle, target.mount.target, output);
                    if (read === 'oversized') {
                        logger.warn({ run: spec.name, store: store.id, file: output, maxBytes: MAX_RETURNED_CREDENTIAL_BYTES }, 'Refreshed credential from the run exceeds the size limit; not writing it back');
                    } else if (read) {
                        returned.push({ storeId: store.id, path: output, content: read.content, mtimeMs: read.mtimeMs });
                    }
                } catch (error) {
                    unread.push(guestPath);
                    logger.warn({ run: spec.name, store: store.id, file: output, error: (error as Error).message }, 'Could not read a refreshed credential back from the run');
                }
            }
        }
        let results: CredentialWriteBackResult[] = [];
        let recoveryDir: string | undefined;
        let unsaved = false;
        try {
            results = await broker.commit(bundle, returned);
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials');
        } catch (error) {
            const message = (error as Error).message;
            const pending = changedOutputs(bundle, returned);
            if (pending.length > 0) {
                recoveryDir = saveRecoveryCopy(credentialRunRoot(environment), { name: spec.name, bundle }, pending, message);
                unsaved = !recoveryDir;
            } else {
                logger.error({ run: spec.name, error: message }, 'Credential broker could not write back refreshed credentials from the run');
            }
        }
        const keepRun = unread.length > 0 || unsaved;
        if (keepRun && retained) {
            logger.error({ run: spec.name, unread, unsaved }, 'The run may hold the only copy of a refreshed credential; keeping it until it is released explicitly');
        } else if (keepRun) {
            logger.error(
                { run: spec.name, unread, unsaved },
                'The run may hold the only copy of a refreshed credential, but it could not be retained: the runtime may already have removed it, and the refreshed credential may be lost',
            );
        }
        return { results, keepRun, retained, ...(recoveryDir ? { recoveryDir } : {}) };
    })();
    return { spec: uploadedSpec, secretEnv: bundle.secretEnv, bundle, collect };
}

/**
 * Retain the run and wait until the runtime confirms it (a runtime without
 * asynchronous retention keeps a retained run at once). False, logged, when
 * the runtime could not establish it; a handle without `retain()` cannot
 * remove the run on its own, so it counts as kept.
 */
async function retainForCollection(handle: AgentRunHandle, run: string): Promise<boolean> {
    if (!handle.retain) return true;
    let retained: boolean;
    try {
        retained = (await handle.retain()) !== false;
    } catch (error) {
        logger.warn({ run, error: (error as Error).message }, 'Retaining the run before reading back refreshed credentials failed');
        retained = false;
    }
    if (!retained) logger.warn({ run }, 'Could not retain the run before reading back its refreshed credentials; reading them anyway before it is removed');
    return retained;
}

/**
 * A handle whose `wait()` settles only after the run's refreshed credentials
 * were collected, so they are read before the workspace transport (or the
 * caller) releases the run. Collection retains the run first; once it
 * succeeded, `release()` (from the workspace transport or the caller)
 * discards the run as usual. A run that may hold the only copy of a refreshed
 * credential stays retained, and `release()` keeps it instead of discarding it.
 */
export function collectingHandle<Handle extends AgentRunHandle>(handle: Handle, collect: (handle: AgentRunHandle) => Promise<Pick<CredentialCollection, 'keepRun'>>): Handle {
    let collected: Promise<boolean> | undefined;
    const collectOnce = (): Promise<boolean> => collected ??= collect(handle).then(async outcome => {
        if (outcome.keepRun) await handle.retain?.();
        return outcome.keepRun;
    });
    let waited: ReturnType<Handle['wait']> | undefined;
    const wait = () => waited ??= handle.wait().then(async result => {
        await collectOnce();
        return result;
    }, async error => {
        await collectOnce();
        throw error;
    }) as ReturnType<Handle['wait']>;
    const release = handle.release ? async () => {
        if (waited && await collected?.catch(() => false)) {
            logger.warn({ run: handle.spec.name }, 'Not releasing the run: it may hold the only copy of a refreshed credential');
            return;
        }
        return handle.release!();
    } : undefined;
    return new Proxy(handle, {
        get(target, property) {
            if (property === 'wait') return wait;
            if (property === 'release') return release;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
