import path from 'node:path';
import logger from '../../../utils/logger.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from '../../credentials/broker.js';
import { credentialRunRoot, definedVariables } from '../../credentials/hostCredentialStaging.js';
import type { AgentRunSpec } from '../types.js';
import { spritesLiveOutputRecord, spritesOutputRecord, SPRITES_LIVE_CREDENTIAL_ROOTS, type SpritesMountPlan, type SpritesRunPaths } from './spritesCommand.js';
import type { SpriteFilesystemLike } from './spritesSdk.js';

/**
 * The credential broker over the Sprites filesystem API: the per-run copy
 * (only the provider manifest's files) is uploaded into the run directory and
 * installed by the root launcher; refreshed token files come back through the
 * same directory and are written to the canonical store under its lock, so a
 * token that rotated on the Sprite does not invalidate the control plane's copy.
 *
 * Whether a returned token changed is decided against the run's baseline (what
 * it received), which is persisted in the run directory before the copy is
 * uploaded, so a worker that reattaches after a restart recovers it; the copy
 * keeps each file's canonical modification time, so a newer canonical token
 * also wins the broker's conflict check against an unchanged returned one.
 */
export interface SpritesCredentialSync {
    bundle: CredentialBundle;
    /** Secret variables the run receives instead of files (e.g. an API key from `.env`). */
    secretEnv: Record<string, string>;
    /** Launcher manifest records for the stores. */
    records: string[][];
    /**
     * Where the run's live credential copies are on the Sprite: each store's
     * target, and the provider entrypoint's own live copy of it (Antigravity's
     * disposable HOME). They are kept for recovery when the export is not confirmed.
     */
    liveCopies: string[];
    /** Persist the baseline, then upload the copy into the run directory. */
    upload(filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<void>;
    /**
     * Reattachment: replace the baseline of this (re-materialized) bundle with
     * the one persisted when the run was launched. Resolves false when it
     * cannot be recovered; the write-back then keeps the returned tokens for recovery.
     */
    recoverBaseline(filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<boolean>;
    /** Read refreshed outputs back and write them to their canonical stores. Never throws. */
    writeBack(filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<{ results: CredentialWriteBackResult[]; retained: boolean; baselineUnknown?: boolean }>;
}

type PersistedBaseline = Record<string, Record<string, string | null>>;

function parseBaseline(content: Buffer): PersistedBaseline | undefined {
    try {
        const parsed: unknown = JSON.parse(content.toString('utf8'));
        const stores = (parsed as { stores?: unknown } | null)?.stores;
        if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return undefined;
        for (const outputs of Object.values(stores)) {
            if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return undefined;
            if (Object.values(outputs).some(hash => hash !== null && (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)))) return undefined;
        }
        return stores as PersistedBaseline;
    } catch {
        return undefined;
    }
}

/** Epoch seconds with millisecond precision, never later than the file's own time (`touch -d @<seconds>`). */
function stampSeconds(mtimeMs: number): string {
    return (Math.floor(mtimeMs) / 1000).toFixed(3);
}

type Environment = Record<string, string | undefined>;

function isMissing(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || /not found|no such file/i.test((error as Error | null)?.message ?? '');
}

/** A refreshed token file the launcher returned, or undefined when there is none (or it is not a plausible token file). */
async function readReturned(filesystem: SpriteFilesystemLike, file: string): Promise<{ content: Buffer; mtimeMs: number } | undefined> {
    try {
        const stat = await filesystem.stat(file);
        if (!stat.isFile() || stat.size > MAX_RETURNED_CREDENTIAL_BYTES) return undefined;
        return { content: await filesystem.readFile(file, null), mtimeMs: stat.mtime.getTime() };
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

export function prepareSpritesCredentials(
    spec: AgentRunSpec,
    plan: Pick<SpritesMountPlan, 'credentialStores'>,
    options: { launchEnvironment?: Environment; environment?: Environment; broker?: CredentialBroker } = {},
): SpritesCredentialSync | undefined {
    if (plan.credentialStores.length === 0) return undefined;
    const environment = options.environment ?? process.env;
    const broker = options.broker ?? new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(environment), '.locks') } });
    const ids = new Set<string>();
    const requests: CredentialStoreRequest[] = plan.credentialStores.map(mount => {
        const base = `${mount.credentialStore!.provider}-${mount.credentialStore!.store}`;
        let id = base;
        for (let index = 2; ids.has(id); index++) id = `${base}-${index}`;
        ids.add(id);
        return { id, provider: mount.credentialStore!.provider, store: mount.credentialStore!.store, canonicalRoot: mount.source };
    });
    const bundle = broker.materialize(requests, { definedEnv: definedVariables(spec, { ...process.env, ...options.launchEnvironment }) });
    const records: string[][] = [];
    const liveCopies: string[] = [];
    bundle.stores.forEach((store, index) => {
        const target = plan.credentialStores[index].target;
        const liveRoot = SPRITES_LIVE_CREDENTIAL_ROOTS[plan.credentialStores[index].credentialStore!.provider];
        liveCopies.push(target, ...(liveRoot ? [liveRoot] : []));
        // The uploaded copy gets its canonical modification time back before the launcher installs it (`cp -a`).
        for (const file of store.files) records.push(['stamp', path.posix.join('store', store.id, file.path), stampSeconds(file.mtimeMs)]);
        records.push(['store', `store/${store.id}`, target]);
        for (const output of store.outputs) {
            records.push(spritesOutputRecord(target, output, `returned/${store.id}/${output}`));
            // A run killed before its entrypoint synced the live copy back holds its current token only there.
            if (liveRoot) records.push(spritesLiveOutputRecord(liveRoot, output, `returned/${store.id}/${output}`));
        }
        if (store.skipped.length > 0) logger.info({ run: spec.name, store: store.id, skipped: store.skipped }, 'Credential broker skipped store entries');
    });

