import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sprite } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import type { AgentRunRunnerPoolUsage } from '../computeUsage.js';
import { SPRITES_LEASE_TTL_MS, SPRITES_POOL_LABEL, spritesPoolLabel, type SpritesPoolConfig } from '../spritesPool.js';
import {
    abandonSpriteRunner, acquireSpriteRunner, claimSpriteRunners, effectiveRunnerState, expireSpritePool, forgetSpriteRunner,
    heartbeatSpriteLease, leaveSpriteQueue, releaseSpriteRunner, replaceSpriteRunner, updateSpriteRunner,
    type SpritePoolState, type SpriteRunnerRecord,
} from './spritesPoolState.js';
import type { SpritePoolStore } from './spritesPoolStore.js';
import { carryWarmClone, completeCheckpointStream, installWarmClone, readSpriteSetup, restartForReset, setupSprite, startupStep, type SpriteClient } from './spritesProvisioning.js';

/** One leased runner. */
export type Slot = {
    sprite: Sprite;
    name: string;
    leaseId: string;
    /** The clean setup checkpoint. */
    checkpoint: string;
    /** The warm clone baseline the runner is at, when not the clean checkpoint. */
    warm?: { repo: string; checkpoint: string };
    runs: number;
    usage: AgentRunRunnerPoolUsage;
};

export interface SpritePoolOptions {
    store: SpritePoolStore;
    scope: string;
    config: SpritesPoolConfig;
    /** Identifies this worker process in lease records. */
    owner?: string;
    /** How often a queued request asks again. */
    pollMs?: number;
    ttlMs?: number;
    now?: () => number;
}

/** A lease's runner while it is acquired. */
type PoolLease = { name: string; leaseId: string; waitMs: number; runs: number };

const LEGACY_NAME = /^propr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_SPRITE_GRACE_MS = 24 * 60 * 60_000;

