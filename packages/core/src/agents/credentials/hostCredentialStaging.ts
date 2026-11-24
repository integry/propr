import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../../utils/logger.js';
import type { AgentRunMount, AgentRunSpec } from '../runtime/types.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES, readRegularFileInside,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from './broker.js';
import { providerCredentialManifest, refreshableCredentialPaths } from './providerManifests.js';

/**
 * Docker transport for the credential broker: stage the per-run copy in a
 * host directory the daemon can bind-mount, and read refreshed tokens back
 * from it once the run has finished.
 */

export const AGENT_CREDENTIAL_BROKER_ENV = 'PROPR_AGENT_CREDENTIAL_BROKER';
export const AGENT_CREDENTIAL_RUN_DIR_ENV = 'PROPR_AGENT_CREDENTIAL_RUN_DIR';
export type CredentialBrokerMode = 'per-run' | 'legacy';

/**
 * A staged copy whose lease has not been refreshed for this long belongs to a
 * worker that is no longer running and is swept. Live runs refresh their lease
 * every {@link STAGING_LEASE_REFRESH_MS}, however long the run takes.
 */
export const STALE_STAGING_LEASE_MS = 24 * 60 * 60 * 1000;
export const STAGING_LEASE_REFRESH_MS = 5 * 60 * 1000;
/** Lease file in each staging directory (beside, never inside, the mounted stores). */
export const STAGING_LEASE_FILE = '.propr-lease';
/** Marks a staging directory kept because refreshed tokens could not be written back. */
export const STAGING_RETAINED_FILE = '.propr-retained.json';

type Environment = Record<string, string | undefined>;

/** The broker mode, and whether the operator selected it rather than it being the default. */
function credentialBrokerSelection(environment: Environment): { mode: CredentialBrokerMode; explicit: boolean } {
    const value = environment[AGENT_CREDENTIAL_BROKER_ENV]?.trim().toLowerCase();
    if (value === 'legacy' || value === 'off' || value === '0' || value === 'false') return { mode: 'legacy', explicit: true };
    if (value === 'per-run' || value === 'on' || value === '1' || value === 'true') return { mode: 'per-run', explicit: true };
    if (value) throw new Error(`${AGENT_CREDENTIAL_BROKER_ENV} must be "per-run" or "legacy", not "${value}"`);
    return { mode: environment.PROPR_MANAGED_LOGS === '1' ? 'legacy' : 'per-run', explicit: false };
}

/**
 * `per-run` (default): runs get a per-run copy of their credential files.
 * `legacy`: the canonical store is bind-mounted directly, as before. Unset
 * also means `legacy` while managed native-log capture (`PROPR_MANAGED_LOGS=1`)
 * is enabled, because that capture reads provider logs from the canonical store.
 */
export function resolveCredentialBrokerMode(environment: Environment = process.env): CredentialBrokerMode {
    return credentialBrokerSelection(environment).mode;
}

/**
 * Where per-run copies are staged. It must be visible at the same path to the
 * worker and the Docker daemon, like the managed credential root it defaults
 * to (Compose mounts that directory HOST:HOST).
 */
export function credentialRunRoot(environment: Environment = process.env): string {
    const configured = environment[AGENT_CREDENTIAL_RUN_DIR_ENV]?.trim();
    if (configured) return path.resolve(configured);
    const homeDir = environment.HOME || environment.USERPROFILE || os.homedir();
    const managedRoot = environment.PROPR_MANAGED_CREDENTIALS_DIR || path.join(homeDir, '.propr', 'agent-credentials');
    return path.join(managedRoot, '.propr-runs');
}

export interface StagedAgentRunCredentials {
    /** The spec with each per-run credential bind pointing at its staged copy. */
    spec: AgentRunSpec;
    /** Secret variables for the Docker client environment; the spec names them without values. */
    secretEnv: Record<string, string>;
    bundle: CredentialBundle;
    stagingDir: string;
    /** Write refreshed tokens back and remove the staged copy. Never throws. */
    complete(): Promise<CredentialWriteBackResult[]>;
}

export type CredentialBindMount = Extract<AgentRunMount, { type: 'bind' }> & { credentialStore: NonNullable<Extract<AgentRunMount, { type: 'bind' }>['credentialStore']> };

function perRunCredentialMounts(spec: AgentRunSpec): CredentialBindMount[] {
    return spec.mounts.filter((mount): mount is CredentialBindMount => mount.type === 'bind' && !!mount.credentialStore?.perRun);
}

