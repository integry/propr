import path from 'node:path';
import logger from '../../../utils/logger.js';
import {
    CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES,
    type CredentialBundle, type CredentialStoreRequest, type CredentialWriteBackResult, type ReturnedCredentialFile,
} from '../../credentials/broker.js';
import { credentialRunRoot, definedVariables } from '../../credentials/hostCredentialStaging.js';
import type { AgentRunSpec } from '../types.js';
import type { SpritesMountPlan, SpritesRunPaths } from './spritesCommand.js';
import type { SpriteFilesystemLike } from './spritesSdk.js';

/**
 * The credential broker over the Sprites filesystem API: the per-run copy
 * (only the provider manifest's files) is uploaded into the run directory and
 * installed by the root launcher; refreshed token files come back through the
 * same directory and are written to the canonical store under its lock, so a
 * token that rotated on the Sprite does not invalidate the control plane's copy.
 */
export interface SpritesCredentialSync {
    bundle: CredentialBundle;
    /** Secret variables the run receives instead of files (e.g. an API key from `.env`). */
    secretEnv: Record<string, string>;
    /** Launcher manifest records for the stores. */
    records: string[][];
    /** Upload the copy into the run directory. */
    upload(filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<void>;
    /** Read refreshed outputs back and write them to their canonical stores. Never throws. */
    writeBack(filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<{ results: CredentialWriteBackResult[]; retained: boolean }>;
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
    bundle.stores.forEach((store, index) => {
        const target = plan.credentialStores[index].target;
        records.push(['store', `store/${store.id}`, target]);
        for (const output of store.outputs) records.push(['output', path.posix.join(target, output), `returned/${store.id}/${output}`]);
        if (store.skipped.length > 0) logger.info({ run: spec.name, store: store.id, skipped: store.skipped }, 'Credential broker skipped store entries');
    });

    const upload = async (filesystem: SpriteFilesystemLike, paths: SpritesRunPaths): Promise<void> => {
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

    const writeBack = async (filesystem: SpriteFilesystemLike, paths: SpritesRunPaths) => {
        const returned: ReturnedCredentialFile[] = [];
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

    return { bundle, secretEnv: bundle.secretEnv, records, upload, writeBack };
}
