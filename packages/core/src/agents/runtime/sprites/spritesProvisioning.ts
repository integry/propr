import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SpriteInventory, spriteGone } from './spritesInventory.js';
import path from 'node:path';
import { calculateDelay } from '../../../utils/retryHandler.js';
import logger from '../../../utils/logger.js';
import type { NetworkPolicy, Sprite, SpritesClient, StreamMessage } from '@fly/sprites';
import { sameSpriteNetworkPolicy, OPEN_SPRITE_NETWORK_POLICY } from './spritesNetwork.js';
import { installSpritePackageServers } from './spritesPackageServers.js';
import { packageServersDigest, type RemotePackageInstall } from '../../../extensions/remotePackageServers.js';

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
export type Slot = { sprite: Sprite; lease?: AbortSignal; checkpoint: string; provisioningMs: number; restoreMs: number;
    /** Digest of the package MCP servers in the clean checkpoint; only a run needing exactly these servers uses the Sprite. */
    packageServersDigest: string;
    /** Those servers, so a replacement for this Sprite is provisioned with the same set. */
    packages?: RemotePackageInstall;
    /** Time installing those servers took while provisioning this slot; absent on recycled slots and without servers. */
    packageServerInstallMs?: number;
    restricted?: { policy: NetworkPolicy; run: string; recordDiagnostic: (message: string) => void } };

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

const setupFiles = ['sprites-agent-setup.sh', 'sprites-launcher.py', 'gh-wrapper.sh', 'extension-stdio-bridge.mjs',
    'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh'];

export class SpritePool {
    private idle: Slot[] = [];
    private readonly shutdown = new AbortController();
    private readonly pending = new Set<Promise<Slot>>();
    private readonly releases = new Set<Promise<void>>();
    /** Background replacements, each for the package server set of the Sprite it replaces. */
    private readonly replacements: { work: Promise<Slot>; digest: string }[] = [];
    private get closed() { return this.shutdown.signal.aborted; }
    constructor(private readonly client: SpriteClient, private readonly inventory?: SpriteInventory) {
        inventory?.start(async () => {
            // Another worker is waiting at the cap: yield the least recently used idle Sprite.
            const idle = this.idle.shift();
            if (idle) await this.discard(idle.sprite);
        });
    }

    private async provision(signal: AbortSignal, name: string, packages: RemotePackageInstall | undefined): Promise<Slot> {
        // Never discover or adopt a machine by name. Another worker, including an earlier
        // incarnation of this worker, can still have a live run on one it created.
        const started = Date.now();
        try {
            signal.throwIfAborted();
            this.inventory?.checkCreate(name);
        } catch (error) {
            await this.inventory?.finish(name, 'gone');
            throw error;
        }
        const creating = (async () => {
            const created = await this.client.createSprite(name);
            if (this.inventory && created.name !== name) throw new Error('Provider returned an unexpected Sprite name');
            return created;
        })();
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
            // Package MCP servers go into the clean checkpoint, like the agent CLIs.
            const packageServerInstallMs = await installSpritePackageServers({ sprite, dir, install: packages, step, signal });
            await step(() => fs.rm(dir, { recursive: true }));
            const comment = 'propr clean setup';
            await step(async () => complete(await sprite.createCheckpoint(comment)));
            const checkpoint = (await step(() => sprite.listCheckpoints())).find(cp => cp.comment === comment && cp.id !== 'Current');
            if (!checkpoint) throw new Error('Missing clean Sprite checkpoint');
            const restoring = Date.now();
            await step(async () => complete(await sprite.restoreCheckpoint(checkpoint.id)));
            return { sprite, lease: this.inventory?.signal(name), checkpoint: checkpoint.id, packageServersDigest: packageServersDigest(packages?.servers),
                ...(packages?.servers.length ? { packages } : {}),
                ...(packageServerInstallMs !== undefined && { packageServerInstallMs }), provisioningMs: restoring - started, restoreMs: Date.now() - restoring };
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

    private provisionForPool(name: string, packages: RemotePackageInstall | undefined) {
        const lease = this.inventory?.signal(name);
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(32 * 60_000), ...(lease ? [lease] : [])]);
        const work = this.provision(signal, name, packages);
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

    private async checkOut(slot: Slot) {
        if (await this.transition(slot, 'inUse') && !slot.lease?.aborted) return true;
        if (slot.lease?.aborted) await this.inventory?.finish(slot.sprite.name, 'abandon');
        else await this.discard(slot.sprite);
        return false;
    }

    /** The most recently used idle Sprite built for this package server set. */
    private takeIdle(digest: string) {
        const index = this.idle.findLastIndex(slot => slot.packageServersDigest === digest);
        return index < 0 ? undefined : this.idle.splice(index, 1)[0];
    }

    /**
     * At the cap, make room by deleting the least recently used idle Sprite built
     * for another package server set. Sprites for other sets are otherwise kept
     * warm for the runs that need them.
     */
    private async evictForCap(digest: string) {
        const index = this.idle.findIndex(slot => slot.packageServersDigest !== digest);
        if (index < 0) return false;
        const [slot] = this.idle.splice(index, 1);
        logger.info({ sprite: slot.sprite.name, packageServersDigest: slot.packageServersDigest, wanted: digest },
            'Sprite pool at its cap; deleting the least recently used idle Sprite built for other package MCP servers');
        await this.discard(slot.sprite).catch(() => {
            logger.warn({ sprite: slot.sprite.name }, 'Could not delete an idle Sprite built for other package MCP servers');
        });
        return true;
    }

