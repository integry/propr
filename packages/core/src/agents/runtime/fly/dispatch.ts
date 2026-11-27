import type { AgentRuntimePackageLoader } from '../agentRuntimePackageIndex.js';
import { startupStep } from '../startupStep.js';
import { MachineCreateUnconfirmedError, MachineNotFoundAfterCreateError, type MachineLaunch, type MachinesApi } from './api.js';
import { acquireFlyMachineSlot } from './capacity.js';
import type { FlyConfig } from './config.js';
import { createAgentMachine, selectFlyPackageImage, type FlyPackageImages, type FlyPackageSelection, type SelectOptions } from './derivedImage.js';

interface DispatchInput {
    images: FlyPackageImages | undefined;
    loadPackages: AgentRuntimePackageLoader;
    api: MachinesApi;
    config: FlyConfig;
    prepared: { launch: MachineLaunch; installPackages(packages: readonly string[]): void };
    signal: AbortSignal;
    run: string;
}

/** What a Fly run has before it creates its agent Machine. */
export interface FlyDispatch {
    /** The configured list, whether the derived image has it or the Machine installs it at start. */
    configured: readonly string[];
    selectOptions: SelectOptions;
    /** The image selection and the time spent waiting for it; a retried create may update both. */
    image: { selection: FlyPackageSelection; imageWaitMs: number };
    /** Frees the run's `PROPR_FLY_MACHINES_MAX` slot, whichever one it holds now (idempotent; a no-op without the cap). */
    release: () => void;
    /**
     * Takes the slot again after a refused create gave it up to prepare a replacement image; the wait adds to
     * `queueMs`. A no-op while a slot is held.
     */
    reacquire: () => Promise<void>;
    /** Time spent waiting for the slot, including any wait to take it again. */
    queueMs: number;
}

/**
 * Everything before the agent Machine create: read the list, count build Machines an earlier worker
 * process left against capacity, select the derived image (building it when needed, or falling back to
 * the start-time install), then wait for a capacity slot. The slot comes last, after any build Machine
 * this run needed is confirmed gone, so a run never holds a build Machine and its agent Machine at once.
 */
export async function dispatchFlyRun({ images, loadPackages, api, config, prepared, signal, run }: DispatchInput): Promise<FlyDispatch> {
    const startedAt = Date.now();
    // Read for every run, so a Settings change applies to the next Machine. An unreadable
    // or invalid list fails the run rather than starting it without its packages.
    const configured = await loadPackages();
    // Shared by concurrent runs and continuing without this one: a cancelled run stops waiting for it at once,
    // while the leftovers it found keep their capacity slots until they are gone.
    if (images) await startupStep(signal, () => images.reconcileLeftovers(api, config));
    const selectOptions: SelectOptions = { api, config, packages: configured, signal, run, checkAvailability: loadPackages.checkAvailability };
    // The index check runs only when this selection installs the list (a build, or the start-time install).
    const selection = await selectFlyPackageImage(images, prepared, selectOptions);
    const image = { selection, imageWaitMs: Date.now() - startedAt };
    // Over PROPR_FLY_MACHINES_MAX the run queues here; the slot is held until its agent Machine is destroyed or confirmed gone.
    // The slot holder: release() frees whichever slot is held now, so cleanup stays idempotent across a refused
    // create that gave the slot up to rebuild its image and took a new one afterwards.
    let held: (() => void) | undefined;
    const take = async () => {
        const queuedAt = Date.now();
        const release = await acquireFlyMachineSlot(config.app, config.maxMachines, signal, run);
        dispatch.queueMs += Date.now() - queuedAt;
        held = release;
    };
    const dispatch: FlyDispatch = {
        configured, selectOptions, image, queueMs: 0,
        release: () => { const release = held; held = undefined; release?.(); },
        reacquire: async () => { if (!held) await take(); },
    };
    await take();
    return dispatch;
}

interface AgentCreate {
    api: MachinesApi;
    images: FlyPackageImages | undefined;
    prepared: DispatchInput['prepared'];
    dispatch: FlyDispatch;
    mayRetry(): boolean;
    onAttempt(): void;
    onBootStart(timestamp: number): void;
    /** A create whose response was lost and not adopted: a Machine may exist without an ID. */
    onUnconfirmed(): void;
}

/** Creates the agent Machine from the selected image (see `createAgentMachine`), reporting an unconfirmed create. */
export async function createFlyAgentMachine({ api, images, prepared, dispatch, mayRetry, onAttempt, onBootStart, onUnconfirmed }: AgentCreate) {
    try {
        return await createAgentMachine({ api, images, prepared, options: dispatch.selectOptions, state: dispatch.image,
            slot: { release: dispatch.release, reacquire: dispatch.reacquire }, mayRetry, onAttempt, onBootStart });
    } catch (error) {
        if (error instanceof MachineCreateUnconfirmedError || error instanceof MachineNotFoundAfterCreateError) onUnconfirmed();
        throw error;
    }
}

/** The Fly-specific compute usage fields: the capacity queue (with a cap) and the derived-image wait (with packages). */
export function flyDispatchUsage(dispatch: FlyDispatch, config: FlyConfig) {
    return { ...(config.maxMachines !== undefined && { queueMs: dispatch.queueMs }),
        ...(dispatch.configured.length > 0 && { imageWaitMs: dispatch.image.imageWaitMs }) };
}
