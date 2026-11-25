import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sprite } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import type { AgentRunRunnerPoolUsage } from '../computeUsage.js';
import { SPRITES_LEASE_TTL_MS, SPRITES_POOL_LABEL, spritesPoolLabel, type SpritesPoolConfig } from '../spritesPool.js';
import {
    abandonSpriteRunner, acquireSpriteRunner, claimSpriteRunners, effectiveRunnerState, expireSpritePool, forgetSpriteRunner,
    heartbeatSpriteLease, leaveSpriteQueue, releaseSpriteRunner, recordSpriteCreateOutcome, replaceSpriteRunner, updateSpriteRunner,
    type SpriteInventoryCheck, type SpritePoolState, type SpriteRunnerRecord,
} from './spritesPoolState.js';
import type { SpritePoolStore } from './spritesPoolStore.js';
import {
    carryWarmClone, completeCheckpointStream, confirmResultAbsent, createLabel, createReservedSprite, deleteSprite, inspectSpriteReservation,
    installWarmClone, PROVIDER_TIMEOUT_MS, readSpriteSetup, restartForReset, setupSprite, startupStep, type SpriteClient,
} from './spritesProvisioning.js';

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

export { deleteSprite } from './spritesProvisioning.js';

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
    private nextInventoryCheck = 0;
    private checkingInventory = false;
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

    /** Acquisition needs a counted inventory. After that, failed cleanup can be retried with its slot still held. */
    private initialize(): Promise<void> {
        return this.ready ??= this.recordInventory().catch(error => {
            this.ready = undefined;
            throw error;
        }).then(checks => this.reconcileRecords(checks).catch(error => {
            logger.warn({ error: String(error) }, 'Sprites pool reconciliation failed');
        }));
    }

    async reconcile(): Promise<void> {
        await this.reconcileRecords(await this.recordInventory());
    }

    private async recordInventory(): Promise<SpriteInventoryCheck[]> {
        const { store, scope, config } = this.options;
        await store.publishConfig(scope, { max: config.max, orgLimit: config.orgLimit, warmClones: config.warmClones, updatedAt: this.now() });
        if (config.clamped) logger.warn({ max: config.max, orgLimit: config.orgLimit }, 'PROPR_SPRITES_MAX exceeds the Sprites organization limit; using the limit');
        const listedAt = this.now();
        const listed = await startupStep(AbortSignal.timeout(PROVIDER_TIMEOUT_MS), () => this.client.listAllSprites('propr-'));
        const label = spritesPoolLabel(scope);
        const names = new Set(listed.map(sprite => sprite.name));
        // Count all discovered orphans together before awaiting any inspection or deletion.
        // A record written while the inventory request was in flight still owns its Sprite.
        return this.transact(state => {
            for (const sprite of listed) {
                if (state.runners.has(sprite.name)) continue;
                const labelled = sprite.labels?.includes(label);
                if (!labelled && !isOldLegacySprite(sprite, listedAt)) continue;
                state.runners.set(sprite.name, {
                    state: 'orphaned', since: listedAt, heartbeatAt: listedAt, runs: 0, inspectResultOnReap: !labelled,
                });
            }
            const checks: SpriteInventoryCheck[] = [];
            for (const [name, record] of state.runners) {
                const expected = effectiveRunnerState(record, listedAt, this.ttlMs);
                if ((!names.has(name) || record.pendingCreate) && ['idle', 'orphaned', 'retained'].includes(expected)) {
                    checks.push({ name, state: expected, pendingCreate: record.pendingCreate });
                }
            }
            return checks;
        });
    }

    private async reconcileRecords(checks: SpriteInventoryCheck[]): Promise<void> {
        for (const check of checks) await this.checkInventory(check, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
        const leaseId = randomUUID();
        for (const [name, record] of await this.claimRunners(leaseId, ['orphaned'])) {
            try {
                await this.reapRunner(name, leaseId, record);
            } catch (error) {
                logger.warn({ sprite: name, error: String(error) }, 'Could not reap orphaned Sprite');
            }
        }
    }

    private async checkInventory(check: SpriteInventoryCheck, signal: AbortSignal): Promise<void> {
        const observed = await inspectSpriteReservation(this.client, check, signal);
        if (!observed) return;
        await this.transact(state => {
            expireSpritePool(state, this.now(), this.ttlMs);
            const current = state.runners.get(check.name);
            if (current?.state !== check.state || current.pendingCreate !== check.pendingCreate) return;
            if (observed === 'missing') forgetSpriteRunner(state, check.name);
            else if (current.state === 'orphaned') delete current.pendingCreate;
        });
    }

    private async checkBlocked(records: SpriteInventoryCheck[], signal: AbortSignal): Promise<void> {
        if (!records.length || this.checkingInventory || this.now() < this.nextInventoryCheck) return;
        this.checkingInventory = true;
        try {
            const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
            await Promise.all(records.map(record => this.checkInventory(record, lookupSignal).catch(error => {
                signal.throwIfAborted();
                logger.warn({ sprite: record.name, error: String(error) }, 'Could not check Sprite inventory');
            })));
        } finally {
            this.nextInventoryCheck = this.now() + Math.floor(this.ttlMs / 4);
            this.checkingInventory = false;
        }
    }

    private claimRunners(leaseId: string, states: SpriteRunnerRecord['state'][], lastOwner?: string) {
        return this.transact(state => claimSpriteRunners(state, { states, lastOwner, leaseId, owner: this.owner, now: this.now(), ttlMs: this.ttlMs }));
    }

    private async reapRunner(name: string, leaseId: string, record: SpriteRunnerRecord, signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)): Promise<void> {
        const absent = record.inspectResultOnReap === false || await confirmResultAbsent(this.client, name, signal);
        if (signal.aborted) {
            await this.transact(state => abandonSpriteRunner(state, name, leaseId, this.now()));
            signal.throwIfAborted();
        }
        if (!absent) {
            const retained = await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() },
                { state: 'retained', leaseId: undefined, owner: undefined }));
            if (retained) logger.warn({ sprite: name }, 'Sprite may hold an unrecovered result; review it manually');
            return;
        }
        // Revalidate the claim after the provider inspection, immediately before deletion.
        await this.deleteRunner(name, leaseId, signal);
    }

    /** Deletes a held runner's Sprite and its record; on failure the runner stays counted, orphaned. */
    private async deleteRunner(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
        await this.deleteHeldSprite(name, leaseId, signal);
        await this.transact(state => forgetSpriteRunner(state, name, leaseId));
    }

    private async deleteHeldSprite(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
        const held = await this.transact(state => updateSpriteRunner(state, { name, leaseId, now: this.now() }, { state: 'reaping' }));
        if (!held) throw new Error('Sprites runner lease lapsed');
        try {
            await deleteSprite(this.client, name, signal);
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
                const decision = await this.transact(state => {
                    queueSignal.throwIfAborted();
                    return acquireSpriteRunner(state, {
                        leaseId, owner: this.owner, max: config.max, repo: request.repo, newName: `propr-${randomUUID()}`, now: this.now(), ttlMs: this.ttlMs,
                    });
                });
                if (decision.action === 'wait') {
                    if (!queued) logger.info({ position: decision.position, runners: decision.runners, max: config.max }, 'Every Sprites runner is busy; run queued for one');
                    queued = true;
                    await this.checkBlocked(decision.toCheck, queueSignal);
                    await poll();
                    continue;
                }
                if (decision.action === 'reap') {
                    const reapSignal = AbortSignal.any([queueSignal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
                    await this.reapRunner(decision.name, leaseId, decision.record, reapSignal).catch(poll);
                    continue;
                }
                const lease = { name: decision.name, leaseId, waitMs: this.now() - startedAt, runs: decision.record.runs };
                if (decision.action === 'provision') {
                    // Setup belongs to the pool. A caller that stops before upload leaves a clean runner.
                    const slot = await this.provision(lease);
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

    private async provision({ name, leaseId, waitMs, runs }: PoolLease, cancellation = this.shutdown.signal): Promise<Slot> {
        const startedAt = this.now();
        const signal = AbortSignal.any([cancellation, AbortSignal.timeout(21 * 60_000)]);
        const lease = () => ({ name, leaseId, owner: this.owner, now: this.now() });
        const reserved = await this.transact(state => state.runners.get(name)?.state === 'provisioning'
            && updateSpriteRunner(state, lease(), { pendingCreate: leaseId }));
        if (!reserved) throw new Error('Sprites runner lease lapsed');
        const labels = [SPRITES_POOL_LABEL, spritesPoolLabel(this.options.scope), createLabel(leaseId)];
        const sprite = await createReservedSprite(this.client, { name, labels }, signal, {
            record: outcome => this.transact(state => recordSpriteCreateOutcome(state, lease(), outcome)),
            discard: () => this.deleteRunner(name, leaseId),
        });
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
            const healthSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
            await startupStep(healthSignal, () => sprite.execFile('/bin/true', [], { cwd: '/', timeout: 30_000, signal: healthSignal }));
            healthCheckMs = this.now() - checkStartedAt;
            if (warm && warm.repo !== repo) {
                // Another repository's warm clone: start this run from the clean checkpoint.
                restoring = true;
                const restoreStartedAt = this.now();
                const restoreSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
                await startupStep(restoreSignal, async () => completeCheckpointStream(await sprite.restoreCheckpoint(record.checkpoint!)));
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
        const leaseId = randomUUID();
        try {
            const idle = await this.claimRunners(leaseId, ['idle'], this.owner);
            await Promise.allSettled(idle.map(([name, record]) => this.reapRunner(name, leaseId, record)));
        } catch (error) {
            logger.warn({ error: String(error) }, 'Could not delete idle Sprites at shutdown');
        }
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
            let next;
            try {
                const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
                next = await this.reset(slot, signal, outcome.repo);
            } catch {
                if (this.closed) return await this.deleteRunner(slot.name, slot.leaseId);
                logger.warn({ sprite: slot.name }, 'Sprites runner could not be reset; re-provisioning it');
                const lease = await this.reserveReplacement({ ...slot, waitMs: 0 });
                const work = this.provision(lease)
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
            await this.returnClean(slot, next);
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
        const lastRestoreMs = this.now() - startedAt;
        const warm = carried ? await step(() => installWarmClone(slot.sprite, repo!)) : target === slot.checkpoint ? undefined : slot.warm;
        return { checkpoint: slot.checkpoint, warm, lastRestoreMs, runs: slot.runs + 1 };
    }
}