    /** A clean Sprite whose checkpoint has exactly the run's package MCP servers installed. */
    async acquire(signal: AbortSignal, onWaiting?: () => void, packages?: RemotePackageInstall): Promise<Slot & { queueMs: number }> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        const digest = packageServersDigest(packages?.servers);
        signal = AbortSignal.any([signal, this.shutdown.signal]);
        const inventory = this.inventory;
        const minutes = inventory?.queueMinutes ?? 10;
        const timeout = () => new Error(`No Sprite available: cap ${inventory?.cap} reached after ${minutes}m`);
        const started = Date.now();
        const deadline = performance.now() + minutes * 60_000;
        let attempt = 0;
        const elapsedQueueMs = () => attempt ? Date.now() - started : 0;
        const reserveForRun = async (name: string) => {
            if (!inventory) return true;
            const reserving = inventory.reserve(name);
            const admissionSignal = AbortSignal.any([
                signal, AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now()))),
            ]);
            let reserved: boolean;
            try { reserved = await startupStep(admissionSignal, () => reserving); }
            catch (error) {
                if (!admissionSignal.aborted) throw error;
                void reserving.then(ok => ok ? inventory.finish(name, 'gone') : undefined).catch(() => {});
                signal.throwIfAborted();
                throw timeout();
            }
            if (reserved) return true;
            if (await this.evictForCap(digest)) return false;
            if (!attempt) onWaiting?.();
            const backoff = calculateDelay(attempt++, { baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, jitter: true });
            await delay(Math.min(backoff, deadline - performance.now()), undefined, { signal });
            return false;
        };

        for (;;) {
            signal.throwIfAborted();
            if (performance.now() >= deadline) throw timeout();
            // Only a Sprite built for exactly this package server set is reused.
            let slot = this.takeIdle(digest);
            let queueMs = elapsedQueueMs();
            const replacement = !slot && this.takeReplacement(digest);
            if (replacement) {
                try { slot = await this.claim(replacement, signal); }
                catch {
                    signal.throwIfAborted();
                    // A speculative replacement failed. Give this run its own provisioning attempt.
                }
            }
            if (!slot) {
                const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
                if (!await reserveForRun(name)) continue;
                queueMs = elapsedQueueMs();
                if (signal.aborted) {
                    await this.inventory?.finish(name, 'gone'); // No create request was sent.
                    signal.throwIfAborted();
                }
                slot = await this.claim(this.provisionForPool(name, packages), signal);
            }
            if (!await this.checkOut(slot)) continue;
            if (signal.aborted) {
                await this.recycleClean(slot);
                signal.throwIfAborted();
            }
            return { ...slot, queueMs };
        }
    }

    private takeReplacement(digest: string) {
        const index = this.replacements.findIndex(replacement => replacement.digest === digest);
        return index < 0 ? undefined : this.replacements.splice(index, 1)[0].work;
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

    /** Provision a replacement with the package servers of the Sprite it replaces. */
    private async replaceInBackground(packages: RemotePackageInstall | undefined) {
        const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
        if (this.inventory && !await this.inventory.reserve(name, true)) return;
        if (this.closed) {
            await this.inventory?.finish(name, 'gone');
            return;
        }
        const work = this.provisionForPool(name, packages);
        const entry = { work, digest: packageServersDigest(packages?.servers) };
        this.replacements.push(entry);
        const unclaimed = () => {
            const index = this.replacements.indexOf(entry);
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
        if (!this.closed) await this.replaceInBackground(slot.packages);
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
        let signal = AbortSignal.any([this.shutdown.signal, ...(slot.lease ? [slot.lease] : [])]);
        let step = 'restart';
        let restoreMs: number;
        try {
            // Stop descendants that outlived the launcher, including detached processes.
            await restart(sprite, signal);
            signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
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
        await this.recycleClean({ sprite, lease: slot.lease, checkpoint, packageServersDigest: slot.packageServersDigest,
            ...(slot.packages && { packages: slot.packages }), provisioningMs: 0, restoreMs });
    }
}

async function restart(sprite: Sprite, signal: AbortSignal) {
    const probe = async (file: string, parent: AbortSignal) => {
        const attempt = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
        const result = await startupStep(attempt, () => sprite.execFile('cat', [file], { cwd: '/', signal: attempt, timeout: 5000 }));
        if (result.exitCode !== 0) throw new Error('Sprite restart probe failed');
        return result.stdout.toString().trim();
    };
    const bootFile = '/proc/sys/kernel/random/boot_id';
    const id = await probe(bootFile, signal).catch(() => '');
    const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    const useBootId = validId.test(id);
    const started = performance.now();
    for (let request = 0; request < 2; request++) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        try { await startupStep(requestSignal, () => sprite.restart()); }
        catch { signal.throwIfAborted(); } // Even a failed response can accompany a successful restart.
        const until = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        while (!until.aborted) {
            const elapsed = performance.now() - started;
            const value = await probe(useBootId ? bootFile : '/proc/uptime', until).catch(() => '');
            if (useBootId) {
                if (validId.test(value) && value.toLowerCase() !== id.toLowerCase()) return;
            } else {
                // /proc/uptime truncates to hundredths. Require a boot after the first request.
                const uptime = value.split(/\s+/)[0];
                if (/^\d+(?:\.\d+)?$/.test(uptime) && Number(uptime) * 1000 + 10 < elapsed) return;
            }
            await delay(1000, undefined, { signal: until }).catch(error => { if (!until.aborted) throw error; });
        }
        signal.throwIfAborted();
    }
    throw new Error('Could not verify Sprite restart after two attempts');
}
