import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import type { Sprite, SpritesClient, StreamMessage } from '@fly/sprites';
import { applySpriteNetworkPolicy, OPEN_SPRITE_NETWORK_POLICY } from './spritesNetwork.js';

const projectRoot = () => process.env.PROPR_ROOT
    || (existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
const pinNames = ['CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512'] as const;
export type SpritesCliPins = Record<typeof pinNames[number], string>;

export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile.agent'), 'utf8');
    return Object.fromEntries(pinNames.map(name => {
        const value = new RegExp(`^ARG ${name}=([a-zA-Z0-9.+_-]+)$`, 'm').exec(dockerfile)?.[1];
        if (!value) throw new Error(`Missing ${name} pin in Dockerfile.agent`);
        return [name, value];
    })) as SpritesCliPins;
}

export type SpriteClient = Pick<SpritesClient, 'createSprite' | 'deleteSprite'>;
/** `restricted`: a network policy may have been applied, so release must clear it before reuse. */
export type Slot = { sprite: Sprite; checkpoint: string; restricted?: boolean };

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

async function complete(stream: AsyncIterable<StreamMessage>) {
    let finished = false;
    for await (const message of stream) {
        if (message.type === 'error') throw new Error('Sprite checkpoint operation failed');
        finished = message.type === 'complete';
    }
    if (!finished) throw new Error('Sprite checkpoint operation ended before completion');
}

const setupFiles = ['sprites-agent-setup.sh', 'sprites-launcher.py', 'gh-wrapper.sh',
    'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh'];

export class SpritePool {
    private idle: Slot[] = [];
    private closed = false;
    constructor(private readonly client: SpriteClient) {}

    private async provision(signal = new AbortController().signal): Promise<Slot> {
        // Never discover or adopt a machine by name. Another worker, including an earlier
        // incarnation of this worker, can still have a live run on one it created.
        const sprite = await this.client.createSprite(`propr-${randomUUID()}`);
        logger.info({ sprite: sprite.name }, 'Worker created Sprite');
        try {
            const step = <T>(operation: () => Promise<T>) => startupStep(signal, operation);
            const fs = sprite.filesystem();
            const dir = '/var/tmp/propr-setup';
            await step(() => fs.mkdir(dir, { mode: 0o700 }));
            for (const file of setupFiles) {
                await step(() => fs.writeFile(dir + '/' + file, readFileSync(path.join(projectRoot(), 'scripts', file))));
            }
            const pins = Object.entries(readSpritesCliPins()).map(([name, value]) => `${name}=${value}`);
            await step(() => sprite.execFile('sudo', ['-n', 'env', ...pins, '/bin/bash', dir + '/sprites-agent-setup.sh', dir], { signal, timeout: 20 * 60_000 }));
            await step(() => fs.rm(dir, { recursive: true }));
            const comment = 'propr clean setup';
            await step(async () => complete(await sprite.createCheckpoint(comment)));
            const checkpoint = (await step(() => sprite.listCheckpoints())).find(cp => cp.comment === comment && cp.id !== 'Current');
            if (!checkpoint) throw new Error('Missing clean Sprite checkpoint');
            await step(async () => complete(await sprite.restoreCheckpoint(checkpoint.id)));
            return { sprite, checkpoint: checkpoint.id };
        } catch (cause) {
            const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr).slice(-4096).trim() : '';
            const detail = stderr || (cause instanceof Error ? cause.message : String(cause));
            const failure = new Error(`Failed to provision the clean Sprite checkpoint: ${detail}`, { cause });
            try {
                await this.discard(sprite);
            } catch (cleanupError) {
                throw new AggregateError([failure, cleanupError], `${failure.message} (also failed to delete Sprite ${sprite.name})`);
            }
            signal.throwIfAborted();
            throw failure;
        }
    }

    async discard(sprite: Sprite): Promise<void> {
        try {
            await this.client.deleteSprite(sprite.name);
        } catch (error) {
            logger.error({ sprite: sprite.name }, 'Could not delete Sprite');
            throw error;
        }
    }

    async acquire(signal: AbortSignal): Promise<Slot> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        return this.idle.pop() ?? this.provision(signal);
    }

    async close(): Promise<void> {
        this.closed = true;
        // discard logs the Sprite name for manual cleanup if deletion fails.
        await Promise.allSettled(this.idle.splice(0).map(slot => this.discard(slot.sprite)));
    }

    async release(slot: Slot): Promise<void> {
        if (this.closed) return this.discard(slot.sprite);
        try {
            // Stop descendants that outlived the launcher, including detached processes.
            await slot.sprite.restart();
            await slot.sprite.execFile('sudo', ['-n', 'find', '/tmp', '-xdev', '-mindepth', '1', '-delete'], { cwd: '/', timeout: 60_000 });
            await complete(await slot.sprite.restoreCheckpoint(slot.checkpoint));
            if (slot.restricted) {
                // A restart can relaunch run-installed services. Keep them confined
                // until the checkpoint stream confirms the clean state is restored.
                await applySpriteNetworkPolicy(slot.sprite, OPEN_SPRITE_NETWORK_POLICY);
                slot = { sprite: slot.sprite, checkpoint: slot.checkpoint };
            }
        } catch {
            await this.discard(slot.sprite);
            if (this.closed) return;
            slot = await this.provision();
        }
        if (this.closed) await this.discard(slot.sprite);
        else this.idle.push(slot);
    }
}
