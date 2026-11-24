import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import { AGENT_DEFAULT_VERSIONS } from '../../version/types.js';
import { SPRITES_RUN_ROOT } from './spritesCommand.js';
import { spriteNameForSlot, type SpritesRuntimeConfig } from './spritesConfig.js';
import { spritesErrorStatus, type SpriteLike, type SpriteProgressStream, type SpritesClientLike } from './spritesSdk.js';

/**
 * Sprites are persistent, so each worker keeps a small pool of its own
 * (`<prefix>-<worker>-<slot>`, one run at a time each). A Sprite is created
 * on first use, provisioned once per setup revision by
 * `scripts/sprites-agent-setup.sh`, checkpointed, and restored to that clean
 * checkpoint when each run is released (or, when that did not happen, before
 * the next run). An idle Sprite goes cold and stops billing.
 */

export const SPRITES_SETUP_SCRIPT = 'scripts/sprites-agent-setup.sh';
/** Copied to the Sprite with the setup script; installed where the `propr/agent` image has them. */
export const SPRITES_SETUP_FILES = [
    SPRITES_SETUP_SCRIPT,
    'scripts/agent-entrypoint.sh',
    'scripts/claude-entrypoint.sh',
    'scripts/codex-entrypoint.sh',
    'scripts/antigravity-entrypoint.sh',
    'scripts/gh-wrapper.sh',
] as const;
export const SPRITES_SETUP_STAMP = '/opt/propr/sprites-setup.hash';
const SPRITES_SETUP_UPLOAD_DIR = '/tmp/propr-sprite-setup';
const SETUP_TIMEOUT_MS = 20 * 60_000;
const SETUP_CHECKPOINT_PREFIX = 'propr-setup ';

/** CLI pins the setup script installs: the `propr/agent` image's own `ARG`s, so both runtimes run the same CLIs. */
export interface SpritesCliPins {
    CLAUDE_CLI_VERSION: string;
    CODEX_CLI_VERSION: string;
    ANTIGRAVITY_CLI_VERSION?: string;
    ANTIGRAVITY_CLI_RELEASE_ID?: string;
    ANTIGRAVITY_CLI_SHA512?: string;
}

export function projectRoot(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.PROPR_ROOT
        || (fs.existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
}

const PIN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    let dockerfile = '';
    try { dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.agent'), 'utf8'); } catch { /* fall back to the defaults */ }
    const arg = (name: string): string | undefined => {
        const value = new RegExp(`^ARG ${name}=(\\S+)\\s*$`, 'm').exec(dockerfile)?.[1];
        return value && PIN_PATTERN.test(value) ? value : undefined;
    };
    return {
        CLAUDE_CLI_VERSION: arg('CLAUDE_CLI_VERSION') ?? AGENT_DEFAULT_VERSIONS.claude,
        CODEX_CLI_VERSION: arg('CODEX_CLI_VERSION') ?? AGENT_DEFAULT_VERSIONS.codex,
        ANTIGRAVITY_CLI_VERSION: arg('ANTIGRAVITY_CLI_VERSION'),
        ANTIGRAVITY_CLI_RELEASE_ID: arg('ANTIGRAVITY_CLI_RELEASE_ID'),
        ANTIGRAVITY_CLI_SHA512: arg('ANTIGRAVITY_CLI_SHA512'),
    };
}

export interface SpritesSetupBundle {
    files: Array<{ name: string; content: Buffer }>;
    pins: SpritesCliPins;
    /** Changes with any setup file or pin: a Sprite stamped with another hash is provisioned again. */
    hash: string;
}

export function readSpritesSetupBundle(root = projectRoot()): SpritesSetupBundle {
    const pins = readSpritesCliPins(root);
    const hash = createHash('sha256');
    const files = SPRITES_SETUP_FILES.map(file => {
        let content: Buffer;
        try { content = fs.readFileSync(path.join(root, file)); } catch (error) {
            throw new Error(`The Sprites agent runtime needs ${file} (looked in ${root}; set PROPR_ROOT): ${(error as Error).message}`);
        }
        hash.update(file).update('\0').update(content).update('\0');
        return { name: path.posix.basename(file), content };
    });
    hash.update(JSON.stringify(pins));
    return { files, pins, hash: hash.digest('hex').slice(0, 16) };
}

/** One Sprite slot held by a run. */
export interface SpriteLease {
    sprite: SpriteLike;
    name: string;
    slot: number;
    created: boolean;
    release(): void;
}

/** In-process slot allocation: a worker never starts two runs on one Sprite. */
export class SpritePool {
    private readonly busy = new Set<number>();
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly maxSprites: () => number) {}

    /** The lowest free slot not in `skip`; waits for one when every slot is taken. */
    async acquireSlot(signal?: AbortSignal, skip: ReadonlySet<number> = new Set()): Promise<{ slot: number; release(): void }> {
        for (;;) {
            signal?.throwIfAborted();
            const limit = this.maxSprites();
            if (skip.size >= limit) throw new Error(`Every Sprite of this worker (${limit}) is running another process's agent run or holds credentials awaiting recovery`);
            for (let slot = 0; slot < limit; slot++) {
                if (this.busy.has(slot) || skip.has(slot)) continue;
                this.busy.add(slot);
                let released = false;
                return {
                    slot,
                    release: () => {
                        if (released) return;
                        released = true;
                        this.busy.delete(slot);
                        this.waiters.splice(0).forEach(wake => wake());
                    },
                };
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => reject(signal!.reason ?? new Error('aborted'));
                signal?.addEventListener('abort', onAbort, { once: true });
                this.waiters.push(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
            });
        }
    }

    /** Holds `slot` for a run being reattached after a restart. */
    claim(slot: number): { release(): void } | null {
        if (this.busy.has(slot)) return null;
        this.busy.add(slot);
        return { release: () => { this.busy.delete(slot); this.waiters.splice(0).forEach(wake => wake()); } };
    }
}

