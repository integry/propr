import logger from '../../../utils/logger.js';
import { MachineCreateUnconfirmedError, MachineNotFoundAfterCreateError, type MachinesApi } from './api.js';
import type { FlyConfig } from './config.js';

/**
 * Per-app FIFO limit on the Machines this worker process has created and not yet destroyed: agent
 * Machines, derived-image build Machines, and Machines an earlier worker process left behind.
 */
interface Slots { active: number; waiting: Array<{ grant(): void }> }

const apps = new Map<string, Slots>();

/** `PROPR_FLY_MACHINES_MAX`: unset or empty means no limit. */
export function flyMachinesMax(env: NodeJS.ProcessEnv): number | undefined {
    const raw = env.PROPR_FLY_MACHINES_MAX?.trim();
    if (!raw) return;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid PROPR_FLY_MACHINES_MAX');
    return value;
}

/**
 * Waits until fewer than `max` Machines of `app` are held by this process, then takes a slot.
 * Runs over the cap queue in arrival order instead of failing; an aborted wait leaves the queue.
 * The returned release is idempotent.
 */
export async function acquireFlyMachineSlot(app: string, max: number | undefined, signal: AbortSignal, run?: string): Promise<() => void> {
    if (max === undefined) return () => {};
    signal.throwIfAborted();
    let slots = apps.get(app);
    if (!slots) apps.set(app, slots = { active: 0, waiting: [] });
    const state = slots;
    let held = false;
    const release = () => {
        if (!held) return;
        held = false;
        state.active--;
        drain(state, max);
    };
    if (state.active < max && !state.waiting.length) {
        state.active++;
        held = true;
        return release;
    }
    logger.info({ app, run, max, active: state.active, queued: state.waiting.length + 1 }, 'Fly Machines at PROPR_FLY_MACHINES_MAX; run queued');
    await new Promise<void>((resolve, reject) => {
        const waiter = { grant: () => { signal.removeEventListener('abort', onAbort); held = true; resolve(); } };
        const onAbort = () => {
            const index = state.waiting.indexOf(waiter);
            if (index >= 0) state.waiting.splice(index, 1);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        state.waiting.push(waiter);
    });
    return release;
}

function drain(state: Slots, max: number) {
    while (state.active < max && state.waiting.length) {
        state.active++;
        state.waiting.shift()!.grant();
    }
}

/**
 * Pacing for checks on Machines that outlive their run, and how long a lost create is looked up for before
 * an empty lookup counts as absence (as for build Machines, `lostCreateWindowMs`); tests shorten them.
 */
export const retainedMachineChecks = { intervalMs: 30_000, maxIntervalMs: 300_000, lostCreateWindowMs: 60_000 };

/**
 * Keeps a run's slot until `confirmGone` resolves true, meaning the Machine no longer exists at Fly
 * (a Machine kept for recovery, or one a lost create may have launched). The first check runs after
 * `afterMs`, the guest's recovery window; later checks back off to one every five minutes and continue
 * until absence is confirmed. A failed check is not evidence of absence. Timers do not hold the worker open.
 */
export function releaseSlotWhenGone(release: () => void, confirmGone: () => Promise<boolean>, afterMs: number, context: Record<string, unknown>) {
    let interval = retainedMachineChecks.intervalMs;
    const schedule = (ms: number) => { setTimeout(() => void check(), ms).unref(); };
    const check = async () => {
        let gone = false;
        try { gone = await confirmGone(); }
        catch (err) { logger.debug({ ...context, err }, 'Fly Machine existence check failed; keeping its capacity slot'); }
        if (gone) {
            logger.info(context, 'Fly Machine kept past its run is gone; capacity slot freed');
            release();
            return;
        }
        schedule(interval);
        interval = Math.min(interval * 2, retainedMachineChecks.maxIntervalMs);
    };
    logger.info({ ...context, afterMs }, 'Fly Machine kept past its run holds its capacity slot until it is gone');
    schedule(afterMs);
}

/**
 * Deletes a Machine, agent or build. A 404 counts as deleted (see `MachinesClient.destroy`), and so does a failed
 * deletion once Fly confirms the Machine gone (deleted elsewhere, reclaimed, or a deletion whose response was
 * lost), which also ends the caller's retries. Otherwise the deletion's error is thrown and the slot stays held.
 */
export async function deleteFlyMachine(api: MachinesApi, machine: string, context: Record<string, unknown>) {
    try { await api.destroy(machine); }
    catch (error) {
        const gone = await api.gone(machine).catch(() => false);
        if (!gone) throw error;
        logger.info({ ...context, machine, err: error }, 'Fly Machine deletion failed but the Machine is gone; capacity slot freed');
    }
}

interface UndeletedMachine {
    config: Pick<FlyConfig, 'app' | 'maxMachines' | 'credentialRetention'>;
    /** The run's Machine ID, when create returned one. */
    machine?: string;
    /** Create failed without a confirmed outcome (its lookup failed, or found nothing yet), so a Machine may exist without an ID. */
    createUnconfirmed: boolean;
    launchName: string;
    run: string;
}

/**
 * Frees the slot of a run whose Machine this worker did not delete. Only a run that never created a Machine frees it
 * at once. A Machine kept for recovery holds it until Fly confirms it is gone; a lost create holds it until a lookup
 * after `lostCreateWindowMs` finds nothing, or until a found Machine is deleted (its agent never started: it waits
 * for the start gate).
 */
export function releaseUndeletedFlyMachineSlot(release: () => void, api: MachinesApi, { config, machine, createUnconfirmed, launchName, run }: UndeletedMachine) {
    const context = { app: config.app, run, machine };
    if (config.maxMachines === undefined) release();
    else if (machine) releaseSlotWhenGone(release, () => api.gone(machine), config.credentialRetention * 1000, context);
    else if (createUnconfirmed) {
        // The create's own lookups may already have found nothing, and Fly may still be creating the Machine: an
        // empty lookup frees the slot only once the window has passed. A Machine found is deleted first.
        const deadline = Date.now() + retainedMachineChecks.lostCreateWindowMs;
        releaseSlotWhenGone(release, async () => {
            const found = await api.find(launchName);
            if (found) { await deleteFlyMachine(api, found, context); return true; }
            return Date.now() >= deadline;
        }, 0, context);
    }
    else release();
}

/**
 * One run's hold on a `PROPR_FLY_MACHINES_MAX` slot: taken before its Machine is created and freed only by a
 * confirmed deletion, or by `releaseUndeleted` once the run settles without deleting its Machine. Agent runs and
 * derived-image build Machines both hold one.
 */
export class FlyMachineSlot {
    private release?: () => void;
    /** A create whose response was lost and not adopted (its lookup failed, or found nothing yet): a Machine may exist without an ID. */
    private createUnconfirmed = false;
    /** Time spent waiting for the slot, including any wait to take it again after `releaseUnused`. */
    queueMs = 0;

    constructor(private readonly api: MachinesApi, private readonly config: UndeletedMachine['config'], private readonly launchName: string, private readonly run: string) {}

    /** Queues in arrival order while the app is at its cap; rejects if `signal` aborts first. A no-op while the slot is held. */
    async acquire(signal: AbortSignal) {
        if (this.release) return;
        const queuedAt = Date.now();
        this.release = await acquireFlyMachineSlot(this.config.app, this.config.maxMachines, signal, this.run);
        this.queueMs += Date.now() - queuedAt;
    }

    /**
     * Frees the slot while no Machine of this hold exists: Fly refused the create, or the Machine is confirmed gone.
     * `acquire` takes it again. Idempotent.
     */
    releaseUnused() {
        const release = this.release;
        this.release = undefined;
        release?.();
    }

    /** Runs the create, recording whether a failure leaves the Machine's existence unknown. */
    create<T>(create: () => Promise<T>) {
        return create().catch((error: unknown) => {
            this.createUnconfirmed = error instanceof MachineCreateUnconfirmedError || error instanceof MachineNotFoundAfterCreateError;
            throw error;
        });
    }

    /** Deletes the Machine, then frees the slot; see `deleteFlyMachine` for when a failed deletion counts. */
    async destroy(machine: string) {
        await deleteFlyMachine(this.api, machine, { app: this.config.app, run: this.run });
        this.releaseUnused();
    }

    releaseUndeleted(machine: string | undefined) {
        const release = this.release;
        this.release = undefined;
        if (release) releaseUndeletedFlyMachineSlot(release, this.api, { config: this.config, machine, createUnconfirmed: this.createUnconfirmed, launchName: this.launchName, run: this.run });
    }
}
