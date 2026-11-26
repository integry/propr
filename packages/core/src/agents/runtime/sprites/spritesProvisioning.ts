import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SpriteInventory, spriteGone } from './spritesInventory.js';
import path from 'node:path';
import { calculateDelay } from '../../../utils/retryHandler.js';
import logger from '../../../utils/logger.js';
import type { Sprite, SpritesClient, StreamMessage } from '@fly/sprites';
import { projectRoot, readSpritesCliPins } from './spritesCliPins.js';
import { sameSpriteNetworkPolicy, OPEN_SPRITE_NETWORK_POLICY } from './spritesNetwork.js';
import { installSpritePackageServers } from './spritesPackageServers.js';
import { provisionedPackages, slotPoolKey, spritePoolKey, type Slot } from './spritesSlot.js';
import { packageServersDigest, type RemotePackageInstall } from '../../../extensions/remotePackageServers.js';
import { startupStep } from '../startupStep.js';
import { checkAgentRuntimePackagesBeforeInstall } from '../agentRuntimePackageIndex.js';
import { installSpriteRuntimePackages, type SpritePackageSource } from './spritesPackageBase.js';
import { agentRuntimePackagesDigest } from '../agentRuntimePackageProfile.js';

export { startupStep };
export { readSpritesCliPins, type SpritesCliPins } from './spritesCliPins.js';

export type SpriteClient = Pick<SpritesClient, 'createSprite' | 'deleteSprite'> & Partial<Pick<SpritesClient, 'listAllSprites' | 'getSprite'>>;
export type { Slot };

const noPackages: SpritePackageSource = async () => [];

async function complete(stream: AsyncIterable<StreamMessage>) {
    let finished = false;
    for await (const message of stream) {
        if (message.type === 'error') throw new Error(message.error || message.data || 'Sprite checkpoint operation failed');
        finished = message.type === 'complete';
    }
    if (!finished) throw new Error('Sprite checkpoint operation ended before completion');
}

const setupFiles = ['sprites-agent-setup.sh', 'sprites-launcher.py', 'sprites-mcp-forward.sh', 'gh-wrapper.sh', 'extension-stdio-bridge.mjs',
    'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh'];

export class SpritePool {
    private idle: Slot[] = [];
    private readonly shutdown = new AbortController();
    private readonly pending = new Set<Promise<Slot>>();
    private readonly releases = new Set<Promise<void>>();
    /**
     * Background replacements, each for the package server set of the Sprite it replaces and the
     * runtime package list current when it started, with their pool key.
     */
    private readonly replacements: Array<{ work: Promise<Slot>; packagesDigest: string; key: string }> = [];
    private get closed() { return this.shutdown.signal.aborted; }
    constructor(private readonly client: SpriteClient, private readonly inventory?: SpriteInventory,
        private readonly loadPackages: SpritePackageSource = noPackages) {
        inventory?.start(async () => {
            // Another worker is waiting at the cap: yield the least recently used idle Sprite.
            const idle = this.idle.shift();
            if (idle) await this.discard(idle.sprite);
        });
    }

