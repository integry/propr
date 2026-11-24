import fs from 'node:fs';
import path from 'node:path';
import logger from '../../utils/logger.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from '../credentials/broker.js';
import {
    canWriteBack, credentialRunRoot, definedVariables, type CredentialBindMount,
} from '../credentials/hostCredentialStaging.js';
import type { AgentRunFile, AgentRunHandle, AgentRunMount, AgentRunSpec } from './types.js';

/**
 * Upload transport for runtimes without bind mounts (Fly Machines and other
 * remote sandboxes): the bind sources a run declares are delivered as files
 * written into the run before it starts, and the credential broker's
 * refreshable outputs are read back through the runtime file API afterwards.
 *
 * - A credential store bind gets the broker's per-run copy (only the
 *   provider manifest's files); refreshed tokens are written back to the
 *   canonical store when the run finished.
 * - Any other bind is copied in (bounded, regular files only, symlinks
 *   skipped); writes to it stay in the sandbox. Log directories are created
 *   empty. A writable copy is never written back.
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
    collect(handle: AgentRunHandle): Promise<CredentialWriteBackResult[]>;
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
    let bytes = 0;
    const add = (source: string, target: string, stat: fs.Stats): void => {
        if (files.length >= MAX_UPLOADED_BIND_FILES || bytes + stat.size > MAX_UPLOADED_BIND_BYTES) {
            throw new AgentRunFileUploadError(`Bind source ${mount.source} exceeds the upload limit (${MAX_UPLOADED_BIND_FILES} files, ${MAX_UPLOADED_BIND_BYTES} bytes)`);
        }
        bytes += stat.size;
        files.push({ type: 'file', path: target, content: fs.readFileSync(source), mode: stat.mode & 0o777, purpose: mount.purpose });
    };
    const walk = (source: string, target: string): void => {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) { add(source, target, stat); return; }
        if (!stat.isDirectory()) return;
        files.push({ type: 'directory', path: target, mode: stat.mode & 0o777, purpose: mount.purpose });
        for (const entry of fs.readdirSync(source).sort()) walk(path.join(source, entry), path.posix.join(target, entry));
    };
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(mount.source);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // `--mount` refuses a missing source; `-v` creates an empty directory.
        if (mount.syntax === 'mount') throw new AgentRunFileUploadError(`Bind source ${mount.source} for ${mount.target} does not exist`);
        return [{ type: 'directory', path: mount.target, mode: 0o755, purpose: mount.purpose }];
    }
    if (stat.isSymbolicLink()) {
        // Docker follows a symlinked source; resolve it once, then copy without following links below it.
        return copyBindSource({ ...mount, source: fs.realpathSync(mount.source) });
    }
    // Logs a run writes are not read back from the sandbox; give it the directory only.
    if (mount.purpose === 'logs' && stat.isDirectory()) return [{ type: 'directory', path: mount.target, mode: 0o777, purpose: 'logs' }];
    walk(mount.source, mount.target);
    return files;
}

function storeFiles(bundle: CredentialBundle, targets: StoreTarget[]): AgentRunFile[] {
    const files: AgentRunFile[] = [];
    for (const target of targets) {
        const store = bundle.stores.find(candidate => candidate.id === target.storeId)!;
        const root = target.mount.target;
        files.push({ type: 'directory', path: root, mode: 0o700, purpose: target.mount.purpose });
        for (const directory of store.directories) files.push({ type: 'directory', path: path.posix.join(root, directory), mode: 0o700, purpose: target.mount.purpose });
        for (const file of store.files) {
            files.push({ type: 'file', path: path.posix.join(root, file.path), content: file.content, mode: file.mode & 0o777, purpose: target.mount.purpose });
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
        // A run that relies on state persisting in the store between launches cannot get that
        // from a remote sandbox; it receives a per-run copy whose refreshes are written back.
        writeBack: !mount.readOnly && canWriteBack(mount),
    }));
    for (const target of targets) {
        if (!target.mount.credentialStore.perRun) {
            logger.warn({ run: spec.name, store: target.storeId }, 'Runtime cannot mount the canonical credential store; the run receives a per-run copy');
        }
        if (!target.mount.readOnly && !target.writeBack) {
            logger.warn({ run: spec.name, store: target.storeId, source: target.mount.source }, 'Credential store is not writable from the worker; refreshed tokens from this run will not persist');
        }
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
    let collection: Promise<CredentialWriteBackResult[]> | undefined;
    const collect = (handle: AgentRunHandle): Promise<CredentialWriteBackResult[]> => collection ??= (async () => {
        const returned: ReturnedCredentialFile[] = [];
        for (const target of targets.filter(candidate => candidate.writeBack)) {
            const store = bundle.stores.find(candidate => candidate.id === target.storeId)!;
            for (const output of store.outputs) {
                try {
                    const content = await handle.readFile?.(path.posix.join(target.mount.target, output));
                    if (content && content.length <= MAX_RETURNED_CREDENTIAL_BYTES) returned.push({ storeId: store.id, path: output, content, mtimeMs: Date.now() });
                } catch (error) {
                    logger.warn({ run: spec.name, store: store.id, file: output, error: (error as Error).message }, 'Could not read a refreshed credential back from the run');
                }
            }
        }
        try {
            const results = await broker.commit(bundle, returned);
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials');
            return results;
        } catch (error) {
            logger.error({ run: spec.name, error: (error as Error).message }, 'Credential broker could not write back refreshed credentials from the run');
            return [];
        }
    })();
    return { spec: uploadedSpec, secretEnv: bundle.secretEnv, bundle, collect };
}

/**
 * A handle whose `wait()` settles only after the run's refreshed credentials
 * were collected, so they are read before the workspace transport (or the
 * caller) releases the run.
 */
export function collectingHandle<Handle extends AgentRunHandle>(handle: Handle, collect: (handle: AgentRunHandle) => Promise<unknown>): Handle {
    let waited: ReturnType<Handle['wait']> | undefined;
    const wait = () => waited ??= handle.wait().then(async result => {
        await collect(handle);
        return result;
    }, async error => {
        await collect(handle);
        throw error;
    }) as ReturnType<Handle['wait']>;
    return new Proxy(handle, {
        get(target, property) {
            if (property === 'wait') return wait;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
