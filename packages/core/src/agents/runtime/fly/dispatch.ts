import type { AgentRuntimePackageLoader } from '../agentRuntimePackageIndex.js';
import { startupStep } from '../startupStep.js';
import type { MachineLaunch, MachinesApi } from './api.js';
import type { FlyMachineSlot } from './capacity.js';
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
    /** The run's capacity slot, taken last (see `dispatchFlyRun`). */
    slot: FlyMachineSlot;
}

/** What a Fly run has before it creates its agent Machine. */
export interface FlyDispatch {
    /** The configured list, whether the derived image has it or the Machine installs it at start. */
    configured: readonly string[];
    selectOptions: SelectOptions;
    /** The image selection and the time spent waiting for it; a retried create may update both. */
    image: { selection: FlyPackageSelection; imageWaitMs: number };
    /** The run's `PROPR_FLY_MACHINES_MAX` slot; its `queueMs` includes any wait to take it again after a refused create. */
    slot: FlyMachineSlot;
    signal: AbortSignal;
}

/**
 * Everything before the agent Machine create: read the list, count build Machines an earlier worker
 * process left against capacity, select the derived image (building it when needed, or falling back to
 * the start-time install), then wait for a capacity slot. The slot comes last, after any build Machine
 * this run needed is confirmed gone, so a run never holds a build Machine and its agent Machine at once.
 */
export async function dispatchFlyRun({ images, loadPackages, api, config, prepared, signal, run, slot }: DispatchInput): Promise<FlyDispatch> {
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
    await slot.acquire(signal);
    return { configured, selectOptions, image, slot, signal };
}

interface AgentCreate {
    api: MachinesApi;
    images: FlyPackageImages | undefined;
    prepared: DispatchInput['prepared'];
    dispatch: FlyDispatch;
    mayRetry(): boolean;
    onAttempt(): void;
    onBootStart(timestamp: number): void;
}

/**
 * Creates the agent Machine from the selected image (see `createAgentMachine`). A refused create gives the slot up
 * while it prepares a replacement image and takes it again before the next create; a lost create that was not
 * adopted (unconfirmed, or not found yet) keeps it until the Machine is confirmed gone or absent.
 */
export function createFlyAgentMachine({ api, images, prepared, dispatch: { slot, signal, selectOptions, image }, mayRetry, onAttempt, onBootStart }: AgentCreate) {
    return slot.create(() => createAgentMachine({ api, images, prepared, options: selectOptions, state: image,
        slot: { release: () => slot.releaseUnused(), reacquire: () => slot.acquire(signal) }, mayRetry, onAttempt, onBootStart }));
}

/** The Fly-specific compute usage fields: the capacity queue (with a cap) and the derived-image wait (with packages). */
export function flyDispatchUsage(dispatch: FlyDispatch, config: FlyConfig) {
    return { ...(config.maxMachines !== undefined && { queueMs: dispatch.slot.queueMs }),
        ...(dispatch.configured.length > 0 && { imageWaitMs: dispatch.image.imageWaitMs }) };
}