    private async provision(signal: AbortSignal, name: string, packages: readonly string[], servers: RemotePackageInstall | undefined): Promise<Slot> {
        // Never discover or adopt a machine by name. Another worker, including an earlier
        // incarnation of this worker, can still have a live run on one it created.
        // Provisioning time (setup, package installs, checkpoint) is under the reservation's lease,
        // which the inventory renews every few seconds; only the create request has its own window.
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
            // Instance runtime packages go into the clean checkpoint, so every run on this Sprite has them.
            const packageInstallMs = await installSpriteRuntimePackages(this.loadPackages, sprite, packages, signal);
            // Package MCP servers go into the clean checkpoint too, after the runtime packages they may need.
            const packageServerInstallMs = await installSpritePackageServers({ sprite, dir, install: servers, step, signal });
            await step(() => fs.rm(dir, { recursive: true }));
            const comment = 'propr clean setup';
            await step(async () => complete(await sprite.createCheckpoint(comment)));
            const checkpoint = (await step(() => sprite.listCheckpoints())).find(cp => cp.comment === comment && cp.id !== 'Current');
            if (!checkpoint) throw new Error('Missing clean Sprite checkpoint');
            const restoring = Date.now();
            await step(async () => complete(await sprite.restoreCheckpoint(checkpoint.id)));
            return { sprite, lease: this.inventory?.signal(name), checkpoint: checkpoint.id, ...provisionedPackages(packages, packageInstallMs, servers, packageServerInstallMs),
                provisioningMs: restoring - started, restoreMs: Date.now() - restoring };
        } catch (cause) {
            const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr).slice(-4096).trim() : '';
            const detail = stderr || (cause instanceof Error ? cause.message : String(cause));
            const failure = new Error(`Failed to provision the clean Sprite checkpoint: ${detail}`, { cause });
            // Decide before the discard: deleting the Sprite releases its lease, which is part of
            // `signal`, so checking afterwards would report every failure as "Sprite lease expired".
            const cancelled = signal.aborted ? signal.reason : undefined;
            try {
                await this.discard(sprite);
            } catch (cleanupError) {
                throw new AggregateError([failure, cleanupError], `${failure.message} (also failed to delete Sprite ${sprite.name})`);
            }
            if (cancelled !== undefined) throw cancelled;
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