/**
 * Whether a launcher of any run is alive on the Sprite: another ProPR process
 * sharing this worker id (set PROPR_SPRITES_WORKER_ID per process) is using it.
 */
export async function spriteRunInProgress(sprite: SpriteLike): Promise<boolean> {
    const script = 'for f in /tmp/propr-sprite-runs/*/pid; do [ -s "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && exit 0; done; exit 1';
    try {
        return (await sprite.execFile('sudo', ['-n', 'bash', '-c', script, 'propr-busy'], { timeout: 60_000 })).exitCode === 0;
    } catch {
        return false;
    }
}

/**
 * Written into a run directory whose refreshed credentials could not be written
 * back to their canonical store: that directory holds the only valid copy of a
 * rotated token. While any run directory carries it, the Sprite is quarantined:
 * it is neither restored (which would delete the directory) nor given another
 * run. Removing the directory once its tokens are recovered lifts the quarantine.
 */
export const SPRITES_RETAINED_CREDENTIALS_MARKER = 'credentials-retained';

/** Run directories on the Sprite holding credentials awaiting recovery. Throws when the Sprite cannot be checked. */
export async function retainedCredentialRuns(sprite: SpriteLike): Promise<string[]> {
    const script = 'for f in "$1"/*/"$2"; do [ -e "$f" ] && printf "%s\\n" "${f%/*}"; done; exit 0';
    const result = await sprite.execFile('bash', ['-c', script, 'propr-retained', SPRITES_RUN_ROOT, SPRITES_RETAINED_CREDENTIALS_MARKER], { timeout: 60_000 });
    if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${text(result.stderr).trim()}`);
    return text(result.stdout).split('\n').map(line => line.trim()).filter(Boolean);
}

/** Get the Sprite, creating it (in the configured region) when it does not exist. */
export async function wakeSprite(client: SpritesClientLike, name: string, config: SpritesRuntimeConfig): Promise<{ sprite: SpriteLike; created: boolean }> {
    try {
        return { sprite: await client.getSprite(name), created: false };
    } catch (error) {
        if (spritesErrorStatus(error) !== 404) throw error;
    }
    return { sprite: await createAgentSprite(client, name, config), created: true };
}

/** Creates the Sprite in the configured region and size. */
export async function createAgentSprite(client: SpritesClientLike, name: string, config: SpritesRuntimeConfig): Promise<SpriteLike> {
    const spriteConfig = {
        ...(config.region ? { region: config.region } : {}),
        ...(config.ramMB ? { ramMB: config.ramMB } : {}),
        ...(config.cpus ? { cpus: config.cpus } : {}),
    };
    const sprite = await client.createSprite(name, {
        ...(Object.keys(spriteConfig).length > 0 ? { config: spriteConfig } : {}),
        labels: ['propr-agent'],
        waitForCapacity: true,
    });
    logger.info({ sprite: name, region: config.region }, 'Created Sprite for agent runs');
    return sprite;
}

async function drain(stream: SpriteProgressStream, what: string): Promise<void> {
    for await (const message of stream) {
        if (message.type === 'error') throw new Error(`${what} failed: ${message.error ?? message.data ?? 'unknown error'}`);
    }
}

function text(value: string | Buffer): string {
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

/** The setup revision the Sprite was provisioned for; undefined when it never was. Throws when the Sprite cannot be checked. */
async function readStamp(sprite: SpriteLike): Promise<string | undefined> {
    const result = await sprite.execFile('cat', [SPRITES_SETUP_STAMP], { timeout: 60_000 });
    return result.exitCode === 0 ? text(result.stdout).trim() || undefined : undefined;
}

async function runSetup(sprite: SpriteLike, bundle: SpritesSetupBundle): Promise<void> {
    const filesystem = sprite.filesystem();
    await filesystem.rm(SPRITES_SETUP_UPLOAD_DIR, { recursive: true, force: true }).catch(() => undefined);
    await filesystem.mkdir(SPRITES_SETUP_UPLOAD_DIR, { recursive: true, mode: 0o755 });
    for (const file of bundle.files) await filesystem.writeFile(path.posix.join(SPRITES_SETUP_UPLOAD_DIR, file.name), file.content, { mode: 0o755 });
    const pins = Object.entries(bundle.pins).filter(([, value]) => value).map(([name, value]) => `${name}=${value}`);
    let result;
    try {
        result = await sprite.execFile('sudo', [
            '-n', 'env', ...pins, `PROPR_SPRITES_SETUP_HASH=${bundle.hash}`,
            'bash', path.posix.join(SPRITES_SETUP_UPLOAD_DIR, path.posix.basename(SPRITES_SETUP_SCRIPT)), SPRITES_SETUP_UPLOAD_DIR,
        ], { timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
        const failure = error as Error & { exitCode?: number; stderr?: string | Buffer };
        const stderr = failure.stderr ? text(failure.stderr).trim().split('\n').slice(-20).join('\n') : '';
        throw new Error(`Sprite ${sprite.name} setup failed${failure.exitCode !== undefined ? ` (exit ${failure.exitCode})` : ''}: ${stderr || failure.message}`);
    }
    if (result.exitCode !== 0) {
        throw new Error(`Sprite ${sprite.name} setup failed (exit ${result.exitCode}): ${text(result.stderr).trim().split('\n').slice(-20).join('\n')}`);
    }
    await filesystem.rm(SPRITES_SETUP_UPLOAD_DIR, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Written (only by the worker, in the run root the agent cannot write to)
 * right after a release restored the clean checkpoint, and consumed by the
 * next run: a Sprite carrying it needs no restore before that run.
 */
export const SPRITES_CLEAN_MARKER = path.posix.join(SPRITES_RUN_ROOT, '.clean');

/** Reads and removes the clean marker; undefined when there is none or it cannot be removed. */
async function takeCleanMarker(sprite: SpriteLike): Promise<string | undefined> {
    const filesystem = sprite.filesystem();
    let marker: string;
    try {
        marker = (await filesystem.readFile(SPRITES_CLEAN_MARKER, null)).toString('utf8').trim();
    } catch {
        return undefined;
    }
    try {
        await filesystem.rm(SPRITES_CLEAN_MARKER, { force: true });
    } catch (error) {
        logger.warn({ sprite: sprite.name, error: (error as Error).message }, 'Could not remove the Sprite clean marker; restoring the checkpoint');
        return undefined;
    }
    return marker;
}

/** Drops the clean marker (a released run that could not restore the Sprite). */
export async function clearCleanMarker(sprite: SpriteLike): Promise<void> {
    await sprite.filesystem().rm(SPRITES_CLEAN_MARKER, { force: true });
}

/**
 * Restores the clean post-setup checkpoint of this setup revision after a run,
 * so nothing the run left (workspace, result bundle, credential copies) stays
 * at rest on the Sprite, and marks the Sprite clean for its next run.
 * Resolves with the restore time, or undefined when there is no such checkpoint.
 */
export async function restoreCleanCheckpoint(sprite: SpriteLike, bundle: SpritesSetupBundle): Promise<number | undefined> {
    const comment = `${SETUP_CHECKPOINT_PREFIX}${bundle.hash}`;
    const checkpoint = (await sprite.listCheckpoints()).find(candidate => candidate.comment === comment);
    if (!checkpoint) return undefined;
    const started = Date.now();
    await drain(await sprite.restoreCheckpoint(checkpoint.id), `Restoring Sprite ${sprite.name} to checkpoint ${checkpoint.id}`);
    const restoreMs = Date.now() - started;
    const filesystem = sprite.filesystem();
    await filesystem.mkdir(SPRITES_RUN_ROOT, { recursive: true, mode: 0o711 });
    await filesystem.writeFile(SPRITES_CLEAN_MARKER, `${comment}\n`, { mode: 0o600 });
    return restoreMs;
}

export interface SpriteProvisioning {
    /**
     * `setup`: provisioned now (and checkpointed); `restore`: rolled back to the clean checkpoint;
     * `clean`: already restored when the previous run was released; `ready`: used as is.
     */
    action: 'setup' | 'restore' | 'clean' | 'ready';
    setupMs?: number;
    restoreMs?: number;
}

/**
 * The Sprite was used (it carries a setup stamp) but has no clean checkpoint
 * to start from: its filesystem may hold an earlier run's workspace or
 * credentials, so it must be replaced rather than provisioned and checkpointed as it is.
 */
export class SpriteBaselineUnknownError extends Error {
    constructor(sprite: string, readonly reason: string) {
        super(`Sprite ${sprite} has no clean baseline: ${reason}`);
        this.name = 'SpriteBaselineUnknownError';
    }
}

async function findSetupCheckpoint(sprite: SpriteLike, comment: string) {
    return (await sprite.listCheckpoints()).find(candidate => candidate.comment === comment);
}

async function restoreTo(sprite: SpriteLike, checkpoint: { id: string }): Promise<number> {
    const started = Date.now();
    await drain(await sprite.restoreCheckpoint(checkpoint.id), `Restoring Sprite ${sprite.name} to checkpoint ${checkpoint.id}`);
    return Date.now() - started;
}

/**
 * Bring the Sprite to the clean, provisioned state of this setup revision.
 * Setup only ever runs on a filesystem no run has used since its baseline: a
 * Sprite that was never provisioned, or one restored to the clean checkpoint
 * of the revision it was provisioned for, so a new revision's checkpoint never
 * captures an earlier run's data. A used Sprite without such a checkpoint
 * throws {@link SpriteBaselineUnknownError} (with checkpoints disabled, nothing is checkpointed).
 */
export async function prepareSprite(sprite: SpriteLike, bundle: SpritesSetupBundle, config: Pick<SpritesRuntimeConfig, 'restoreCheckpoint'>): Promise<SpriteProvisioning> {
    const comment = `${SETUP_CHECKPOINT_PREFIX}${bundle.hash}`;
    // Consumed whatever happens next, so a marker never outlives the run that follows it.
    const marker = await takeCleanMarker(sprite);
    const stamp = await readStamp(sprite);
    if (stamp === bundle.hash) {
        if (!config.restoreCheckpoint) return { action: 'ready' };
        if (marker === comment) return { action: 'clean' };
        const checkpoint = await findSetupCheckpoint(sprite, comment);
        if (!checkpoint) throw new SpriteBaselineUnknownError(sprite.name, `it is provisioned for ${bundle.hash} but its clean checkpoint is missing`);
        return { action: 'restore', restoreMs: await restoreTo(sprite, checkpoint) };
    }
    let restoreMs: number | undefined;
    if (stamp !== undefined && config.restoreCheckpoint) {
        // Provisioned for an earlier revision: start from that revision's clean baseline, never from what its last run left.
        const previous = `${SETUP_CHECKPOINT_PREFIX}${stamp}`;
        if (marker !== previous) {
            const checkpoint = await findSetupCheckpoint(sprite, previous);
            if (!checkpoint) throw new SpriteBaselineUnknownError(sprite.name, `it is provisioned for ${stamp}, which has no clean checkpoint to upgrade from`);
            restoreMs = await restoreTo(sprite, checkpoint);
            if (await readStamp(sprite) !== stamp) throw new SpriteBaselineUnknownError(sprite.name, `its checkpoint ${checkpoint.id} is not the clean baseline of ${stamp}`);
        }
    }
    const started = Date.now();
    await runSetup(sprite, bundle);
    if (await readStamp(sprite) !== bundle.hash) throw new Error(`Sprite ${sprite.name} setup did not record revision ${bundle.hash}`);
    const setupMs = Date.now() - started;
    if (config.restoreCheckpoint) await drain(await sprite.createCheckpoint(comment), `Checkpointing Sprite ${sprite.name}`);
    logger.info({ sprite: sprite.name, setup: bundle.hash, previous: stamp, pins: bundle.pins, setupMs }, 'Provisioned Sprite for agent runs');
    return { action: 'setup', setupMs, ...(restoreMs !== undefined ? { restoreMs } : {}) };
}

export function spriteName(config: SpritesRuntimeConfig, slot: number): string {
    return spriteNameForSlot(config, slot);
}