    let baselineKnown = true;
    const upload = async (filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<void> => {
        // Before any token reaches the Sprite: a run whose copy was uploaded always has its baseline there.
        const persisted: PersistedBaseline = Object.fromEntries(bundle.stores.map(store => [store.id, { ...store.baseline }]));
        await filesystem.writeFile(paths.credentialBaseline, `${JSON.stringify({ run: spec.name, stores: persisted })}\n`, { mode: 0o600 });
        for (const store of bundle.stores) {
            const root = path.posix.join(paths.root, 'store', store.id);
            await filesystem.mkdir(root, { recursive: true, mode: 0o700 });
            for (const directory of store.directories) await filesystem.mkdir(path.posix.join(root, directory), { recursive: true, mode: 0o700 });
            for (const file of store.files) {
                const parent = path.posix.dirname(file.path);
                if (parent !== '.') await filesystem.mkdir(path.posix.join(root, parent), { recursive: true, mode: 0o700 });
                await filesystem.writeFile(path.posix.join(root, file.path), file.content, { mode: file.mode & 0o700 || 0o600 });
            }
        }
    };

    const recoverBaseline = async (filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<boolean> => {
        let persisted: PersistedBaseline | undefined;
        try {
            persisted = parseBaseline(await filesystem.readFile(paths.credentialBaseline, null));
        } catch (error) {
            logger.warn({ run: spec.name, runDirectory: paths.root, error: (error as Error).message }, 'Could not read the reattached Sprites run\'s credential baseline');
        }
        if (!persisted || !bundle.stores.every(store => store.outputs.every(output => persisted[store.id]?.[output] !== undefined))) {
            baselineKnown = false;
            return false;
        }
        for (const store of bundle.stores) for (const output of store.outputs) store.baseline[output] = persisted[store.id][output];
        return true;
    };

    const writeBack = async (filesystem: SpriteFilesystemLike, paths: SpritesRunPaths) => {
        const returned: ReturnedCredentialFile[] = [];
        if (!baselineKnown) {
            // Without what the run received, an unchanged stale token is indistinguishable from a refreshed one.
            logger.error({ run: spec.name, runDirectory: paths.root },
                'The reattached Sprites run\'s credential baseline could not be recovered; kept its returned credentials in the Sprite run directory. Copy each newer file back to its canonical store, then delete the directory');
            return { results: [], retained: true, baselineUnknown: true };
        }
        try {
            for (const store of bundle.stores) {
                for (const output of store.outputs) {
                    const file = await readReturned(filesystem, path.posix.join(paths.root, 'returned', store.id, output));
                    if (file) returned.push({ storeId: store.id, path: output, ...file });
                }
            }
            const results = await broker.commit(bundle, returned);
            const written = results.filter(result => result.outcome !== 'unchanged');
            if (written.length > 0) logger.info({ run: spec.name, results: written }, 'Credential broker wrote back refreshed credentials from the Sprite');
            return { results, retained: false };
        } catch (error) {
            // The Sprite's run directory may now hold the only valid copy of a rotated token: keep it.
            logger.error(
                { run: spec.name, runDirectory: paths.root, error: (error as Error).message, files: returned.map(file => `${file.storeId}/${file.path}`) },
                'Credential broker could not write back refreshed credentials; kept them in the Sprite run directory. Copy each newer file back to its canonical store, then delete the directory',
            );
            return { results: [], retained: true };
        }
    };

    return { bundle, secretEnv: bundle.secretEnv, records, liveCopies: [...new Set(liveCopies)], upload, recoverBaseline, writeBack };
}
