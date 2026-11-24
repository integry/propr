import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import type { SpritesRuntimeConfig } from './spritesConfig.js';
import { drainSpriteStream, execOnSprite, type SpriteLike, type SpritesClientLike } from './spritesSdk.js';

/**
 * Provisioning: what turns a new Sprite into the clean state every run starts
 * from. `scripts/sprites-agent-setup.sh` installs the pinned CLIs, the
 * unprivileged agent user, the entrypoints and the launcher; the Sprite is
 * then checkpointed. That checkpoint is the only state a run ever starts on.
 */

export const SPRITES_SETUP_SCRIPT = 'sprites-agent-setup.sh';
/** Copied to the Sprite for setup, from `scripts/`. */
export const SPRITES_SETUP_FILES: readonly string[] = Object.freeze([
    SPRITES_SETUP_SCRIPT, 'sprites-launcher.sh', 'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh', 'gh-wrapper.sh',
]);
/** Where the worker uploads the setup files on a new Sprite (nothing agent-controlled has run there yet); setup removes it. */
export const SPRITES_SETUP_UPLOAD_DIR = '/tmp/propr-sprites-setup';
export const SPRITES_LAUNCHER = '/opt/propr/launcher.sh';
/** The one run directory of a Sprite: empty in the clean checkpoint, readable only by the filesystem API's user and root. */
export const SPRITES_RUN_DIR = '/opt/propr/run';
export const SPRITES_ENTRYPOINT_DIR = '/opt/propr/entrypoints';
export const SPRITES_BIN_DIR = '/opt/propr/bin';
/**
 * A Sprite's `/tmp` is a separate disk: a checkpoint restore does not reset it
 * (verified on real Sprites; `/home`, `/var/tmp` and the rest of the root are).
 * So nothing of a run is put there. This directory, on the checkpointed root,
 * is the run's `TMPDIR` and holds Antigravity's disposable HOME; the launcher
 * empties `/tmp` itself before every restore ({@link restoreCleanCheckpoint}).
 */
export const SPRITES_SCRATCH_DIR = '/var/lib/propr/run';
/** Not covered by a Sprite's checkpoint. */
export const SPRITES_UNCHECKPOINTED_TMP = '/tmp';
const SETUP_TIMEOUT_MS = 20 * 60_000;
const SCRUB_TIMEOUT_MS = 5 * 60_000;
const CHECKPOINT_COMMENT_PREFIX = 'propr-clean ';

/** CLI pins the setup script installs: the `propr/agent` image's own `ARG`s, so both runtimes run the same CLIs. */
export interface SpritesCliPins {
    CLAUDE_CLI_VERSION: string;
    CODEX_CLI_VERSION: string;
    ANTIGRAVITY_CLI_VERSION: string;
    ANTIGRAVITY_CLI_RELEASE_ID: string;
    ANTIGRAVITY_CLI_SHA512: string;
}

const PIN_NAMES: ReadonlyArray<keyof SpritesCliPins> = [
    'CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512',
];
const PIN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export function projectRoot(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.PROPR_ROOT
        || (fs.existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
}

/** The pins as `Dockerfile.agent` declares them. A missing or malformed pin is an error: a Sprite never runs an unpinned CLI. */
export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    const file = path.join(root, 'Dockerfile.agent');
    let dockerfile: string;
    try { dockerfile = fs.readFileSync(file, 'utf8'); } catch (error) {
        throw new Error(`The Sprites agent runtime reads its CLI pins from ${file} (set PROPR_ROOT): ${(error as Error).message}`);
    }
    const pins = {} as SpritesCliPins;
    for (const name of PIN_NAMES) {
        const value = new RegExp(`^ARG ${name}=(\\S+)\\s*$`, 'm').exec(dockerfile)?.[1];
        if (!value || !PIN_PATTERN.test(value)) throw new Error(`${file} does not pin ${name}; the Sprites agent runtime installs only pinned CLIs`);
        pins[name] = value;
    }
    return pins;
}

export interface SpritesSetupBundle {
    files: Array<{ name: string; content: Buffer }>;
    pins: SpritesCliPins;
    /** Changes with any setup file or pin: a Sprite provisioned for another hash is replaced. */
    hash: string;
}