/**
 * Values an `--env-file` gives the run, parsed as the Docker CLI does: lines
 * trimmed on the left, `#` comments, `NAME=value` taken verbatim and a bare
 * `NAME` inherited from the client environment (omitted when unset there).
 * An unreadable file defines nothing here; Docker refuses to start the run.
 */
export function envFileValues(filePath: string, launchEnvironment: Environment): Map<string, string> {
    const values = new Map<string, string>();
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return values; }
    for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.trimStart();
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        const name = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? launchEnvironment[name] : line.slice(separator + 1);
        if (value !== undefined) values.set(name, value);
    }
    return values;
}

/**
 * Variables the run defines with a value: literally, inherited from the
 * launch environment, or through an environment file. Docker applies `-e`
 * after every `--env-file` (later files overriding earlier ones), so a
 * fallback secret appended by name would replace an env-file value; those
 * variables must count as defined too.
 */
export function definedVariables(spec: AgentRunSpec, launchEnvironment: Environment): string[] {
    const effective = new Map<string, string>();
    for (const file of [...spec.envFiles].sort((left, right) => left.order - right.order)) {
        for (const [name, value] of envFileValues(file.path, launchEnvironment)) effective.set(name, value);
    }
    for (const variable of [...(spec.repoSetup?.env ?? []), ...spec.env]) {
        const value = variable.value ?? launchEnvironment[variable.name];
        // A bare name unset in the client environment unsets the variable, env-file value included.
        if (value === undefined) effective.delete(variable.name);
        else effective.set(variable.name, value);
    }
    return [...effective].filter(([, value]) => value !== '').map(([name]) => name);
}

/**
 * Remove staging directories whose owner is gone: the lease (or, before the
 * lease exists, the directory itself) has not been touched within
 * {@link STALE_STAGING_LEASE_MS}. Directories retained after a failed
 * write-back hold the only copy of a refreshed token and are never swept.
 */
