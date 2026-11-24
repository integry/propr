import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_RESULT_BUNDLE_FILE, WORKSPACE_RESULT_BUNDLE_REF } from '../../../git/workspaceTransportScript.js';
import type { AgentRunSpec } from '../types.js';

/**
 * The worker's durable copy of a run's workspace result bundle.
 *
 * A Sprite is restored as soon as its run ends, so the bundle a run left
 * because it could not push its result exists nowhere else once the restore
 * started. It is written here, with what is needed to recover it by hand,
 * before the restore; it stays through a failed retrieval and a worker
 * restart, and goes only when the run is released explicitly.
 */

/** Directory under the Sprites state directory holding one directory per kept result. */
export const SPRITES_RESULTS_DIR = 'results';
/** Describes a kept result: the run, the repository refs, the bundle's digest and how to fetch it. */
export const SPRITES_RESULT_RECOVERY_FILE = 'recovery.json';

export interface SpritesResultRecovery {
    run: string;
    sprite: string;
    savedAt: string;
    /** The sandbox's status line (`bundle <commit>`), when it was readable. */
    status?: string;
    bundle: { file: string; ref: string; bytes: number; sha256: string };
    /** The worker worktree the result was meant for, and the commit the run started from. */
    worktree: string;
    remote?: string;
    branch?: string;
    baseCommit?: string;
    recover: string;
}

async function writeDurably(file: string, content: Buffer | string): Promise<void> {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
        await handle.writeFile(content);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}

export class SpritesResultStore {
    private directory?: string;

    constructor(private readonly stateDir: string, private readonly spec: AgentRunSpec) {}

    /** The private directory holding the kept bundle and its recovery file, once one was saved and until it is discarded. */
    get location(): string | undefined { return this.directory; }

    get bundlePath(): string | undefined {
        return this.directory && path.join(this.directory, WORKSPACE_RESULT_BUNDLE_FILE);
    }

    /**
     * Writes the bundle and its recovery file to disk and resolves once both
     * are flushed. Rejects, leaving nothing behind, when they cannot be written.
     */
    async save(bundle: Buffer, details: { sprite: string; status?: string }): Promise<string> {
        const root = path.join(this.stateDir, SPRITES_RESULTS_DIR);
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const directory = path.join(root, `${this.spec.name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-80)}-${randomBytes(6).toString('hex')}`);
        await fs.mkdir(directory, { mode: 0o700 });
        try {
            const bundlePath = path.join(directory, WORKSPACE_RESULT_BUNDLE_FILE);
            await writeDurably(bundlePath, bundle);
            const clone = this.spec.workspace.clone;
            const recovery: SpritesResultRecovery = {
                run: this.spec.name,
                sprite: details.sprite,
                savedAt: new Date().toISOString(),
                ...(details.status ? { status: details.status } : {}),
                bundle: { file: WORKSPACE_RESULT_BUNDLE_FILE, ref: WORKSPACE_RESULT_BUNDLE_REF, bytes: bundle.length, sha256: createHash('sha256').update(bundle).digest('hex') },
                worktree: this.spec.workspace.hostPath,
                ...(clone ? { remote: clone.remote, branch: clone.branch, baseCommit: clone.baseCommit } : {}),
                recover: `In a clone of the repository: git bundle verify ${bundlePath} && git fetch ${bundlePath} ${WORKSPACE_RESULT_BUNDLE_REF}:refs/heads/recovered-run. `
                    + 'The fetched commit is a snapshot of the run\'s workspace on top of the agent\'s own commits. Delete this directory once the result is recovered.',
            };
            await writeDurably(path.join(directory, SPRITES_RESULT_RECOVERY_FILE), `${JSON.stringify(recovery, null, 2)}\n`);
            await syncDirectory(directory);
            await syncDirectory(root).catch(() => undefined);
        } catch (error) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        this.directory = directory;
        return directory;
    }

    /** The kept bundle, or null when none was saved or it was discarded. */
    async readBundle(): Promise<Buffer | null> {
        return this.bundlePath ? fs.readFile(this.bundlePath) : null;
    }

    /** Removes the kept copy. Only an explicit release of the run does this. */
    async discard(): Promise<void> {
        const directory = this.directory;
        if (!directory) return;
        await fs.rm(directory, { recursive: true, force: true });
        this.directory = undefined;
    }
}
