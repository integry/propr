import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { FlyMachinesApiError, type FlyCreateMachineRequest, type FlyMachine, type FlyMachinesClient } from './flyMachinesApi.js';

/** Metadata key holding a run's creation id: how a Machine whose create response was lost is found again. */
export const FLY_CREATION_METADATA_KEY = 'propr_creation';

/**
 * A create the API is still processing when its response is lost (the
 * client's timeout, a dropped connection) completes within this long of the
 * request. It includes the image pull and placement, bounded like a start.
 */
export const FLY_CREATE_SETTLE_MS = 10 * 60_000;

/**
 * Whether a failed create may still have created its Machine: anything but
 * the API refusing the request (a 4xx other than a request timeout). A lost
 * or timed-out response, a 5xx, or a success without a Machine id all may.
 */
export function flyCreateOutcomeUncertain(error: unknown): boolean {
    if (!(error instanceof FlyMachinesApiError)) return true;
    return error.status < 400 || error.status === 408 || error.status >= 500;
}

/**
 * One run's Machine create, tagged with a unique creation id in the
 * Machine's metadata. A create whose outcome is uncertain leaves a cleanup
 * obligation: the Machine it may have created is looked up by that id (and
 * only by it) and destroyed. The obligation ends on evidence only: the
 * Machine found was destroyed, or a lookup that succeeded found none once
 * the create could no longer complete ({@link FLY_CREATE_SETTLE_MS}). A
 * lookup or destroy that fails keeps it.
 */
export class FlyMachineCreation {
    readonly id = randomUUID();
    /** While a Machine of an uncertain create may exist: until when that create could still complete. */
    private unresolvedUntil?: number;
    private reconciling?: Promise<void>;

    constructor(private readonly client: FlyMachinesClient, private readonly runName: string, private readonly now: () => number) {}

    /** A Machine of an uncertain create may exist: {@link reconcile} has to rule it out. */
    get unresolved(): boolean {
        return this.unresolvedUntil !== undefined;
    }

    /**
     * Creates the Machine (`request` must carry this creation id). On an
     * uncertain failure the Machine is looked for once (and destroyed) before
     * the create's error is rethrown; the obligation stays when that did not
     * settle it.
     */
    async create(request: FlyCreateMachineRequest): Promise<FlyMachine> {
        const requestedAt = this.now();
        try {
            return await this.client.createMachine(request);
        } catch (error) {
            if (!flyCreateOutcomeUncertain(error)) throw error;
            this.unresolvedUntil = requestedAt + FLY_CREATE_SETTLE_MS;
            logger.warn({ run: this.runName, creation: this.id, error: (error as Error).message }, 'Fly Machine create failed without a definitive answer; looking for the Machine it may have created');
            await this.reconcile().catch(() => undefined);
            throw error;
        }
    }

    /**
     * Settles the obligation, if there is one: destroys the Machine with this
     * creation id. Rejects while one may still exist (the lookup or destroy
     * failed, or none was found while the create could still complete).
     */
    reconcile(): Promise<void> {
        if (this.unresolvedUntil === undefined) return Promise.resolve();
        this.reconciling ??= this.lookUpAndDestroy().finally(() => { this.reconciling = undefined; });
        return this.reconciling;
    }

    private async lookUpAndDestroy(): Promise<void> {
        // Taken before the request: a lookup that finds nothing proves absence only from when it was sent.
        const lookedUpAt = this.now();
        const found = await this.client.listMachines({ [FLY_CREATION_METADATA_KEY]: this.id });
        for (const machine of found) {
            await this.client.destroyMachine(machine.id);
            logger.warn({ run: this.runName, creation: this.id, machine: machine.id }, 'Destroyed the Fly Machine of a create whose response was lost');
        }
        if (found.length === 0 && lookedUpAt < this.unresolvedUntil!) {
            throw new Error(`The create of the Fly Machine for ${this.runName} may still complete (creation ${this.id}); looking for its Machine again`);
        }
        this.unresolvedUntil = undefined;
    }
}
