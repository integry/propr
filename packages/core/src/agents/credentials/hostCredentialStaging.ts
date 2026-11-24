import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../../utils/logger.js';
import type { AgentRunMount, AgentRunSpec } from '../runtime/types.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES, lstatInside,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from './broker.js';

/**
 * Docker transport for the credential broker: stage the per-run copy in a
 * host directory the daemon can bind-mount, and read refreshed tokens back
 * from it once the run has finished.
 */

export const AGENT_CREDENTIAL_BROKER_ENV = 'PROPR_AGENT_CREDENTIAL_BROKER';
export const AGENT_CREDENTIAL_RUN_DIR_ENV = 'PROPR_AGENT_CREDENTIAL_RUN_DIR';
export type CredentialBrokerMode = 'per-run' | 'legacy';

/** Staged copies older than this belong to a crashed worker and are swept. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

type Environment = Record<string, string | undefined>;

/**
 * `per-run` (default): runs get a per-run copy of their credential files.
 * `legacy`: the canonical store is bind-mounted directly, as before. Unset
 * also means `legacy` while managed native-log capture (`PROPR_MANAGED_LOGS=1`)
 * is enabled, because that capture reads provider logs from the canonical store.
 */
export function resolveCredentialBrokerMode(environment: Environment = process.env): CredentialBrokerMode {
    const value = environment[AGENT_CREDENTIAL_BROKER_ENV]?.trim().toLowerCase();
    if (value === 'legacy' || value === 'off' || value === '0' || value === 'false') return 'legacy';
    if (value === 'per-run' || value === 'on' || value === '1' || value === 'true') return 'per-run';
    if (value) throw new Error(`${AGENT_CREDENTIAL_BROKER_ENV} must be "per-run" or "legacy", not "${value}"`);
    return environment.PROPR_MANAGED_LOGS === '1' ? 'legacy' : 'per-run';
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

type CredentialBindMount = Extract<AgentRunMount, { type: 'bind' }> & { credentialStore: NonNullable<Extract<AgentRunMount, { type: 'bind' }>['credentialStore']> };

function perRunCredentialMounts(spec: AgentRunSpec): CredentialBindMount[] {
    return spec.mounts.filter((mount): mount is CredentialBindMount => mount.type === 'bind' && !!mount.credentialStore?.perRun);
}

/** Variables the run defines with a value, either literally or inherited from the launch environment. */
function definedVariables(spec: AgentRunSpec, launchEnvironment: Environment): string[] {
    return [...(spec.repoSetup?.env ?? []), ...spec.env]
        .filter(variable => (variable.value ?? launchEnvironment[variable.name] ?? '') !== '')
        .map(variable => variable.name);
}

function sweepStaleStaging(root: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { return; }
    const cutoff = Date.now() - STALE_STAGING_MS;
    for (const entry of entries) {
        if (entry === '.locks') continue;
        const candidate = path.join(root, entry);
        try {
            const stat = fs.lstatSync(candidate);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
        } catch { /* another worker removed it, or it is container-owned */ }
    }
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
            const stat = lstatInside(storeDir, output);
            if (!stat || stat === 'symlink' || !stat.isFile() || stat.size > MAX_RETURNED_CREDENTIAL_BYTES) continue;
            returned.push({ storeId: store.id, path: output, content: fs.readFileSync(path.join(storeDir, output)), mtimeMs: stat.mtimeMs });
        }
    }
    return returned;
}

/**
 * Replace each per-run credential bind in `spec` with a staged copy holding
 * only its manifest's files. Returns `undefined` when the spec has no such
 * bind or the legacy mode is selected, so the canonical mount is used.
 */
export function stageAgentRunCredentials(
    spec: AgentRunSpec,
    options: { environment?: Environment; launchEnvironment?: Environment; broker?: CredentialBroker } = {},
): StagedAgentRunCredentials | undefined {
    const environment = options.environment ?? process.env;
    if (resolveCredentialBrokerMode(environment) === 'legacy') return undefined;
    const mounts = perRunCredentialMounts(spec);
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
    try {
        for (const store of bundle.stores) writeStore(path.join(stagingDir, store.id), store);
    } catch (error) {
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
        try {
            results = await broker.commit(bundle, collectStagedCredentials(bundle, stagingDir));
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials');
        } catch (error) {
            logger.error({ run: spec.name, error: (error as Error).message }, 'Credential broker could not write back refreshed credentials');
        }
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); }
        catch (error) { logger.warn({ run: spec.name, stagingDir, error: (error as Error).message }, 'Could not remove staged agent credentials'); }
        return results;
    })();
    return { spec: stagedSpec, secretEnv: bundle.secretEnv, bundle, stagingDir, complete };
}
