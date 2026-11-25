import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sprite, SpritesClient, StreamMessage } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import type { SpriteCreateOutcome } from './spritesPoolState.js';

const projectRoot = () => process.env.PROPR_ROOT
    || (existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
const pinNames = ['CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512'] as const;
export type SpritesCliPins = Record<typeof pinNames[number], string>;

const pinsByRoot = new Map<string, SpritesCliPins>();

export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    const cached = pinsByRoot.get(root);
    if (cached) return cached;
    const pins = Object.freeze(loadSpritesCliPins(root));
    pinsByRoot.set(root, pins);
    return pins;
}

function loadSpritesCliPins(root: string): SpritesCliPins {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile.agent'), 'utf8');
    return Object.fromEntries(pinNames.map(name => {
        const value = new RegExp(`^ARG ${name}=([a-zA-Z0-9.+_-]+)$`, 'm').exec(dockerfile)?.[1];
        if (!value) throw new Error(`Missing ${name} pin in Dockerfile.agent`);
        return [name, value];
    })) as SpritesCliPins;
}

export type SpriteClient = Pick<SpritesClient, 'createSprite' | 'deleteSprite' | 'getSprite' | 'sprite' | 'listAllSprites'>;

export const PROVIDER_TIMEOUT_MS = 60_000;
export const createLabel = (leaseId: string) => `propr-create-${leaseId}`;

