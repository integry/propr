import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import logger from '../../../utils/logger.js';
import { redactSpritesToken, spriteNameForSlot, type SpritesRuntimeConfig } from './spritesConfig.js';
import { tryAcquireSpriteLock, type SpriteLock } from './spritesLock.js';
import { execOnSprite, spritesErrorStatus, type SpriteLike, type SpritesClientLike } from './spritesSdk.js';
import {
    createAgentSprite, provisionSprite, restoreCleanCheckpoint, SPRITES_LAUNCHER, type SpriteCleanState, type SpritesSetupBundle,
} from './spritesSetup.js';

/**
 * The worker's Sprites (`<prefix>-<worker>-<slot>`), one run at a time each.
 *
 * The invariant this file keeps: a run is only ever handed a Sprite that is at
 * its clean checkpoint. A Sprite is clean when this process created,
 * provisioned and checkpointed it, or restored its checkpoint, and no run has
 * been given it since. Being handed to a run ends that; only
 * {@link SpritePool.recycle} (restore, else destroy and provision anew) makes
 * it clean again. Nothing else does: there is no flag, marker on the Sprite or
 * option that lets a run start on what another run left.
 *
 * What this process knows about a Sprite is only good while it holds the
 * Sprite's lock ({@link tryAcquireSpriteLock}). The lock is given up between
 * runs, so another worker process with the same identity may take the Sprite,
 * replace it or leave a run on it. Each holder therefore leaves its mark in
 * the state directory, and a pool that finds another's mark when it takes the
 * lock again forgets what it knew and checks the Sprite as a restarted worker
 * would.
 *
 * Which checkpoint is the clean one is remembered on the worker
 * ({@link SpriteCleanState}), never looked up by its comment on a Sprite a run
 * has used. A Sprite the worker has no matching record for is destroyed and
 * provisioned anew.
 */

export interface SpritePoolDependencies {
    client(): Promise<SpritesClientLike>;
    config(): SpritesRuntimeConfig;
    bundle(): SpritesSetupBundle;
    /** Delay between checks for a Sprite another process holds (tests shorten it). */
    lockPollMs?: number;
}

export interface SpriteAcquisitionTimings {
    /** Waiting for a free Sprite. */
    queueMs?: number;
    /** Reaching the Sprite (it wakes on the first request). */
    wakeMs?: number;
    /** Creating and provisioning a new Sprite, when this run had to. */
    provisionMs?: number;
    /** Restoring the clean checkpoint before the run, when its last release had not (a restarted worker). */
    restoreMs?: number;
}

export interface SpriteLease {
    readonly name: string;
    readonly slot: number;
    readonly sprite: SpriteLike;
}

export interface SpriteRecycleOutcome {
    /** How the Sprite became clean again; `failed` leaves it to be replaced before its next run. */
    action: 'restored' | 'replaced' | 'failed';
    durationMs: number;
}

interface Slot {
    index: number;
    name: string;
    busy: boolean;
    clean: boolean;
    sprite?: SpriteLike;
    state?: SpriteCleanState;
    /** Held from the moment the slot is taken until it is freed. */
    lock?: SpriteLock;
}

const SIGNAL_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 2_000;
const noop = (): void => undefined;