export function sweepStaleStaging(root: string, now = Date.now()): void {
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { return; }
    const cutoff = now - STALE_STAGING_LEASE_MS;
    for (const entry of entries) {
        if (entry === '.locks') continue;
        const candidate = path.join(root, entry);
        try {
            const stat = fs.lstatSync(candidate);
            if (!stat.isDirectory() || fs.existsSync(path.join(candidate, STAGING_RETAINED_FILE))) continue;
            let heartbeatMs = stat.mtimeMs;
            try { heartbeatMs = Math.max(heartbeatMs, fs.lstatSync(path.join(candidate, STAGING_LEASE_FILE)).mtimeMs); } catch { /* not leased yet */ }
            if (heartbeatMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
        } catch { /* another worker removed it, or it is container-owned */ }
    }
}

/** Keep the staging lease fresh while the run (and its write-back) is in progress. */
function holdStagingLease(stagingDir: string, runName: string): () => void {
    const lease = path.join(stagingDir, STAGING_LEASE_FILE);
    fs.writeFileSync(lease, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
    let warned = false;
    const timer = setInterval(() => {
        try {
            const seconds = Date.now() / 1000;
            fs.utimesSync(lease, seconds, seconds);
        } catch (error) {
            if (!warned) logger.warn({ run: runName, stagingDir, error: (error as Error).message }, 'Could not refresh the staged credential lease');
            warned = true;
        }
    }, STAGING_LEASE_REFRESH_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Whether refreshed tokens can be written back to `mount`'s canonical store
 * from this process. By default a store mounted read-only into the worker (or
 * not writable by its user) keeps the direct mount instead, so the run's own
 * read-write bind persists refreshes as it did before per-run copies. An
 * explicit `per-run` selection refuses such a run instead.
 */
export function canWriteBack(mount: CredentialBindMount): boolean {
    if (mount.readOnly) return true;
    const manifest = providerCredentialManifest(mount.credentialStore.provider, mount.credentialStore.store);
    if (!manifest || refreshableCredentialPaths(manifest).length === 0) return true;
    try {
        fs.accessSync(mount.source, fs.constants.W_OK);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}

function changedOutputs(bundle: CredentialBundle, returned: readonly ReturnedCredentialFile[]): ReturnedCredentialFile[] {
    return returned.filter(file => {
        const store = bundle.stores.find(candidate => candidate.id === file.storeId);
        return !!store && createHash('sha256').update(file.content).digest('hex') !== store.baseline[file.path];
    });
}

function chownIfPrivileged(target: string, owner: { uid: number; gid: number } | undefined): void {
    if (process.getuid?.() !== 0 || !owner) return;
    try { fs.lchownSync(target, owner.uid, owner.gid); } catch { /* best effort, like cp -p */ }
}

function canonicalOwner(root: string): { uid: number; gid: number } | undefined {
    try { const stat = fs.statSync(root); return { uid: stat.uid, gid: stat.gid }; } catch { return undefined; }
}

function writeStore(storeDir: string, store: CredentialBundle['stores'][number]): void {
    const owner = canonicalOwner(store.canonicalRoot);
    fs.mkdirSync(storeDir, { mode: 0o700 });
    chownIfPrivileged(storeDir, owner);
    const ensureDirectory = (relative: string): void => {
        let current = storeDir;
        for (const part of relative.split('/')) {
            current = path.join(current, part);
            if (fs.existsSync(current)) continue;
            fs.mkdirSync(current, { mode: 0o700 });
            chownIfPrivileged(current, owner);
        }
    };
    for (const directory of store.directories) ensureDirectory(directory);
    for (const file of store.files) {
        const parent = path.posix.dirname(file.path);
        if (parent !== '.') ensureDirectory(parent);
        const target = path.join(storeDir, file.path);
        fs.writeFileSync(target, file.content, { mode: file.mode, flag: 'wx' });
        fs.chmodSync(target, file.mode);
        const seconds = file.mtimeMs / 1000;
        fs.utimesSync(target, seconds, seconds);
        chownIfPrivileged(target, { uid: file.uid, gid: file.gid });
    }
}

/** Refreshable outputs the run left in its staged copy (regular files only, bounded). */
export function collectStagedCredentials(bundle: CredentialBundle, stagingDir: string): ReturnedCredentialFile[] {
    const returned: ReturnedCredentialFile[] = [];
    for (const store of bundle.stores) {
        const storeDir = path.join(stagingDir, store.id);
        for (const output of store.outputs) {
            const read = readRegularFileInside(storeDir, output, MAX_RETURNED_CREDENTIAL_BYTES);
            if (!read || read === 'oversized') continue;
            returned.push({ storeId: store.id, path: output, content: read.content, mtimeMs: read.stat.mtimeMs });
        }
    }
    return returned;
}

/** Keep a staged copy whose refreshed tokens were not written back, and say where it is. */
function retainStaging(
    stagingDir: string, bundle: CredentialBundle, failure: { pending: ReturnedCredentialFile[] | undefined; error: string; runName: string },
): void {
    const { pending, error, runName } = failure;
    const files = (pending ?? bundle.stores.flatMap(store => store.outputs.map(output => ({ storeId: store.id, path: output }))))
        .map(file => {
            const store = bundle.stores.find(candidate => candidate.id === file.storeId)!;
            return { staged: path.join(stagingDir, store.id, file.path), canonical: path.join(store.canonicalRoot, file.path) };
        });
    try {
        fs.writeFileSync(path.join(stagingDir, STAGING_RETAINED_FILE), `${JSON.stringify({ retainedAt: new Date().toISOString(), error, files }, null, 2)}\n`, { mode: 0o600 });
    } catch (markerError) {
        logger.warn({ run: runName, stagingDir, error: (markerError as Error).message }, 'Could not mark retained staged credentials');
    }
    logger.error(
        { run: runName, stagingDir, error, files },
        'Credential broker could not write back refreshed credentials; kept the staged copy. Restore each staged file that is newer than its canonical file, then delete the directory',
    );
}

/**
 * Replace each per-run credential bind in `spec` with a staged copy holding
 * only its manifest's files. Returns `undefined` when the spec has no such
 * bind or the legacy mode is selected, so the canonical mount is used.
 * Throws, before staging anything, when `per-run` was selected explicitly but
 * the worker cannot write a store's refreshed tokens back: the run would
 * otherwise receive that whole canonical store.
 */
export function stageAgentRunCredentials(
    spec: AgentRunSpec,
    options: { environment?: Environment; launchEnvironment?: Environment; broker?: CredentialBroker } = {},
): StagedAgentRunCredentials | undefined {
    const environment = options.environment ?? process.env;
    const selection = credentialBrokerSelection(environment);
    if (selection.mode === 'legacy') return undefined;
    const candidates = perRunCredentialMounts(spec);
    const unwritable = candidates.filter(candidate => !canWriteBack(candidate));
    const describe = (mount: CredentialBindMount) => ({ provider: mount.credentialStore.provider, store: mount.credentialStore.store, source: mount.source });
    if (selection.explicit && unwritable.length > 0) {
        logger.error({ run: spec.name, stores: unwritable.map(describe) }, 'Credential store is not writable from the worker; refusing the run because per-run credential copies were requested');
        const names = unwritable.map(mount => `${mount.credentialStore.provider} ${mount.credentialStore.store}`).join(', ');
        const stores = unwritable.length === 1 ? 'store' : 'stores';
        throw new Error(
            `${AGENT_CREDENTIAL_BROKER_ENV} requires per-run credential copies, but the worker cannot write refreshed tokens back to the ${names} credential ${stores} for ${spec.name}. `
            + `Make the ${stores} writable from the worker, or unset ${AGENT_CREDENTIAL_BROKER_ENV} to let such runs mount ${unwritable.length === 1 ? 'it' : 'them'} directly`,
        );
    }
    for (const mount of unwritable) {
        logger.warn({ run: spec.name, ...describe(mount) }, 'Credential store is not writable from the worker; mounting it directly so refreshed tokens persist');
    }
    const mounts = candidates.filter(candidate => !unwritable.includes(candidate));
    if (mounts.length === 0) return undefined;
    const root = credentialRunRoot(environment);
    const broker = options.broker ?? new CredentialBroker({ lock: { lockRoot: path.join(root, '.locks') } });
    const requests: CredentialStoreRequest[] = mounts.map(mount => ({
        id: `${mount.credentialStore.provider}-${mount.credentialStore.store}`,
        provider: mount.credentialStore.provider,
        store: mount.credentialStore.store,
        canonicalRoot: mount.source,
    }));
    const bundle = broker.materialize(requests, { definedEnv: definedVariables(spec, { ...process.env, ...options.launchEnvironment }) });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    sweepStaleStaging(root);
    const safeName = spec.name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-80);
    const stagingDir = path.join(root, `${safeName}-${randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stagingDir, { mode: 0o711 });
    let releaseLease: () => void = () => {};
    try {
        releaseLease = holdStagingLease(stagingDir, spec.name);
        for (const store of bundle.stores) writeStore(path.join(stagingDir, store.id), store);
    } catch (error) {
        releaseLease();
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
    const staged = new Map(mounts.map((mount, index) => [mount, path.join(stagingDir, bundle.stores[index].id)]));
    let nextOrder = Math.max(0, ...spec.mounts.map(mount => mount.order), ...spec.env.map(variable => variable.order), ...spec.envFiles.map(file => file.order)) + 1;
    const stagedSpec: AgentRunSpec = {
        ...spec,
        mounts: spec.mounts.map(mount => {
            const source = staged.get(mount as CredentialBindMount);
            return source && mount.type === 'bind' ? { ...mount, source } : mount;
        }),
        // Name only: the value reaches the run through the Docker client environment, never argv.
        env: [...spec.env, ...Object.keys(bundle.secretEnv).map(name => ({ name, order: nextOrder++ }))],
    };
    for (const store of bundle.stores) {
        if (store.skipped.length > 0) logger.info({ run: spec.name, store: store.id, skipped: store.skipped }, 'Credential broker skipped store entries');
    }
    let completion: Promise<CredentialWriteBackResult[]> | undefined;
    const complete = (): Promise<CredentialWriteBackResult[]> => completion ??= (async () => {
        let results: CredentialWriteBackResult[] = [];
        let returned: ReturnedCredentialFile[] | undefined;
        try {
            returned = collectStagedCredentials(bundle, stagingDir);
            results = await broker.commit(bundle, returned);
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials');
        } catch (error) {
            const message = (error as Error).message;
            // Unknown (collection failed) or refreshed outputs: the staged copy may be their only copy.
            const pending = returned ? changedOutputs(bundle, returned) : undefined;
            if (!pending || pending.length > 0) {
                releaseLease();
                retainStaging(stagingDir, bundle, { pending, error: message, runName: spec.name });
                return results;
            }
            logger.error({ run: spec.name, error: message }, 'Credential broker could not write back refreshed credentials');
        }
        releaseLease();
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); }
        catch (error) { logger.warn({ run: spec.name, stagingDir, error: (error as Error).message }, 'Could not remove staged agent credentials'); }
        return results;
    })();
    return { spec: stagedSpec, secretEnv: bundle.secretEnv, bundle, stagingDir, complete };
}