export function readSpritesSetupBundle(root = projectRoot()): SpritesSetupBundle {
    const pins = readSpritesCliPins(root);
    const hash = createHash('sha256');
    const files = SPRITES_SETUP_FILES.map(name => {
        const file = path.join(root, 'scripts', name);
        let content: Buffer;
        try { content = fs.readFileSync(file); } catch (error) {
            throw new Error(`The Sprites agent runtime needs ${file} (set PROPR_ROOT): ${(error as Error).message}`);
        }
        hash.update(name).update('\0').update(content).update('\0');
        return { name, content };
    });
    hash.update(JSON.stringify(pins));
    return { files, pins, hash: hash.digest('hex').slice(0, 16) };
}

/** What the worker remembers of a provisioned Sprite: which checkpoint is its clean one. */
export interface SpriteCleanState {
    /** The Sprite the checkpoint belongs to (a recreated Sprite numbers its checkpoints from the start again). */
    spriteId: string;
    checkpointId: string;
    setupHash: string;
}

function tail(text: string): string {
    return text.trim().split('\n').slice(-20).join('\n');
}

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

/**
 * Sets up a NEW Sprite and checkpoints it. Only ever called on a Sprite this
 * worker just created: the checkpoint must not capture anything a run left.
 */
export async function provisionSprite(sprite: SpriteLike, bundle: SpritesSetupBundle): Promise<SpriteCleanState> {
    const filesystem = sprite.filesystem();
    await filesystem.mkdir(SPRITES_SETUP_UPLOAD_DIR, { recursive: true, mode: 0o700 });
    for (const file of bundle.files) {
        await filesystem.writeFile(path.posix.join(SPRITES_SETUP_UPLOAD_DIR, file.name), file.content, { mode: 0o755 });
    }
    const pins = PIN_NAMES.map(name => `${name}=${bundle.pins[name]}`);
    const result = await execOnSprite(sprite, 'sudo', [
        '-n', 'env', ...pins, `PROPR_SPRITES_SETUP_HASH=${bundle.hash}`,
        'bash', path.posix.join(SPRITES_SETUP_UPLOAD_DIR, SPRITES_SETUP_SCRIPT), SPRITES_SETUP_UPLOAD_DIR,
    ], { timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error(`Sprite ${sprite.name} setup failed (exit ${result.exitCode}): ${tail(result.stderr)}`);
    const comment = `${CHECKPOINT_COMMENT_PREFIX}${bundle.hash}`;
    await drainSpriteStream(await sprite.createCheckpoint(comment), `Checkpointing Sprite ${sprite.name}`);
    // No run has started on this Sprite yet, so its checkpoint list holds only what the worker created.
    const checkpoints = (await sprite.listCheckpoints()).filter(candidate => candidate.comment === comment);
    const checkpoint = checkpoints.sort((left, right) => (right.createTime?.getTime() ?? 0) - (left.createTime?.getTime() ?? 0))[0];
    if (!checkpoint) throw new Error(`Sprite ${sprite.name} has no clean checkpoint after setup`);
    return { spriteId: sprite.id ?? '', checkpointId: checkpoint.id, setupHash: bundle.hash };
}

/**
 * Brings a Sprite back to its clean state: the launcher's `scrub` empties
 * `/tmp` (which the checkpoint does not cover) once no process of the agent
 * user is left, then the checkpoint is restored. A Sprite whose `/tmp` could
 * not be emptied is not restored: the error has the caller destroy it.
 */
export async function restoreCleanCheckpoint(sprite: SpriteLike, state: SpriteCleanState): Promise<void> {
    const scrubbed = await execOnSprite(sprite, 'sudo', ['-n', '/bin/bash', SPRITES_LAUNCHER, 'scrub'], { timeout: SCRUB_TIMEOUT_MS });
    if (scrubbed.exitCode !== 0) {
        throw new Error(`Sprite ${sprite.name} could not empty ${SPRITES_UNCHECKPOINTED_TMP}, which its checkpoint does not cover (exit ${scrubbed.exitCode}): ${tail(scrubbed.stderr)}`);
    }
    await drainSpriteStream(await sprite.restoreCheckpoint(state.checkpointId), `Restoring Sprite ${sprite.name} to its clean checkpoint ${state.checkpointId}`);
}