/** Deletes a Sprite; one that is already gone counts as deleted. */
export async function deleteSprite(client: SpriteClient, name: string, signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)): Promise<void> {
    try { await startupStep(signal, () => client.deleteSprite(name)); }
    catch (error) {
        signal.throwIfAborted();
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
}

/** A missing Sprite is conclusive only after its create request has settled. */
export async function inspectSpriteReservation(client: SpriteClient, reservation: { name: string; pendingCreate?: string }, signal: AbortSignal) {
    try {
        const sprite = await startupStep(signal, () => client.getSprite(reservation.name));
        if (reservation.pendingCreate && sprite.labels?.includes(createLabel(reservation.pendingCreate))) return 'created';
    } catch (error) {
        signal.throwIfAborted();
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        if (!reservation.pendingCreate) return 'missing';
    }
}

// The launcher changes the root-owned result directory from 0700 to 0711 after
// the transport exits. Files can also be durable before that final chmod.
const INSPECT_RESULT = `import os, stat
directory = "/opt/propr/result"
try:
    entries = os.listdir(directory)
except FileNotFoundError:
    print("absent")
else:
    active = stat.S_IMODE(os.stat(directory).st_mode) == 0o700
    print("absent" if active and not entries else "keep")
`;

export async function confirmResultAbsent(client: SpriteClient, name: string, parentSignal?: AbortSignal): Promise<boolean> {
    try {
        const timeout = AbortSignal.timeout(30_000);
        const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
        const inspection = await startupStep(signal, () => client.sprite(name).execFile('sudo', ['-n', '/usr/bin/python3', '-I', '-c', INSPECT_RESULT],
            { cwd: '/', timeout: 30_000, signal }));
        return inspection.exitCode === 0 && inspection.stdout.toString().trim() === 'absent';
    } catch (error) {
        logger.warn({ sprite: name, error: String(error) }, 'Could not inspect Sprite for a result');
        return false;
    }
}

/** Stop waiting for SDK operations that do not accept a signal. The caller owns any late resource. */
export async function startupStep<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([cancelled, operation()]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

/** Record the provider outcome even when the caller's wait ends before the create responds. */
export async function createReservedSprite(client: SpriteClient, request: { name: string; labels: string[] }, signal: AbortSignal,
    reservation: { record(outcome: SpriteCreateOutcome): Promise<boolean>; discard(): Promise<void> }): Promise<Sprite> {
    if (signal.aborted) {
        await reservation.record('not-created');
        signal.throwIfAborted();
    }
    const { name, labels } = request;
    const conflict = (error: unknown) => (error as { statusCode?: number })?.statusCode === 409;
    let creating: Promise<Sprite> | undefined;
    let sprite: Sprite;
    try {
        sprite = await startupStep(signal, () => {
            creating = client.createSprite(name, { labels });
            return creating;
        });
    } catch (error) {
        if (creating && signal.aborted) {
            // A peer may already have identified and reaped this create by its label.
            void creating.then(async () => {
                if (await reservation.record('late')) await reservation.discard();
            }, async failure => {
                if (conflict(failure)) await reservation.record('not-created');
            }).catch(error => logger.warn({ sprite: name, error: String(error) }, 'Could not reconcile late Sprite creation'));
            await reservation.record('pending');
        } else {
            await reservation.record(conflict(error) ? 'not-created' : 'failed');
        }
        throw error;
    }
    if (!await reservation.record('created')) throw new Error('Sprites runner lease lapsed');
    return sprite;
}

export async function restartForReset(client: SpriteClient, sprite: Sprite, resetSignal: AbortSignal) {
    const ambiguous = /restart outcome unknown/i;
    try {
        const result = await startupStep(resetSignal, () => sprite.restart());
        if (!ambiguous.test(result?.message ?? '')) return;
    } catch (error) {
        if (!(error instanceof Error && ambiguous.test(error.message))) throw error;
    }

    const signal = AbortSignal.any([resetSignal, AbortSignal.timeout(60_000)]);
    for (;;) {
        try {
            const current = await startupStep(signal, () => client.getSprite(sprite.name));
            if (current.status === 'running') {
                const probe = await startupStep(signal, () => current.execFile('/bin/true', [], { cwd: '/', timeout: 5000, signal }));
                if (probe.exitCode === 0) return;
            }
        } catch {
            // Status and exec can both fail transiently while the machine restarts.
            signal.throwIfAborted();
        }
        await delay(1000, undefined, { signal });
    }
}

export async function completeCheckpointStream(stream: AsyncIterable<StreamMessage>) {
    let finished = false;
    for await (const message of stream) {
        if (message.type === 'error') throw new Error('Sprite checkpoint operation failed');
        finished = message.type === 'complete';
    }
    if (!finished) throw new Error('Sprite checkpoint operation ended before completion');
}

/** Runs a lease's cleanup after a successful restore and before the pool can reuse the runner. */
export function afterSpriteRestore(sprite: Sprite, afterRestore: () => Promise<void>): Sprite {
    return new Proxy(sprite, {
        get(target, property) {
            if (property === 'restoreCheckpoint') {
                return async (checkpoint: string) => {
                    const stream = await target.restoreCheckpoint(checkpoint);
                    return new Proxy(stream, {
                        get(restore, key) {
                            if (key !== Symbol.asyncIterator) return Reflect.get(restore, key, restore);
                            return async function* () {
                                let finished = false;
                                for await (const message of restore) {
                                    finished = message.type === 'complete';
                                    yield message;
                                }
                                if (finished) await afterRestore();
                            };
                        },
                    });
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** Creates a checkpoint and returns its ID (found by a unique comment). */
export async function createNamedCheckpoint(sprite: Sprite, comment: string, step: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation()): Promise<string> {
    await step(async () => completeCheckpointStream(await sprite.createCheckpoint(comment)));
    const checkpoint = (await step(() => sprite.listCheckpoints())).find(cp => cp.comment === comment && cp.id !== 'Current');
    if (!checkpoint) throw new Error(`Missing Sprite checkpoint "${comment}"`);
    return checkpoint.id;
}

const setupFiles = ['sprites-agent-setup.sh', 'sprites-launcher.py', 'gh-wrapper.sh',
    'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh'];
export function readSpriteSetup(root = projectRoot()) {
    const pins = loadSpritesCliPins(root);
    const files = setupFiles.map(name => ({ name, contents: readFileSync(path.join(root, 'scripts', name), 'utf8') }));
    const fingerprint = createHash('sha256').update(JSON.stringify({ pins, files })).digest('hex');
    return { pins, files, fingerprint };
}

export const CLEAN_CHECKPOINT_COMMENT = 'propr clean setup';

/**
 * Installs the pinned CLIs and launcher on a new Sprite and takes its clean
 * checkpoint. Throws (with the setup's stderr tail) on failure; the caller owns
 * the Sprite either way.
 */
export async function setupSprite(sprite: Sprite, signal: AbortSignal, setup: ReturnType<typeof readSpriteSetup>): Promise<string> {
    try {
        const step = <T>(operation: () => Promise<T>) => startupStep(signal, operation);
        const fs = sprite.filesystem();
        const dir = '/var/tmp/propr-setup';
        await step(() => fs.mkdir(dir, { mode: 0o700 }));
        for (const file of setup.files) {
            await step(() => fs.writeFile(dir + '/' + file.name, file.contents));
        }
        const pins = Object.entries(setup.pins).map(([name, value]) => `${name}=${value}`);
        await step(() => sprite.execFile('sudo', ['-n', 'env', ...pins, '/bin/bash', dir + '/sprites-agent-setup.sh', dir], { signal, timeout: 20 * 60_000 }));
        await step(() => fs.rm(dir, { recursive: true }));
        const checkpoint = await createNamedCheckpoint(sprite, CLEAN_CHECKPOINT_COMMENT, step);
        await step(async () => completeCheckpointStream(await sprite.restoreCheckpoint(checkpoint)));
        return checkpoint;
    } catch (cause) {
        const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr).slice(-4096).trim() : '';
        const detail = stderr || (cause instanceof Error ? cause.message : String(cause));
        throw new Error(`Failed to provision the clean Sprite checkpoint: ${detail}`, { cause });
    }
}

/** Where a runner keeps its root-owned warm clone reference (one repository at a time). */
export const SPRITES_WARM_ROOT = '/var/lib/propr/warm';
const CARRY_DIR = '/tmp/propr-warm-carry';

export function warmClonePath(repo: string): string {
    if (!/^[a-f0-9]{8,64}$/.test(repo)) throw new Error('Invalid warm clone key');
    return `${SPRITES_WARM_ROOT}/${repo}.git`;
}

// /tmp is not covered by checkpoints: the reference waits there while the clean checkpoint is restored.
const CARRY_SCRIPT = `set -eu
ref="$1"; carry="$2"
[ -d "$ref/objects" ] && [ "$(stat -c %u "$ref")" = 0 ] || exit 0
rm -rf "$carry"; mkdir -m 700 "$carry"
mv "$ref" "$carry/repo.git"
echo carried`;
const INSTALL_SCRIPT = `set -eu
ref="$1"; carry="$2"; root="$3"
mkdir -p -m 700 "$root"
find "$root" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
mv "$carry/repo.git" "$ref"
chown -R 0:0 "$ref"; chmod 700 "$ref"
rmdir "$carry"`;

/** Moves the run's refreshed warm clone reference out of the checkpointed disk; false when the run left none. */
export async function carryWarmClone(sprite: Sprite, repo: string): Promise<boolean> {
    const { stdout } = await sprite.execFile('sudo', ['-n', '/bin/bash', '-c', CARRY_SCRIPT, 'carry', warmClonePath(repo), CARRY_DIR], { cwd: '/', timeout: 300_000 });
    return String(stdout).trim() === 'carried';
}

/** After the clean restore: puts the carried reference back and checkpoints that as the runner's warm baseline. */
export async function installWarmClone(sprite: Sprite, repo: string): Promise<{ repo: string; checkpoint: string }> {
    await sprite.execFile('sudo', ['-n', '/bin/bash', '-c', INSTALL_SCRIPT, 'install', warmClonePath(repo), CARRY_DIR, SPRITES_WARM_ROOT], { cwd: '/', timeout: 300_000 });
    const checkpoint = await createNamedCheckpoint(sprite, `propr warm ${repo} ${randomUUID().slice(0, 8)}`);
    return { repo, checkpoint };
}
