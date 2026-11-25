import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SpriteInventory, spriteGone } from './spritesInventory.js';
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

export type SpriteClient = Pick<SpritesClient, 'createSprite' | 'deleteSprite'> & Partial<Pick<SpritesClient, 'listAllSprites' | 'getSprite'>>;
export type Slot = { sprite: Sprite; lease?: AbortSignal; checkpoint: string; provisioningMs: number; restoreMs: number; restricted?: { policy: NetworkPolicy; run: string; recordDiagnostic: (message: string) => void } };

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
    constructor(private readonly client: SpriteClient, private readonly inventory?: SpriteInventory) {
        inventory?.start(async () => {
            const idle = this.idle.pop();
            if (idle) await this.discard(idle.sprite);
        });
    }

    private async provision(signal: AbortSignal, name: string): Promise<Slot> {
        // Never discover or adopt a machine by name. Another worker, including an earlier
        // incarnation of this worker, can still have a live run on one it created.
        const started = Date.now();
        const creating = Promise.resolve().then(async () => {
            signal.throwIfAborted();
            this.inventory?.checkCreate(name);
            const created = await this.client.createSprite(name);
            if (this.inventory && created.name !== name) throw new Error('Provider returned an unexpected Sprite name');
            return created;
        });
        let sprite: Sprite;
        try { sprite = await startupStep(signal, () => creating); }
        catch (error) {
            if (signal.aborted) void creating.then(late => this.discard(late), () => this.inventory?.stopRenewing(name)).catch(() => {});
            else this.inventory?.stopRenewing(name);
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
            const restoring = Date.now();
            await step(async () => complete(await sprite.restoreCheckpoint(checkpoint.id)));
            return { sprite, lease: this.inventory?.signal(name), checkpoint: checkpoint.id, provisioningMs: restoring - started, restoreMs: Date.now() - restoring };
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
            const timeout = AbortSignal.timeout(60_000);
            await startupStep(timeout, async () => {
                if (this.inventory) await this.inventory.deleteOwned(sprite.name, timeout);
                else await this.client.deleteSprite(sprite.name);
            });
        } catch (error) {
            if (this.inventory || !spriteGone(error)) {
                await this.inventory?.finish(sprite.name, 'abandon');
                logger.error({ sprite: sprite.name }, 'Could not delete Sprite');
                throw error;
            }
        }
        await this.inventory?.finish(sprite.name, 'gone');
    }

    private provisionForPool(name: string) {
        const lease = this.inventory?.signal(name);
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(21 * 60_000), ...(lease ? [lease] : [])]);
        const work = this.provision(signal, name);
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work)).catch(() => {});
        return work;
    }

    private async transition(slot: Slot, phase: 'idle' | 'inUse') {
        if (slot.lease?.aborted) return false;
        try { return !this.inventory || await this.inventory.phase(slot.sprite.name, phase); }
        catch (error) {
            await this.discard(slot.sprite);
            throw error;
        }
    }

    private async recycleClean(slot: Slot) {
        if (this.closed) await this.discard(slot.sprite);
        else if (await this.transition(slot, 'idle')) {
            if (this.closed) await this.discard(slot.sprite);
            else this.idle.push(slot);
        }
    }

    async acquire(signal: AbortSignal, onWaiting?: () => void): Promise<Slot> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        signal = AbortSignal.any([signal, this.shutdown.signal]);
        let waiting = false;
        for (;;) {
            signal.throwIfAborted();
            let slot = this.idle.pop();
            const replacement = !slot && this.replacements.shift();
            if (replacement) {
                try { slot = await this.claim(replacement, signal); }
                catch {
                    signal.throwIfAborted();
                    // A speculative replacement failed. Give this run its own provisioning attempt.
                }
            }
            if (!slot) {
                const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
                if (this.inventory && !await this.inventory.reserve(name)) {
                    if (!waiting) onWaiting?.();
                    waiting = true;
                    await delay(1000, undefined, { signal });
                    continue;
                }
                if (signal.aborted) {
                    await this.inventory?.finish(name, 'gone'); // No create request was sent.
                    signal.throwIfAborted();
                }
                slot = await this.claim(this.provisionForPool(name), signal);
            }
            if (!await this.transition(slot, 'inUse') || slot.lease?.aborted) continue;
            if (signal.aborted) {
                await this.recycleClean(slot);
                signal.throwIfAborted();
            }
            return slot;
        }
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
        await this.inventory?.close();
    }

    private async replaceInBackground() {
        const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
        if (this.inventory && !await this.inventory.reserve(name, true)) return;
        if (this.closed) {
            await this.inventory?.finish(name, 'gone');
            return;
        }
        const work = this.provisionForPool(name);
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
        if (!this.closed) await this.replaceInBackground();
    }

    async release(slot: Slot, commit?: () => Promise<void>): Promise<void> {
        slot.lease?.throwIfAborted();
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
            slot.lease?.throwIfAborted();
            await commit?.();
        } finally {
            await this.reset(slot);
        }
    }

    private async reset(slot: Slot): Promise<void> {
        const { sprite, checkpoint, restricted } = slot;
        if (this.closed) return this.discard(sprite);
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000), ...(slot.lease ? [slot.lease] : [])]);
        let step = 'restart';
        let restoreMs: number;
        try {
            // Stop descendants that outlived the launcher, including detached processes.
            await restart(sprite, signal);
            step = 'wipe /tmp';
            await startupStep(signal, () => sprite.execFile('sudo', ['-n', 'find', '/tmp', '-xdev', '-mindepth', '1', '-delete'], { cwd: '/', signal, timeout: 60_000 }));
            step = 'restore checkpoint';
            const restoring = Date.now();
            await startupStep(signal, async () => complete(await sprite.restoreCheckpoint(checkpoint)));
            restoreMs = Date.now() - restoring;
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
        await this.recycleClean({ sprite, lease: slot.lease, checkpoint, provisioningMs: 0, restoreMs });
    }
}

async function restart(sprite: Sprite, signal: AbortSignal) {
    const bootId = async (attempt: AbortSignal) => {
        const probe = await startupStep(attempt, () => sprite.execFile('cat', ['/proc/sys/kernel/random/boot_id'], { cwd: '/', signal: attempt, timeout: 5000 }));
        const id = probe.stdout.toString().trim();
        if (probe.exitCode !== 0 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Missing Sprite boot ID');
        return id.toLowerCase();
    };
    const before = await bootId(signal);
    const ambiguous = /restart[ _-]+outcome[ _-]+unknown/i;
    try {
        await startupStep(signal, () => sprite.restart());
    } catch (error) {
        if (!(error instanceof Error && ambiguous.test(error.message))) throw error;
    }
    const until = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    for (;;) {
        try {
            const attempt = AbortSignal.any([until, AbortSignal.timeout(5000)]);
            if (await bootId(attempt) !== before) return;
        } catch {
            until.throwIfAborted();
        }
        await delay(1000, undefined, { signal: until });
    }
}
