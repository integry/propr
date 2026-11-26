import logger from '../../../utils/logger.js';

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
