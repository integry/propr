import { setTimeout as delay } from 'node:timers/promises';
import logger from '../../../utils/logger.js';
import { MachinesHttpError, type MachineLaunch, type MachinesApi } from './api.js';

/**
 * Fly counts every Machine of the organization against its machine limit, including ones ProPR does not hold a
 * `PROPR_FLY_MACHINES_MAX` slot for: another worker's, or one whose deletion returned while Fly still counts it.
 * Such a refusal is a wait for capacity, not a run failure. Delays double from `firstDelayMs` up to `maxDelayMs`,
 * and the create is given up `totalMs` after the first refusal. Tests shorten them.
 */
export const machineLimitRetry = { firstDelayMs: 5000, maxDelayMs: 60_000, totalMs: 5 * 60_000 };

/** Fly kept refusing the create because the organization is at its machine limit; no Machine of the launch name exists. */
export class FlyMachineLimitError extends Error {}

/** Whether Fly refused a create (HTTP 422 on the POST) because the organization has reached its machine limit. */
export function machineLimitRefusal(error: unknown): error is MachinesHttpError {
    return error instanceof MachinesHttpError && error.method === 'POST' && error.status === 422 && /machine limit/i.test(error.message);
}

interface LimitedCreate {
    signal?: AbortSignal;
    context: Record<string, unknown>;
    onBootStart?: (timestamp: number) => void;
    /** Called immediately before each create request, the first included. */
    onAttempt?: () => void;
    /** False stops the waiting (the run is stopping): the refusal is thrown as is. */
    mayRetry?: () => boolean;
}

/**
 * Creates the Machine, retrying the same launch (the same unique name, so a retry never adds a second Machine)
 * while Fly refuses it for the organization's machine limit. The caller keeps its capacity slot meanwhile. Each
 * refusal logs the app's Machines (ID, state and name only), so the log shows what Fly counted.
 */
export async function createWithinMachineLimit(api: MachinesApi, launch: MachineLaunch, { signal, context, onBootStart, onAttempt, mayRetry }: LimitedCreate) {
    let firstRefusal: number | undefined;
    let wait = machineLimitRetry.firstDelayMs;
    for (let attempt = 1; ; attempt++) {
        onAttempt?.();
        try { return await api.create(launch, onBootStart); }
        catch (error) {
            if (!machineLimitRefusal(error)) throw error;
            firstRefusal ??= Date.now();
            await logAppMachines(api, { ...context, attempt });
            const remaining = firstRefusal + machineLimitRetry.totalMs - Date.now();
            if (mayRetry && !mayRetry()) throw error;
            if (remaining <= 0) {
                throw new FlyMachineLimitError(`Fly organization machine limit reached: Fly refused the Machine create ${attempt} times`
                    + ` over ${Math.round((Date.now() - firstRefusal) / 1000)}s (${error.message}). Delete Machines in the Fly organization or raise its limit, then retry the run.`,
                { cause: error });
            }
            const delayMs = Math.min(wait, remaining);
            logger.warn({ ...context, attempt, delayMs }, 'Fly organization machine limit reached; retrying create');
            await delay(delayMs, undefined, { signal });
            wait = Math.min(wait * 2, machineLimitRetry.maxDelayMs);
        }
    }
}

/** Diagnostics for a machine-limit refusal: the agent app's Machines, without their configuration or env. */
async function logAppMachines(api: MachinesApi, context: Record<string, unknown>) {
    if (!api.list) return;
    try {
        const machines = (await api.list('')).map(({ id, state, name }) => ({ id, state, name }));
        logger.warn({ ...context, machines }, 'Fly organization machine limit reached; Machines in the agent app');
    } catch (err) {
        logger.warn({ ...context, err }, 'Fly organization machine limit reached; listing the agent app\'s Machines failed');
    }
}