function isOldLegacySprite(sprite: Sprite, listedAt: number): boolean {
    return !sprite.labels?.length && LEGACY_NAME.test(sprite.name) && sprite.createdAt !== undefined
        && listedAt - sprite.createdAt.getTime() > LEGACY_SPRITE_GRACE_MS;
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

/** Deletes a Sprite; one that is already gone counts as deleted. */
export async function deleteSprite(client: SpriteClient, name: string): Promise<void> {
    try { await client.deleteSprite(name); }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
}

/**
 * Runner Sprites shared by every worker of one Sprites organization, bounded
 * by `config.max`. A run leases a runner through the shared lease state
 * (Redis in a deployment) and queues while every runner is busy. Each runner
 * is provisioned once with a clean checkpoint, health checked before each
 * lease and restored after each run, so nothing of one run reaches the next;
 * a runner that fails either is destroyed and re-provisioned.
 *
 * Lease holders heartbeat. A runner whose holder stopped heartbeating is
 * inspected for unreleased results before its slot is reclaimed. On startup a worker
 * deletes this pool's Sprites that have no record at all.
 */
export class SpritePool {
    private readonly shutdown = new AbortController();
    private readonly replacements = new Set<Promise<void>>();
    private get closed() { return this.shutdown.signal.aborted; }
    private readonly setup = readSpriteSetup();
    private nextRetainedCheck = 0;
    private checkingRetained = false;
    private ready?: Promise<void>;
    private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
    /** Until release, every heartbeat can repair a completion write with an unknown outcome. */
    private readonly finishedRunners = new Map<string, string>();
    private readonly owner: string;
    private readonly ttlMs: number;

    constructor(private readonly client: SpriteClient, private readonly options: SpritePoolOptions) {
        this.owner = options.owner ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
        this.ttlMs = options.ttlMs ?? SPRITES_LEASE_TTL_MS;
    }

    private now() { return this.options.now?.() ?? Date.now(); }
    private transact<T>(operation: (state: SpritePoolState) => T): Promise<T> {
        return this.options.store.transact(this.options.scope, operation);
    }

    private heartbeat(leaseId: string): Promise<void> {
        return this.transact(state => {
            const now = this.now();
            heartbeatSpriteLease(state, leaseId, now);
            const name = this.finishedRunners.get(leaseId);
            if (name && state.runners.get(name)?.state === 'leased') {
                updateSpriteRunner(state, { name, leaseId, now }, { state: 'finished' });
            }
        });
    }

    private startHeartbeat(leaseId: string) {
        const timer = setInterval(() => {
            this.heartbeat(leaseId)
                .catch(error => logger.warn({ error: String(error) }, 'Sprites pool heartbeat failed'));
        }, Math.max(50, Math.floor(this.ttlMs / 4)));
        timer.unref();
        this.heartbeats.set(leaseId, timer);
    }

    private stopHeartbeat(leaseId: string) {
        clearInterval(this.heartbeats.get(leaseId));
        this.heartbeats.delete(leaseId);
        this.finishedRunners.delete(leaseId);
    }

    /** Once per pool: publish the bounds, forget runners whose Sprite is gone and reap Sprites no record owns. */
    private initialize(): Promise<void> {
        return this.ready ??= this.reconcile().catch(error => {
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Sprites pool reconciliation failed');
        });
    }

    async reconcile(): Promise<void> {
        const { store, scope, config } = this.options;
        await store.publishConfig(scope, { max: config.max, orgLimit: config.orgLimit, warmClones: config.warmClones, updatedAt: this.now() });
        if (config.clamped) logger.warn({ max: config.max, orgLimit: config.orgLimit }, 'PROPR_SPRITES_MAX exceeds the Sprites organization limit; using the limit');
        // List first, then read: a record is written before its Sprite is created, so a
        // listed Sprite missing from the later read is one no worker is creating.
        const listedAt = this.now();
        const listed = await this.client.listAllSprites('propr-');
        const state = await store.read(scope);
        const names = new Set(listed.map(sprite => sprite.name));
        for (const [name, record] of state.runners) {
            const expected = effectiveRunnerState(record, listedAt, this.ttlMs);
            if (!names.has(name) && ['idle', 'orphaned', 'retained'].includes(expected)) {
                await this.forgetIfMissing(name, expected);
            }
        }
        const label = spritesPoolLabel(scope);
        for (const sprite of listed) {
            if (state.runners.has(sprite.name)) continue;
            if (!sprite.labels?.includes(label)) {
                if (!isOldLegacySprite(sprite, listedAt)) continue;
                if (!await this.confirmResultAbsent(sprite.name)) {
                    logger.warn({ sprite: sprite.name }, 'Legacy Sprite may hold an unrecovered result; review it manually');
                    continue;
                }
            }
            try {
                // Other lookups and deletes may have awaited since the inventory read.
                if ((await store.read(scope)).runners.has(sprite.name)) continue;
                await deleteSprite(this.client, sprite.name);
                logger.info({ sprite: sprite.name }, 'Deleted orphaned Sprite no pool lease owns');
            } catch (error) {
                logger.error({ sprite: sprite.name, error: String(error) }, 'Could not delete orphaned Sprite');
            }
        }
        await this.deleteClaimed({ states: ['orphaned'] });
    }

    private async forgetIfMissing(name: string, expected: SpriteRunnerRecord['state']): Promise<void> {
        try {
            await this.client.getSprite(name);
        } catch (error) {
            if ((error as { statusCode?: number }).statusCode !== 404) throw error;
            await this.transact(state => {
                expireSpritePool(state, this.now(), this.ttlMs);
                if (state.runners.get(name)?.state === expected) forgetSpriteRunner(state, name);
            });
        }
    }

    private async checkRetained(names: string[]): Promise<void> {
        if (!names.length || this.checkingRetained || this.now() < this.nextRetainedCheck) return;
        this.checkingRetained = true;
        try {
            await Promise.all(names.map(name => this.forgetIfMissing(name, 'retained').catch(error =>
                logger.warn({ sprite: name, error: String(error) }, 'Could not check retained Sprite'))));
        } finally {
            this.nextRetainedCheck = this.now() + Math.floor(this.ttlMs / 4);
            this.checkingRetained = false;
        }
    }

    /** Deletes the runners a claim returns; a failed deletion leaves the runner orphaned for a later attempt. */
    private async deleteClaimed(claim: { states: SpriteRunnerRecord['state'][]; lastOwner?: string }): Promise<void> {
        const leaseId = randomUUID();
        const claimed = await this.transact(state => claimSpriteRunners(state, { ...claim, leaseId, owner: this.owner, now: this.now(), ttlMs: this.ttlMs }));
        await Promise.allSettled(claimed.map(([name, record]) => this.reapRunner(name, leaseId, record)));
    }

    private async confirmResultAbsent(name: string): Promise<boolean> {
        try {
            const inspection = await this.client.sprite(name).execFile('sudo', ['-n', '/usr/bin/python3', '-I', '-c', INSPECT_RESULT],
                { cwd: '/', timeout: 30_000 });
            return inspection.exitCode === 0 && inspection.stdout.toString().trim() === 'absent';
        } catch (error) {
            logger.warn({ sprite: name, error: String(error) }, 'Could not inspect Sprite for a result');
            return false;
        }
    }

    private async reapRunner(name: string, leaseId: string, record: SpriteRunnerRecord): Promise<void> {
        if (record.inspectResultOnReap !== false && !await this.confirmResultAbsent(name)) {
            await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() },
                { state: 'retained', leaseId: undefined, owner: undefined }));
            return;
        }
        // Revalidate the claim after the provider inspection, immediately before deletion.
        await this.deleteRunner(name, leaseId);
    }

    /** Deletes a held runner's Sprite and its record; on failure the runner stays counted, orphaned. */
    private async deleteRunner(name: string, leaseId: string): Promise<void> {
        await this.deleteHeldSprite(name, leaseId);
        await this.transact(state => forgetSpriteRunner(state, name, leaseId));
    }

    private async deleteHeldSprite(name: string, leaseId: string): Promise<void> {
        const held = await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() }, { state: 'reaping' }));
        if (!held) throw new Error('Sprites runner lease lapsed');
        try {
            await deleteSprite(this.client, name);
        } catch (error) {
            logger.error({ sprite: name }, 'Could not delete Sprite');
            await this.transact(state => abandonSpriteRunner(state, name, leaseId, this.now())).catch(() => {});
            throw error;
        }
    }

    /** Deletes a leased runner's Sprite and record (a run aborted after acquisition, or a closed pool). */
    async discard(slot: Slot): Promise<void> {
        try { await this.deleteRunner(slot.name, slot.leaseId); }
        finally { this.stopHeartbeat(slot.leaseId); }
    }

    async acquire(signal: AbortSignal, request: { repo?: string; timeout?: number } = {}): Promise<Slot> {
        signal.throwIfAborted();
        if (this.closed) throw new Error('Sprite pool is closed');
        signal = AbortSignal.any([signal, this.shutdown.signal]);
        const queueSignal = request.timeout === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(request.timeout)]);
        const poll = () => delay(this.options.pollMs ?? 2000, undefined, { signal: queueSignal })
            .catch(() => queueSignal.throwIfAborted());
        await startupStep(queueSignal, () => this.initialize());
        const leaseId = randomUUID();
        const startedAt = this.now();
        const { config } = this.options;
        let queued = false;
        this.startHeartbeat(leaseId);
        try {
            for (;;) {
                queueSignal.throwIfAborted();
                const decision = await this.transact(state => acquireSpriteRunner(state, {
                    leaseId, owner: this.owner, max: config.max, repo: request.repo, newName: `propr-${randomUUID()}`, now: this.now(), ttlMs: this.ttlMs,
                }));
                if (decision.action === 'wait') {
                    if (!queued) logger.info({ position: decision.position, runners: decision.runners, max: config.max }, 'Every Sprites runner is busy; run queued for one');
                    queued = true;
                    await this.checkRetained(decision.retained);
                    await poll();
                    continue;
                }
                if (decision.action === 'reap') {
                    await this.reapRunner(decision.name, leaseId, decision.record).catch(poll);
                    signal.throwIfAborted();
                    continue;
                }
                const waitMs = this.now() - startedAt;
                const lease = { name: decision.name, leaseId, waitMs, runs: decision.record.runs };
                if (decision.action === 'provision') {
                    // Setup belongs to the pool. A caller that stops before upload leaves a clean runner.
                    const slot = await this.provision(lease, this.provisionSignal());
                    if (signal.aborted) {
                        await this.returnClean(slot, { checkpoint: slot.checkpoint, runs: slot.runs });
                        signal.throwIfAborted();
                    }
                    return slot;
                }
                return await this.leaseIdle({ ...lease, record: decision.record, repo: request.repo }, signal);
            }
        } catch (error) {
            this.stopHeartbeat(leaseId);
            await this.transact(state => leaveSpriteQueue(state, leaseId)).catch(() => {});
            throw error;
        }
    }

    private async provision({ name, leaseId, waitMs, runs }: PoolLease, signal: AbortSignal): Promise<Slot> {
        const startedAt = this.now();
        const { scope } = this.options;
        if (signal.aborted) {
            await this.transact(state => forgetSpriteRunner(state, name, leaseId));
            signal.throwIfAborted();
        }
        let sprite: Sprite;
        try {
            // Never discover or adopt a machine by name: the record above owns the name.
            sprite = await this.client.createSprite(name, { labels: [SPRITES_POOL_LABEL, spritesPoolLabel(scope)] });
        } catch (error) {
            // A name conflict explicitly rejects our create. An ambiguous failure can
            // leave a Sprite behind, so keep its reservation for the next reaper.
            if ((error as { statusCode?: number }).statusCode === 409) {
                await this.transact(state => forgetSpriteRunner(state, name, leaseId));
            } else {
                await this.transact(state => abandonSpriteRunner(state, name, leaseId, this.now()));
            }
            throw error;
        }
        logger.info({ sprite: sprite.name }, 'Worker created Sprite');
        let checkpoint: string;
        try {
            checkpoint = await setupSprite(sprite, signal, this.setup);
        } catch (failure) {
            try {
                await this.deleteRunner(name, leaseId);
            } catch (cleanupError) {
                throw new AggregateError([failure, cleanupError], `${(failure as Error).message} (also failed to delete Sprite ${sprite.name})`);
            }
            signal.throwIfAborted();
            throw failure;
        }
        const provisionMs = this.now() - startedAt;
        const held = await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() },
            { state: 'leased', checkpoint, provisionMs, setupFingerprint: this.setup.fingerprint }));
        if (!held) throw new Error('Sprites runner lease lapsed');
        return { sprite, name, leaseId, checkpoint, runs, usage: {
            waitMs, provisioned: true, provisionMs, healthCheckMs: null, previousRestoreMs: null, restoreBeforeLeaseMs: null, baseline: 'clean',
        } };
    }

    /** Health checks an idle runner before handing it out; a broken one is destroyed and re-provisioned in its slot. */
    private async leaseIdle(lease: PoolLease & { record: SpriteRunnerRecord; repo?: string }, signal: AbortSignal): Promise<Slot> {
        const { name, record, leaseId, waitMs, repo } = lease;
        if (record.setupFingerprint !== this.setup.fingerprint) return this.reprovision(lease, signal);
        const sprite = this.client.sprite(name);
        const checkStartedAt = this.now();
        let warm = record.warm;
        let restoreBeforeLeaseMs: number | null = null;
        let healthCheckMs: number | null = null;
        let restoring = false;
        try {
            if (!record.checkpoint) throw new Error('Runner record has no clean checkpoint');
            await startupStep(signal, () => sprite.execFile('/bin/true', [], { cwd: '/', timeout: 30_000, signal }));
            healthCheckMs = this.now() - checkStartedAt;
            if (warm && warm.repo !== repo) {
                // Another repository's warm clone: start this run from the clean checkpoint.
                restoring = true;
                const restoreStartedAt = this.now();
                await startupStep(signal, async () => completeCheckpointStream(await sprite.restoreCheckpoint(record.checkpoint!)));
                restoreBeforeLeaseMs = this.now() - restoreStartedAt;
                warm = undefined;
            }
        } catch (error) {
            if (signal.aborted) {
                // Cancelled before any restore started: the runner is still at its baseline, so hand it back.
                // A restore cut short leaves it in an unknown state: delete it.
                const lease = { name, leaseId, max: this.options.config.max, now: this.now() };
                const returned = restoring ? 'discard' : await this.transact(state => releaseSpriteRunner(state, lease, { warm: record.warm, lastRestoreMs: record.lastRestoreMs }))
                    .catch(() => 'lost' as const);
                if (returned === 'discard') await this.deleteRunner(name, leaseId).catch(() => {});
                throw error;
            }
            logger.warn({ sprite: name, error: error instanceof Error ? error.message : String(error) }, 'Sprites runner failed its health check; re-provisioning it');
            return this.reprovision(lease, signal);
        }
        const held = await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() },
            restoring ? { warm: undefined, lastRestoreMs: restoreBeforeLeaseMs! } : {}));
        if (!held) throw new Error('Sprites runner lease lapsed');
        return { sprite, name, leaseId, checkpoint: record.checkpoint, warm, runs: record.runs, usage: {
            waitMs, provisioned: false, provisionMs: null, healthCheckMs, previousRestoreMs: record.lastRestoreMs ?? null,
            restoreBeforeLeaseMs, baseline: warm ? 'warm' : 'clean',
        } };
    }

    /** Destroys a broken runner and provisions a replacement under the same lease. */
    private async reprovision(lease: PoolLease, signal: AbortSignal): Promise<Slot> {
        return this.provision(await this.reserveReplacement(lease), signal);
    }

    private provisionSignal() {
        return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(21 * 60_000)]);
    }

    private async reserveReplacement({ name, leaseId, waitMs, runs }: PoolLease): Promise<PoolLease> {
        await this.deleteHeldSprite(name, leaseId);
        const replacement = `propr-${randomUUID()}`;
        if (!await this.transact(state => replaceSpriteRunner(state, { name, leaseId, now: this.now() }, replacement))) {
            throw new Error('Sprites runner lease lapsed');
        }
        return { name: replacement, leaseId, waitMs, runs };
    }

    /** The run settled; until its release the runner's result may still be read. */
    async finished(slot: Slot): Promise<void> {
        this.finishedRunners.set(slot.leaseId, slot.name);
        await this.heartbeat(slot.leaseId)
            .catch(error => logger.warn({ error: String(error) }, 'Could not record a finished Sprites run'));
    }

    async close(): Promise<void> {
        this.shutdown.abort();
        await Promise.allSettled(this.replacements);
        // Idle runners this worker last held; deleteRunner logs the name for manual cleanup if deletion fails.
        await this.deleteClaimed({ states: ['idle'], lastOwner: this.owner }).catch(error => {
            logger.warn({ error: String(error) }, 'Could not delete idle Sprites at shutdown');
        });
    }

    /**
     * Resets the runner for the next lease: stop every process, wipe the separate
     * /tmp disk and restore its baseline checkpoint. With warm clones on, a run
     * that refreshed its repository's warm clone reference leaves the runner at a
     * new warm checkpoint: clean checkpoint plus only that root-owned reference.
     */
    async release(slot: Slot, outcome: { repo?: string } = {}): Promise<void> {
        let replacing = false;
        try {
            if (this.closed) return await this.discard(slot);
            const held = await this.transact(state => updateSpriteRunner(state, { name: slot.name, leaseId: slot.leaseId, now: this.now() }, { state: 'resetting' }));
            if (!held) return;
            let next: { checkpoint: string; warm?: Slot['warm']; restoreMs?: number };
            try {
                const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
                next = await this.reset(slot, signal, outcome.repo);
            } catch {
                if (this.closed) return await this.deleteRunner(slot.name, slot.leaseId);
                logger.warn({ sprite: slot.name }, 'Sprites runner could not be reset; re-provisioning it');
                const lease = await this.reserveReplacement({ ...slot, waitMs: 0 });
                const work = this.provision(lease, this.provisionSignal())
                    .then(fresh => this.returnClean(fresh, { checkpoint: fresh.checkpoint, runs: fresh.runs + 1 }))
                    .catch(error => logger.warn({ sprite: lease.name, error: String(error) }, 'Failed to replace discarded Sprite'))
                    .finally(() => {
                        this.stopHeartbeat(lease.leaseId);
                        this.replacements.delete(work);
                    });
                this.replacements.add(work);
                replacing = true;
                return;
            }
            await this.returnClean(slot, {
                checkpoint: next.checkpoint, warm: next.warm, runs: slot.runs + 1,
                ...(next.restoreMs !== undefined ? { lastRestoreMs: next.restoreMs } : {}),
            });
        } finally {
            if (!replacing) this.stopHeartbeat(slot.leaseId);
        }
    }

    private async returnClean(slot: Slot, patch: Partial<SpriteRunnerRecord>): Promise<void> {
        if (this.closed) return this.discard(slot);
        const lease = { name: slot.name, leaseId: slot.leaseId, max: this.options.config.max, now: this.now() };
        const released = await this.transact(state => releaseSpriteRunner(state, lease, { ...patch, lastOwner: this.owner }));
        if (released === 'discard') await this.deleteRunner(slot.name, slot.leaseId).catch(() => {});
        if (released === 'lost') logger.warn({ sprite: slot.name }, 'Sprites runner lease lapsed before release; it is reaped as an orphan');
    }

    private async reset(slot: Slot, signal: AbortSignal, repo?: string) {
        // Stop descendants that outlived the launcher, including detached processes.
        const step = <T>(operation: () => Promise<T>) => startupStep(signal, operation);
        await restartForReset(this.client, slot.sprite, signal);
        await step(() => slot.sprite.execFile('sudo', ['-n', 'find', '/tmp', '-xdev', '-mindepth', '1', '-delete'], { cwd: '/', signal, timeout: 60_000 }));
        const carried = this.options.config.warmClones && repo ? await step(() => carryWarmClone(slot.sprite, repo)) : false;
        const target = carried ? slot.checkpoint : slot.warm?.checkpoint ?? slot.checkpoint;
        const startedAt = this.now();
        await step(async () => completeCheckpointStream(await slot.sprite.restoreCheckpoint(target)));
        const restoreMs = this.now() - startedAt;
        const warm = carried ? await step(() => installWarmClone(slot.sprite, repo!)) : target === slot.checkpoint ? undefined : slot.warm;
        return { checkpoint: slot.checkpoint, warm, restoreMs };
    }
}