/**
 * `promise`, unless `signal` aborts first: then it rejects with the signal's
 * reason at once. The work behind `promise` is not cancelled, only no longer
 * waited for; whoever abandons it must not reuse what it works on before it settled.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        promise.catch(noop);
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export class SpritePool {
    private readonly slots = new Map<number, Slot>();
    private readonly waiters: Array<() => void> = [];
    /** This pool's mark on the Sprites it holds; another pool (another process, or a restart) has another. */
    private readonly owner = randomUUID();

    constructor(private readonly deps: SpritePoolDependencies) {}

    private slot(index: number): Slot {
        let slot = this.slots.get(index);
        if (!slot) {
            slot = { index, name: spriteNameForSlot(this.deps.config(), index), busy: false, clean: false };
            this.slots.set(index, slot);
        }
        return slot;
    }

    private lockPath(slot: Slot): string { return path.join(this.deps.config().stateDir, `${slot.name}.lock`); }
    private statePath(slot: Slot): string { return path.join(this.deps.config().stateDir, `${slot.name}.json`); }

    private ownerPath(slot: Slot): string { return path.join(this.deps.config().stateDir, `${slot.name}.owner`); }

    /**
     * Takes the Sprite's lock, which keeps another worker process that shares
     * this worker id off it. When another holder had the Sprite since this
     * pool last did, what this pool remembers of it (that it is clean, which
     * Sprite it is, its checkpoint) is dropped: only the lock made it true.
     */
    private tryLock(slot: Slot): boolean {
        const lock = tryAcquireSpriteLock(this.lockPath(slot));
        if (!lock) return false;
        try {
            const file = this.ownerPath(slot);
            let previous: string | undefined;
            try { previous = fs.readFileSync(file, 'utf8').trim(); } catch { /* never held */ }
            if (previous !== this.owner) {
                slot.clean = false;
                slot.sprite = undefined;
                slot.state = undefined;
                // Marked before anything is done to the Sprite, so the mark stands even if this process dies mid-run.
                fs.writeFileSync(`${file}.${this.owner}.tmp`, `${this.owner}\n`, { mode: 0o600 });
                fs.renameSync(`${file}.${this.owner}.tmp`, file);
            }
        } catch (error) {
            lock.release();
            throw error;
        }
        slot.lock = lock;
        return true;
    }

    private free(slot: Slot): void {
        const lock = slot.lock;
        slot.lock = undefined;
        try { lock?.release(); } finally {
            slot.busy = false;
            this.waiters.splice(0).forEach(wake => wake());
        }
    }

    /** A free slot, preferring one whose Sprite is clean already; waits while every Sprite is in use. */
    private async takeSlot(signal: AbortSignal): Promise<Slot> {
        for (;;) {
            signal.throwIfAborted();
            const limit = this.deps.config().maxSprites;
            const free = Array.from({ length: limit }, (_, index) => this.slot(index)).filter(slot => !slot.busy);
            for (const slot of [...free.filter(candidate => candidate.clean), ...free.filter(candidate => !candidate.clean)]) {
                slot.busy = true;
                let locked = false;
                try { locked = this.tryLock(slot); } finally { if (!locked) slot.busy = false; }
                if (locked) return slot;
            }
            // Every free slot is held by another process: check again shortly. Otherwise wait for a release.
            // Either wait ends with the signal's own reason, so the caller can tell a deadline from a cancellation.
            if (free.length > 0) await untilAborted(delay(this.deps.lockPollMs ?? DEFAULT_LOCK_POLL_MS, undefined, { signal }), signal);
            else await this.untilReleased(signal);
        }
    }

    private untilReleased(signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(signal.reason ?? new Error('aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(() => { signal.removeEventListener('abort', onAbort); resolve(); });
        });
    }

    private readState(slot: Slot): SpriteCleanState | undefined {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.statePath(slot), 'utf8')) as Partial<SpriteCleanState>;
            if (typeof parsed.spriteId === 'string' && typeof parsed.checkpointId === 'string' && parsed.checkpointId && typeof parsed.setupHash === 'string') {
                return { spriteId: parsed.spriteId, checkpointId: parsed.checkpointId, setupHash: parsed.setupHash };
            }
        } catch { /* none recorded */ }
        return undefined;
    }

    private writeState(slot: Slot, state: SpriteCleanState): void {
        const file = this.statePath(slot);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
    }

    private message(error: unknown): string {
        return redactSpritesToken((error as Error)?.message ?? String(error), this.deps.config().token);
    }

    /** Destroys whatever Sprite holds the slot's name and provisions a new one. */
    private async replace(slot: Slot): Promise<void> {
        const client = await this.deps.client();
        slot.clean = false;
        slot.sprite = undefined;
        slot.state = undefined;
        // Forgotten first: a Sprite that could not be deleted is never restored from an old record.
        fs.rmSync(this.statePath(slot), { force: true });
        try {
            await client.deleteSprite(slot.name);
            logger.info({ sprite: slot.name }, 'Destroyed Sprite');
        } catch (error) {
            if (spritesErrorStatus(error) !== 404) throw error;
        }
        const bundle = this.deps.bundle();
        const sprite = await createAgentSprite(client, slot.name, this.deps.config());
        const state = await provisionSprite(sprite, bundle);
        this.writeState(slot, state);
        slot.sprite = sprite;
        slot.state = state;
        slot.clean = true;
        logger.info({ sprite: slot.name, setup: bundle.hash, pins: bundle.pins, checkpoint: state.checkpointId }, 'Provisioned Sprite for agent runs');
    }

    /**
     * Brings the slot's Sprite to its clean checkpoint when this pool does not
     * know it to be there. It knows only for a Sprite it has held without
     * another holder in between ({@link tryLock}) and that was provisioned by
     * the setup it would provision today.
     */
    private async ensureClean(slot: Slot, timings: SpriteAcquisitionTimings): Promise<void> {
        if (slot.clean && slot.sprite && slot.state?.setupHash === this.deps.bundle().hash) return;
        const client = await this.deps.client();
        const started = Date.now();
        let sprite: SpriteLike | undefined;
        try {
            sprite = await client.getSprite(slot.name);
        } catch (error) {
            if (spritesErrorStatus(error) !== 404) throw error;
        }
        timings.wakeMs = Date.now() - started;
        const recorded = sprite ? this.readState(slot) : undefined;
        if (sprite && recorded && recorded.setupHash === this.deps.bundle().hash && recorded.spriteId === (sprite.id ?? '')) {
            // Left by a worker that stopped mid-run, or by a release that failed: stop what may still run, then restore.
            const restoreStarted = Date.now();
            try {
                const stopped = await execOnSprite(sprite, 'sudo', ['-n', '/bin/bash', SPRITES_LAUNCHER, 'signal', 'KILL'], { timeout: SIGNAL_TIMEOUT_MS });
                if (stopped.exitCode !== 0) throw new Error(`processes of an earlier run could not be stopped (exit ${stopped.exitCode})`);
                await restoreCleanCheckpoint(sprite, recorded);
                slot.sprite = sprite;
                slot.state = recorded;
                slot.clean = true;
                timings.restoreMs = Date.now() - restoreStarted;
                return;
            } catch (error) {
                logger.error({ sprite: slot.name, error: this.message(error) }, 'Could not restore the Sprite to its clean checkpoint; destroying it and provisioning a new one');
            }
        }
        const provisionStarted = Date.now();
        await this.replace(slot);
        timings.provisionMs = Date.now() - provisionStarted;
    }

    /**
     * A Sprite at its clean checkpoint, for one run. It must be given back
     * through {@link recycle}. `signal` (a cancellation, or the run's deadline)
     * ends the wait for a free Sprite and the wait for its preparation alike.
     */
    async acquire(signal: AbortSignal, timings: SpriteAcquisitionTimings = {}): Promise<SpriteLease> {
        const queued = Date.now();
        const slot = await this.takeSlot(signal);
        timings.queueMs = Date.now() - queued;
        const preparing = this.ensureClean(slot, timings);
        try {
            await untilAborted(preparing, signal);
            signal.throwIfAborted();
        } catch (error) {
            // Not handed to a run: a Sprite that reached its clean checkpoint stays clean. A preparation the caller
            // no longer waits for keeps the Sprite (and its lock) until it settled, so nothing else touches it meanwhile.
            void preparing.then(noop, noop).then(() => this.free(slot));
            throw error;
        }
        // From here the Sprite is the run's: nothing but recycle() makes it clean again.
        slot.clean = false;
        return { name: slot.name, slot: slot.index, sprite: slot.sprite! };
    }

    /**
     * Ends a run's hold on its Sprite: restores the clean checkpoint, and when
     * that fails (or `destroy` is set because the run's processes could not be
     * confirmed dead) destroys the Sprite and provisions a new one. There is
     * no path that frees the Sprite for another run without one of the two.
     */
    async recycle(lease: SpriteLease, options: { destroy?: boolean; reason?: string } = {}): Promise<SpriteRecycleOutcome> {
        const slot = this.slot(lease.slot);
        const started = Date.now();
        try {
            if (!options.destroy && slot.sprite && slot.state) {
                try {
                    await restoreCleanCheckpoint(slot.sprite, slot.state);
                    slot.clean = true;
                    return { action: 'restored', durationMs: Date.now() - started };
                } catch (error) {
                    logger.error({ sprite: slot.name, error: this.message(error) }, 'Could not restore the Sprite to its clean checkpoint; destroying it and provisioning a new one');
                }
            } else {
                logger.warn({ sprite: slot.name, reason: options.reason }, 'Destroying the Sprite instead of restoring it');
            }
            await this.replace(slot);
            return { action: 'replaced', durationMs: Date.now() - started };
        } catch (error) {
            // Neither restored nor replaced: the slot is not clean, so whichever run takes it next replaces the Sprite first.
            slot.clean = false;
            logger.error({ sprite: slot.name, error: this.message(error) }, 'Could not replace the Sprite; it will be replaced before its next run');
            return { action: 'failed', durationMs: Date.now() - started };
        } finally {
            this.free(slot);
        }
    }
}
