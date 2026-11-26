import logger from '../../../utils/logger.js';
import { createRejected, type MachineLaunch, type MachineRef, type MachinesApi } from './api.js';

/** Per-app FIFO limit on the Machines this worker process has created and not yet destroyed. */
interface Slots { active: number; waiting: Array<{ grant(): void }> }

const apps = new Map<string, Slots>();

/** `PROPR_FLY_MACHINES_MAX`: unset or empty means no limit. */
export function flyMachinesMax(env: NodeJS.ProcessEnv): number | undefined {
    const raw = env.PROPR_FLY_MACHINES_MAX?.trim();
    if (!raw) return;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid PROPR_FLY_MACHINES_MAX');
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

/** How often a Machine that this worker does not delete is checked for disappearance. */
export const MACHINE_GONE_POLL_MS = 30_000;

/**
 * One run's capacity slot, held until every Machine the run created (its agent
 * Machine and any image build Machine) is confirmed gone and the run has
 * finished. A Machine counts from before its create request is sent, so a lost
 * create response or a Machine kept for recovery never frees the slot early.
 */
export class MachineReservation {
    private outstanding = 0;
    private closed = false;

    constructor(private readonly release: () => void, private readonly limited: boolean) {}

    /** Counts one Machine that may exist until the returned idempotent callback confirms it gone. */
    track(): () => void {
        this.outstanding++;
        let open = true;
        return () => {
            if (!open) return;
            open = false;
            this.outstanding--;
            this.settle();
        };
    }

    /** Creates a counted Machine. A failure that does not prove absence leaves it counted until a lookup by name confirms it gone. */
    async create(api: MachinesApi, launch: MachineLaunch, onBootStart?: (timestamp: number) => void): Promise<{ id: string; gone: () => void }> {
        const gone = this.track();
        try {
            return { id: await api.create(launch, onBootStart), gone };
        } catch (error) {
            if (createRejected(error)) gone();
            else this.watch(api, { name: launch.name }, gone);
            throw error;
        }
    }

    /**
     * For a Machine this worker will not delete (kept for recovery, or of unknown
     * creation): poll until Fly confirms it gone, e.g. after its guest exits and
     * auto-destroy removes it or an operator deletes it, then call `gone`.
     */
    watch(api: MachinesApi, machine: MachineRef, gone: () => void, interval = MACHINE_GONE_POLL_MS) {
        // Without PROPR_FLY_MACHINES_MAX the slot is not counted, so there is nothing to hold.
        if (!this.limited) { gone(); return; }
        const poll = async () => {
            if (await api.gone(machine).catch(() => false)) gone();
            else setTimeout(() => { void poll(); }, interval).unref();
        };
        void poll();
    }

    /** The run has finished; the slot is released once no counted Machine remains. */
    close() {
        this.closed = true;
        this.settle();
    }

    private settle() {
        if (this.closed && this.outstanding === 0) this.release();
    }
}
