import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import type { NetworkPolicy, Sprite, SpritesClient, StreamMessage } from '@fly/sprites';
import { sameSpriteNetworkPolicy, OPEN_SPRITE_NETWORK_POLICY } from './spritesNetwork.js';

const projectRoot = () => process.env.PROPR_ROOT
    || (existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
const pinNames = ['CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512'] as const;
export type SpritesCliPins = Record<typeof pinNames[number], string>;

const pinsByRoot = new Map<string, SpritesCliPins>();

export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    const cached = pinsByRoot.get(root);
    if (cached) return cached;
    const dockerfile = readFileSync(path.join(root, 'Dockerfile.agent'), 'utf8');
    const pins = Object.fromEntries(pinNames.map(name => {
        const value = new RegExp(`^ARG ${name}=([a-zA-Z0-9.+_-]+)$`, 'm').exec(dockerfile)?.[1];
        if (!value) throw new Error(`Missing ${name} pin in Dockerfile.agent`);
        return [name, value];
    })) as SpritesCliPins;
    pinsByRoot.set(root, Object.freeze(pins));
    return pins;
}

export type SpriteClient = Pick<SpritesClient, 'createSprite' | 'deleteSprite'>;
export type Slot = { sprite: Sprite; checkpoint: string; restricted?: { policy: NetworkPolicy; run: string; recordDiagnostic: (message: string) => void } };

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
        if (message.type === 'error') throw new Error(message.error || message.data || 'Sprite checkpoint operation failed');
        finished = message.type === 'complete';
    }
    if (!finished) throw new Error('Sprite checkpoint operation ended before completion');
}

const setupFiles = ['sprites-agent-setup.sh', 'sprites-launcher.py', 'gh-wrapper.sh',
    'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh'];

export class SpritePool {
    private idle: Slot[] = [];
    private readonly shutdown = new AbortController();
    private readonly pending = new Set<Promise<Slot>>();
    private readonly releases = new Set<Promise<void>>();
    private readonly replacements: Promise<Slot>[] = [];
    private get closed() { return this.shutdown.signal.aborted; }
    constructor(private readonly client: SpriteClient) {}

    private async provision(signal: AbortSignal): Promise<Slot> {
        // Never discover or adopt a machine by name. Another worker, including an earlier
        // incarnation of this worker, can still have a live run on one it created.
        const creating = this.client.createSprite(`propr-${randomUUID()}`);
        let sprite: Sprite;
        try { sprite = await startupStep(signal, () => creating); }
        catch (error) {
            if (signal.aborted) void creating.then(late => this.discard(late)).catch(() => {});
            throw error;
        }
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
            await startupStep(AbortSignal.timeout(60_000), () => this.client.deleteSprite(sprite.name));
        } catch (error) {
            logger.error({ sprite: sprite.name }, 'Could not delete Sprite');
            throw error;
        }
    }

    private provisionForPool() {
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(21 * 60_000)]);
        const work = this.provision(signal);
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work)).catch(() => {});
        return work;
    }

    private async recycleClean(slot: Slot) {
        if (this.closed) await this.discard(slot.sprite);
        else this.idle.push(slot);
    }

    async acquire(signal: AbortSignal): Promise<Slot> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        const idle = this.idle.pop();
        if (idle) return idle;
        const replacement = this.replacements.shift();
        if (replacement) {
            try { return await this.claim(replacement, signal); }
            catch {
                signal.throwIfAborted();
                this.shutdown.signal.throwIfAborted();
                // A speculative replacement failed. Give this run its own provisioning attempt.
            }
        }
        return this.claim(this.provisionForPool(), signal);
    }

    private async claim(work: Promise<Slot>, signal: AbortSignal) {
        try { return await startupStep(signal, () => work); }
        catch (error) {
            if (signal.aborted) void work.then(slot => this.recycleClean(slot)).catch(() => {});
            throw error;
        }
    }

    async close(): Promise<void> {
        this.shutdown.abort();
        await Promise.allSettled([...this.pending, ...this.releases, ...this.idle.splice(0).map(slot => this.discard(slot.sprite))]);
    }

    private replaceInBackground() {
        const work = this.provisionForPool();
        this.replacements.push(work);
        const unclaimed = () => {
            const index = this.replacements.indexOf(work);
            if (index < 0) return false;
            this.replacements.splice(index, 1);
            return true;
        };
        void work.then(slot => unclaimed() ? this.recycleClean(slot) : undefined, () => {
            if (unclaimed() && !this.closed) logger.warn('Failed to replace discarded Sprite');
        }).catch(() => {});
    }

    releaseInBackground(slot: Slot): void {
        const release = this.release(slot).catch(() => {
            logger.warn({ sprite: slot.sprite.name }, 'Failed to release unused Sprite');
        });
        this.releases.add(release);
        void release.then(() => this.releases.delete(release));
    }

    private async replace(slot: Slot, step: string, error: unknown): Promise<void> {
        logger.warn({ sprite: slot.sprite.name, run: slot.restricted?.run, step, error: error instanceof Error ? error.message : String(error) },
            'Sprite release failed, discarding Sprite');
        await this.discard(slot.sprite);
        if (!this.closed) this.replaceInBackground();
    }

    async release(slot: Slot, commit?: () => Promise<void>): Promise<void> {
        const { sprite, restricted } = slot;
        if (restricted) {
            try {
                const policy = await startupStep(AbortSignal.timeout(60_000), () => sprite.getNetworkPolicy());
                if (!sameSpriteNetworkPolicy(policy, restricted.policy)) {
                    const message = `Network policy mismatch at release for run ${restricted.run} on Sprite ${sprite.name}`;
                    restricted.recordDiagnostic(message);
                    throw new Error(message);
                }
            } catch (error) {
                return this.replace(slot, 'check applied network policy', error);
            }
        }
        try {
            await commit?.();
        } finally {
            await this.reset(slot);
        }
    }

    private async reset(slot: Slot): Promise<void> {
        const { sprite, checkpoint, restricted } = slot;
        if (this.closed) return this.discard(sprite);
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
        let step = 'restart';
        try {
            // Stop descendants that outlived the launcher, including detached processes.
            await startupStep(signal, () => sprite.restart());
            step = 'wipe /tmp';
            await startupStep(signal, () => sprite.execFile('sudo', ['-n', 'find', '/tmp', '-xdev', '-mindepth', '1', '-delete'], { cwd: '/', signal, timeout: 60_000 }));
            step = 'restore checkpoint';
            await startupStep(signal, async () => complete(await sprite.restoreCheckpoint(checkpoint)));
            if (restricted) {
                step = 'clear network policy';
                await startupStep(signal, () => sprite.updateNetworkPolicy(OPEN_SPRITE_NETWORK_POLICY));
                step = 'verify cleared network policy';
                const policy = await startupStep(signal, () => sprite.getNetworkPolicy());
                if (!sameSpriteNetworkPolicy(policy, OPEN_SPRITE_NETWORK_POLICY)) {
                    throw new Error('Sprite did not verify the cleared network policy');
                }
            }
        } catch (error) {
            return this.replace(slot, step, error);
        }
        await this.recycleClean({ sprite, checkpoint });
    }
}