    private provisionForPool(name: string, packages: readonly string[], servers: RemotePackageInstall | undefined) {
        const lease = this.inventory?.signal(name);
        // Agent setup (20m), runtime packages (15m) and package MCP servers (10m + npm bounds), with headroom.
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(47 * 60_000), ...(lease ? [lease] : [])]);
        const work = this.provision(signal, name, packages, servers);
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

    /** The most recently used idle Sprite with this pool key (runtime packages and package MCP servers). */
    private takeIdle(key: string) {
        const index = this.idle.findLastIndex(slot => slotPoolKey(slot) === key);
        return index < 0 ? undefined : this.idle.splice(index, 1)[0];
    }

    /**
     * At the cap, make room by deleting the least recently used idle Sprite with
     * another pool key. Sprites for other package server sets are otherwise kept
     * warm for the runs that need them.
     */
    private async evictForCap(key: string) {
        const index = this.idle.findIndex(slot => slotPoolKey(slot) !== key);
        if (index < 0) return false;
        const [slot] = this.idle.splice(index, 1);
        logger.info({ sprite: slot.sprite.name, packagesDigest: slot.packagesDigest, packageServersDigest: slot.packageServersDigest, wanted: key },
            'Sprite pool at its cap; deleting the least recently used idle Sprite built for other packages');
        await this.discard(slot.sprite).catch(() => {
            logger.warn({ sprite: slot.sprite.name }, 'Could not delete an idle Sprite built for other packages');
        });
        return true;
    }

    /** A clean Sprite whose checkpoint has exactly the current runtime packages and the run's package MCP servers installed. */
    async acquire(signal: AbortSignal, onWaiting?: () => void, servers?: RemotePackageInstall): Promise<Slot & { queueMs: number }> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        const serversDigest = packageServersDigest(servers?.servers);
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
            if (await this.evictForCap(key)) return false;
            if (!attempt) onWaiting?.();
            const backoff = calculateDelay(attempt++, { baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, jitter: true });
            await delay(Math.min(backoff, deadline - performance.now()), undefined, { signal });
            return false;
        };

        // Read once per run: a package change retires warm Sprites instead of reusing them.
        const packages = await startupStep(signal, () => this.loadPackages());
        const packagesDigest = agentRuntimePackagesDigest(packages);
        const key = spritePoolKey(packagesDigest, serversDigest);
        for (;;) {
            signal.throwIfAborted();
            if (performance.now() >= deadline) throw timeout();
            this.retireStaleIdle(packagesDigest);
            // Only a Sprite built for exactly these runtime packages and package servers is reused.
            let slot = this.takeIdle(key);
            let queueMs = elapsedQueueMs();
            const replacement = slot ? undefined : this.takeReplacement(packagesDigest, key);
            if (replacement) {
                try { slot = await this.claim(replacement, signal); }
                catch {
                    signal.throwIfAborted();
                    // A speculative replacement failed. Give this run its own provisioning attempt.
                }
            }
            if (!slot) {
                // Only a new Sprite installs anything; warm and recycled ones keep their checkpoint's packages.
                // Checked before the reservation, so a slow index download never eats into its create window.
                await startupStep(signal, () => checkAgentRuntimePackagesBeforeInstall(this.loadPackages, packages, signal));
                const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
                if (!await reserveForRun(name)) continue;
                queueMs = elapsedQueueMs();
                if (signal.aborted) {
                    await this.inventory?.finish(name, 'gone'); // No create request was sent.
                    signal.throwIfAborted();
                }
                slot = await this.claim(this.provisionForPool(name, packages, servers), signal);
            }
            if (slotPoolKey(slot) !== key) {
                // Not expected (stale idle and replacement Sprites are skipped above); never fail the run over it.
                await this.discardStale(slot);
                continue;
            }
            if (!await this.checkOut(slot)) continue;
            if (signal.aborted) {
                await this.recycleClean(slot);
                signal.throwIfAborted();
            }
            return { ...slot, queueMs };
        }
    }

    /**
     * The oldest background replacement with this pool key.
     * Replacements started with another runtime package list are dropped without waiting for them, and
     * deleted once they finish, best effort; those for another server set stay for the runs that need them.
     */
    private takeReplacement(packagesDigest: string, key: string): Promise<Slot> | undefined {
        for (const entry of this.replacements.filter(replacement => replacement.packagesDigest !== packagesDigest)) {
            this.replacements.splice(this.replacements.indexOf(entry), 1);
            logger.info({ packagesDigest: entry.packagesDigest }, 'Agent runtime packages changed; dropping a replacement Sprite provisioned with the old list');
            void entry.work.then(slot => this.discardStale(slot), () => {});
        }
        const index = this.replacements.findIndex(replacement => replacement.key === key);
        return index < 0 ? undefined : this.replacements.splice(index, 1)[0].work;
    }

    /** Deletes a Sprite provisioned with another package list; a failed delete is logged, not the run's failure. */
    private async discardStale(slot: Slot) {
        await this.discard(slot.sprite).catch(() => {
            logger.warn({ sprite: slot.sprite.name }, 'Could not retire a Sprite provisioned with other runtime packages');
        });
    }

    /** Takes idle Sprites with another package set out of the pool (never handed to a run) and deletes them in the background. */
    private retireStaleIdle(packagesDigest: string) {
        const stale = this.idle.filter(slot => slot.packagesDigest !== packagesDigest);
        if (stale.length === 0) return;
        this.idle = this.idle.filter(slot => slot.packagesDigest === packagesDigest);
        logger.info({ sprites: stale.map(slot => slot.sprite.name) }, 'Agent runtime packages changed; retiring warm Sprites');
        for (const slot of stale) {
            const retiring: Promise<void> = this.discardStale(slot).finally(() => this.releases.delete(retiring));
            this.releases.add(retiring);
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

    /** Provision a replacement with the package servers of the Sprite it replaces and the current runtime packages. */
    private async replaceInBackground(servers: RemotePackageInstall | undefined) {
        let packages: readonly string[];
        try {
            packages = await this.loadPackages();
            await checkAgentRuntimePackagesBeforeInstall(this.loadPackages, packages, this.shutdown.signal);
        } catch (error) {
            // Nothing was reserved or created; the next run provisions its own Sprite.
            if (!this.closed) logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Could not read or verify agent runtime packages for a replacement Sprite');
            return;
        }
        if (this.closed) return;
        const name = (this.inventory?.prefix ?? 'propr-') + randomUUID();
        if (this.inventory && !await this.inventory.reserve(name, true)) return;
        if (this.closed) {
            await this.inventory?.finish(name, 'gone');
            return;
        }
        const work = this.provisionForPool(name, packages, servers);
        const packagesDigest = agentRuntimePackagesDigest(packages);
        const entry = { work, packagesDigest, key: spritePoolKey(packagesDigest, packageServersDigest(servers?.servers)) };
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
        await this.recycleClean({ sprite, lease: slot.lease, checkpoint, packagesDigest: slot.packagesDigest,
            packageServersDigest: slot.packageServersDigest, ...(slot.packages && { packages: slot.packages }), provisioningMs: 0, restoreMs });
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
