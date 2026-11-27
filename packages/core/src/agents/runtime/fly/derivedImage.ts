import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '../../../utils/logger.js';
import { AgentRuntimePackageUnavailableError } from '../agentRuntimePackageIndex.js';
import { agentRuntimePackagesLogFields } from '../agentRuntimePackageProfile.js';
import { startupStep } from '../startupStep.js';
import { createRejected, type MachineLaunch, type MachinesApi } from './api.js';
import { acquireFlyMachineSlot } from './capacity.js';
import type { FlyConfig } from './config.js';
import {
    activeBuilders, buildDeadlineMs, buildLayer, DEFAULT_FLY_PACKAGE_IMAGE_TIMINGS, FLY_BUILDER_PREFIX, FlyBuilderCleanupError,
    FlyPackageImageError, FlyPackageInstallFailure, pushDerived, resolveBuilder,
    type FlyBuilderMachine, type FlyPackageImageTimings, type SelectOptions,
} from './imageBuilder.js';
import { FLY_REGISTRY, FlyRegistry, parseFlyImage, type ImageManifest, type RegistryApi } from './registry.js';

export { FLY_BUILDER_PREFIX, FlyBuilderCleanupError, FlyPackageImageError, FlyPackageInstallFailure };
export type { FlyBuilderMachine, FlyPackageImageTimings, SelectOptions };

/** Part of every derived tag: bump it when the layer recipe changes so older images are not reused. */
// 2: recipe 1 left every regular file out on an overlay root (layers of a few hundred bytes); never reuse those.
export const FLY_PACKAGE_IMAGE_RECIPE = 2;
const DIGEST = /^sha256:[0-9a-f]{64}$/;


interface Derived { image: string; repository: string; tag: string; digest: string }
interface Preparation { key: string; configured: string; registry: RegistryApi; repository: string; base: string | { digest: string; manifest: ImageManifest } }
interface CachedImage { pending: Promise<Derived>; checkedAt: number; registry: RegistryApi; derived?: Derived }

// Shared by every runtime instance in the worker process: one build per base image and package list.
const images = new Map<string, CachedImage>();
const failures = new Map<string, number>();
const installFailures = new Map<string, { message: string; at: number }>();
/**
 * Build Machines not yet confirmed deleted, by unique name, with the configured image and package list they
 * were built for (none for a leftover found at startup) and the capacity slot they hold until confirmed gone.
 */
interface UnresolvedBuilder extends FlyBuilderMachine { configured?: string; reconciling?: Promise<void>; release(): void; timer?: NodeJS.Timeout }
const unresolvedBuilders = new Map<string, UnresolvedBuilder>();
/** Per app: the startup search for build Machines an earlier worker process left (shared by concurrent runs). */
const leftoverSearches = new Map<string, Promise<void>>();

/** The derived tag for a base manifest and package list; the same inputs on any worker give the same tag. */
export function flyPackageImageTag(baseDigest: string, packages: readonly string[]) {
    const hash = crypto.createHash('sha256').update(JSON.stringify({ recipe: FLY_PACKAGE_IMAGE_RECIPE, base: baseDigest, packages })).digest('hex');
    return 'propr-packages-' + hash.slice(0, 24);
}

/**
 * Derived Fly Machine images with the instance runtime packages preinstalled.
 * The first run for a base image and package list builds the image: a build
 * Machine from the base image runs the apt install and turns the filesystem
 * change into a layer, which the worker downloads, verifies and pushes with the
 * base layers as `registry.fly.io/<repository>:propr-packages-<hash>`. Later
 * runs, on any worker, find that tag and start from it with nothing to install.
 * The build Machine never receives the Fly token.
 */
export class FlyPackageImages {
    private readonly timings: FlyPackageImageTimings;
    constructor(private readonly registryFor: (config: FlyConfig) => RegistryApi = config => new FlyRegistry(config.token),
        timings: Partial<FlyPackageImageTimings> = {}) {
        this.timings = { ...DEFAULT_FLY_PACKAGE_IMAGE_TIMINGS, ...timings };
    }

    /**
     * Forget a cached derived image the Machines API refused (its tag was deleted or garbage-collected):
     * the next run checks the registry again and rebuilds it when it is gone.
     */
    invalidate(image: string) {
        for (const [key, cached] of images) if (cached.derived?.image === image) images.delete(key);
    }

    /**
     * The image to run with `packages` preinstalled, or undefined to install them at Machine start
     * (an image outside registry.fly.io, or a registry or build failure, retried after ten minutes).
     * An apt failure on the build Machine fails the run, and every run for the same base manifest
     * and package list during the backoff, with the same error.
     */
    async select(options: SelectOptions): Promise<string | undefined> {
        const { config, packages, signal, run } = options;
        const base = parseFlyImage(config.image);
        const fields = { run, ...agentRuntimePackagesLogFields(packages) };
        if (!base) {
            logger.warn({ ...fields, image: config.image }, 'PROPR_FLY_IMAGE is not a registry.fly.io image; installing agent runtime packages at Fly Machine start');
            return;
        }
        // Failures back off per configured image and package list, whichever base manifest it resolved to.
        const configured = JSON.stringify([config.app, config.image, packages]);
        const { failureBackoffMs } = this.timings;
        try {
            // Before anything else, including the start-time install fallback: a build Machine an
            // earlier run could not confirm deleted is deleted first, or this run fails as well.
            if (hasUnresolvedBuilders(configured)) await this.reconcileBuilders(options, configured);
            if (Date.now() - (failures.get(configured) ?? -Infinity) < failureBackoffMs) return;
            const registry = this.registryFor(config);
            // A tag can be pushed to while the worker runs: resolve it for every run, so the cached
            // image follows the base manifest it names now. A digest names one manifest for good.
            const resolved = DIGEST.test(base.reference) ? undefined : await startupStep(signal, () => registry.manifest(base.repository, base.reference));
            const key = JSON.stringify([config.app, base.repository, resolved?.digest ?? base.reference, packages]);
            const failed = installFailures.get(key);
            if (failed && Date.now() - failed.at < failureBackoffMs) {
                logger.warn({ ...fields }, 'Agent runtime packages failed to install on this base image recently; failing the run without another build');
                throw new FlyPackageInstallFailure(failed.message);
            }
            installFailures.delete(key);
            const cached = await this.cachedImage(options, { key, configured, registry, repository: base.repository, base: resolved ?? base.reference });
            const pending = cached.pending;
            return (await startupStep(signal, () => pending)).image;
        } catch (error) {
            if (signal.aborted || error instanceof FlyPackageImageError || error instanceof AgentRuntimePackageUnavailableError) throw error;
            failures.set(configured, Date.now());
            logger.warn({ ...fields, err: error }, 'Could not prepare the derived Fly Machine image; installing agent runtime packages at Fly Machine start');
            return;
        }
    }

    /**
     * The cached image or shared preparation for `key`, started here when there is none. The lookup and
     * the start happen after the last await, so concurrent runs share one build; and a build starts only
     * once no build Machine for `configured` is left unresolved.
     */
    private async cachedImage(options: SelectOptions, start: Preparation) {
        const { key, configured } = start;
        let cached = images.get(key);
        if (cached?.derived && Date.now() - cached.checkedAt >= this.timings.recheckAfterMs && !await this.stillPublished(cached, cached.derived, options.signal)) {
            // Another run may have found the same tag missing during the recheck and already started the
            // replacement: remove only the entry this run checked, and adopt the replacement below.
            if (images.get(key) === cached) images.delete(key);
            cached = undefined;
        }
        for (;;) {
            // After an await, another run may have started the preparation.
            cached ??= images.get(key);
            if (cached) return cached;
            // A shared build that failed while this run waited on the registry may have left a build Machine behind.
            if (!hasUnresolvedBuilders(configured)) break;
            await this.reconcileBuilders(options, configured);
        }
        options.signal.throwIfAborted();
        return this.startPreparation(options, start);
    }

    /** Starts the shared preparation for `key`. It outlives this run's cancellation: it deletes its own build Machine. */
    private startPreparation(options: SelectOptions, { key, configured, registry, repository, base }: Preparation) {
        const entry: CachedImage = { pending: this.prepare(options, registry, repository, base), checkedAt: Date.now(), registry };
        images.set(key, entry);
        entry.pending.then(derived => { entry.derived = derived; }, error => {
            if (images.get(key) === entry) images.delete(key);
            if (error instanceof FlyPackageInstallFailure) installFailures.set(key, { message: error.message, at: Date.now() });
            // In the same callback as the entry removal: no run can start a build in between.
            if (error instanceof FlyBuilderCleanupError) {
                logger.warn({ run: options.run, machine: error.builder.id ?? null, name: error.builder.name },
                    'Fly image build Machine deletion is unconfirmed; the next run for this image deletes it first');
                this.keepUnresolved({ ...error.builder, configured, release: error.release }, options.api);
            }
        });
        return entry;
    }

    /**
     * Deletes the build Machines earlier runs for this configured image and package list could not
     * confirm deleted. Concurrent runs share one attempt per Machine; while one stays unconfirmed,
     * runs fail with `FlyBuilderCleanupError` and the obligation is kept for the next run.
     */
    private async reconcileBuilders({ api, signal }: SelectOptions, configured: string) {
        for (const builder of [...unresolvedBuilders.values()]) {
            if (builder.configured !== configured || unresolvedBuilders.get(builder.name) !== builder) continue;
            const pending = this.reconcile(api, builder);
            await startupStep(signal, () => pending);
        }
    }

    /** One shared deletion attempt per unresolved build Machine; success frees its capacity slot. */
    private reconcile(api: MachinesApi, builder: UnresolvedBuilder) {
        if (!builder.reconciling) {
            const reconciling = resolveBuilder(api, builder, this.timings).then(() => {
                if (unresolvedBuilders.get(builder.name) === builder) unresolvedBuilders.delete(builder.name);
                clearTimeout(builder.timer);
                builder.release();
                logger.info({ machine: builder.id ?? null, name: builder.name }, 'Deleted a Fly image build Machine left by an earlier run');
            }, error => {
                builder.reconciling = undefined;
                throw error;
            });
            reconciling.catch(() => {});
            builder.reconciling = reconciling;
        }
        return builder.reconciling;
    }

    /**
     * Records a build Machine that may still exist. It keeps its capacity slot, runs for its configured
     * image and package list delete it first, and the worker retries the deletion in the background, so
     * the slot is freed even when no such run comes. The timer does not hold the worker open.
     */
    private keepUnresolved(builder: UnresolvedBuilder, api: MachinesApi) {
        unresolvedBuilders.set(builder.name, builder);
        const schedule = () => {
            builder.timer = setTimeout(() => {
                if (unresolvedBuilders.get(builder.name) !== builder) return;
                this.reconcile(api, builder).catch(error => {
                    logger.debug({ machine: builder.id ?? null, name: builder.name, err: error }, 'Fly image build Machine still unconfirmed deleted; keeping its capacity slot');
                    if (unresolvedBuilders.get(builder.name) === builder) schedule();
                });
            }, this.timings.reconcileMs);
            builder.timer.unref();
        };
        schedule();
    }

    /**
     * Once per app and worker process, before its first build or agent Machine: build Machines an earlier
     * worker process left (found by the `propr-build-` name prefix) hold a capacity slot until Fly confirms
     * them gone. One older than any build may take is deleted; a younger one may be another worker's build in
     * progress, so it is only waited out (its build Machine exits and is auto-destroyed). A failed search is
     * logged and retried by the next run; it does not fail this one.
     */
    async reconcileLeftovers(api: MachinesApi, config: FlyConfig) {
        if (!api.list) return;
        const list = api.list.bind(api);
        let search = leftoverSearches.get(config.app);
        if (!search) {
            search = (async () => {
                const found = await list(FLY_BUILDER_PREFIX);
                const maxAge = buildDeadlineMs(config) + this.timings.removalWindowMs;
                for (const machine of found) {
                    if (machine.state === 'destroyed' || unresolvedBuilders.has(machine.name) || activeBuilders.has(machine.name)) continue;
                    const release = await acquireFlyMachineSlot(config.app, config.maxMachines, AbortSignal.any([]), machine.name);
                    const stale = machine.createdAt === undefined || Date.now() - machine.createdAt >= maxAge;
                    logger.warn({ app: config.app, machine: machine.id, name: machine.name, stale },
                        stale ? 'Deleting a Fly image build Machine left by an earlier worker process' : 'A Fly image build Machine of another worker process is running; counting it against capacity');
                    const builder: UnresolvedBuilder = { name: machine.name, id: machine.id, release };
                    if (stale) {
                        unresolvedBuilders.set(builder.name, builder);
                        this.reconcile(api, builder).catch(() => this.keepUnresolved(builder, api));
                    } else this.watchUntilGone(api, builder);
                }
            })();
            leftoverSearches.set(config.app, search);
            search.catch(error => {
                if (leftoverSearches.get(config.app) === search) leftoverSearches.delete(config.app);
                logger.warn({ app: config.app, err: error }, 'Could not look for Fly image build Machines left by an earlier worker process');
            });
        }
        await search.catch(() => {});
    }

    /** Holds a younger leftover's slot until Fly reports it gone; it is never deleted, since its build may be in progress. */
    private watchUntilGone(api: MachinesApi, builder: UnresolvedBuilder) {
        const check = () => {
            builder.timer = setTimeout(async () => {
                if (await api.gone(builder.id!).catch(() => false)) { builder.release(); return; }
                check();
            }, this.timings.reconcileMs);
            builder.timer.unref();
        };
        check();
    }

    /**
     * Whether a cached image's tag still names its manifest (a cheap tag lookup). An operator may delete
     * `propr-packages-*` tags, or the registry collect them. A registry error keeps the cached image.
     */
    private async stillPublished(cached: CachedImage, derived: Derived, signal: AbortSignal) {
        try {
            const current = await startupStep(signal, () => cached.registry.resolve(derived.repository, derived.tag));
            if (current === derived.digest) { cached.checkedAt = Date.now(); return true; }
            logger.warn({ image: derived.image, tag: derived.tag, current: current ?? null }, 'The derived Fly Machine image is no longer published; preparing it again');
            return false;
        } catch (error) {
            signal.throwIfAborted();
            logger.debug({ image: derived.image, err: error }, 'Could not recheck the derived Fly Machine image; reusing it');
            return true;
        }
    }

    private async prepare(options: SelectOptions, registry: RegistryApi, repository: string,
        base: string | { digest: string; manifest: ImageManifest }): Promise<Derived> {
        const { digest, manifest } = typeof base === 'string' ? await registry.manifest(repository, base) : base;
        const tag = flyPackageImageTag(digest, options.packages);
        const existing = await registry.resolve(repository, tag);
        const derived = (manifestDigest: string): Derived => ({ image: `${FLY_REGISTRY}/${repository}@${manifestDigest}`, repository, tag, digest: manifestDigest });
        if (existing) {
            logger.info({ run: options.run, image: derived(existing).image, ...agentRuntimePackagesLogFields(options.packages) }, 'Using the derived Fly Machine image for agent runtime packages');
            return derived(existing);
        }
        // Only a build installs anything: an existing image built with this list has the packages,
        // even if the archive no longer lists a pinned version.
        await options.checkAvailability?.(options.packages);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-fly-image-'));
        try {
            const started = Date.now();
            const { layer, install, machine, verified, rawBytes } = await buildLayer(options, this.timings, `${FLY_REGISTRY}/${repository}@${digest}`, path.join(directory, 'layer.tar.gz'));
            const pushed = derived(await pushDerived(registry, { repository, tag, manifest, layer, file: path.join(directory, 'layer.tar.gz'), packages: options.packages }));
            logger.info({ run: options.run, machine, image: pushed.image, ...agentRuntimePackagesLogFields(options.packages), installMs: install.ms,
                layerBytes: layer.size, layerRawBytes: rawBytes, installedBytes: verified.installedBytes, verifiedFiles: verified.files,
                buildMs: Date.now() - started }, 'Installed agent runtime packages in a derived Fly Machine image');
            return pushed;
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
}

function hasUnresolvedBuilders(configured: string | undefined) {
    for (const builder of unresolvedBuilders.values()) if (builder.configured === configured) return true;
    return false;
}


/**
 * Points the launch at the derived image when one is available and returns the packages the Machine must
 * still install at start: none with a derived image, all of them without (no images source, or a fallback).
 */
export async function selectFlyPackageImage(images: FlyPackageImages | undefined,
    prepared: { launch: MachineLaunch; installPackages(packages: readonly string[]): void },
    options: SelectOptions): Promise<FlyPackageSelection> {
    const derived = options.packages.length && images ? await images.select(options) : undefined;
    // The Machine installs the packages itself: check them first, so no Machine is created for a list apt cannot install.
    if (!derived && options.packages.length) await options.checkAvailability?.(options.packages, options.signal);
    // Every selection sets the image: a retry that falls back after a refused derived image launches the base.
    prepared.launch.config.image = derived ?? options.config.image;
    const install = derived ? [] : options.packages;
    prepared.installPackages(install);
    return { install, ...(derived && { derived }) };
}

export interface FlyPackageSelection { install: readonly string[]; derived?: string }

interface AgentMachineCreate {
    api: MachinesApi;
    images: FlyPackageImages | undefined;
    prepared: { launch: MachineLaunch; installPackages(packages: readonly string[]): void };
    options: SelectOptions;
    /** The current selection and the time spent waiting for it; updated when a retry selects again. */
    state: { selection: FlyPackageSelection; imageWaitMs: number };
    /**
     * The run's capacity slot. A refused create (no Machine exists) gives it up before preparing the
     * replacement image, whose build Machine may need that slot, and takes it again before the next create.
     */
    slot: { release(): void; reacquire(): Promise<void> };
    /** False once the run is stopping: no second create. */
    mayRetry(): boolean;
    /** Called immediately before each create request: the boot window of that attempt starts here. */
    onAttempt(): void;
    onBootStart(timestamp: number): void;
}

/**
 * Creates the agent Machine. A cached derived image may have lost its tag (deleted, or collected by the
 * registry): any create failure forgets it, and when Fly refused the create (no Machine exists) the
 * registry is checked once more and the create retried with what that selects, a rebuilt image or the
 * start-time install. The same image selected again fails the run with Fly's error.
 */
export async function createAgentMachine({ api, images, prepared, options, state, slot, mayRetry, onAttempt, onBootStart }: AgentMachineCreate) {
    try {
        onAttempt();
        return await api.create(prepared.launch, onBootStart);
    }
    catch (error) {
        const derived = state.selection.derived;
        if (!derived || !images) throw error;
        images.invalidate(derived);
        if (!createRejected(error) || !mayRetry()) throw error;
        logger.warn({ run: options.run, image: derived, err: error }, 'Fly refused the Machine for the derived image; checking the registry again');
        // Fly refused the create, so this run has no Machine: its slot is free for the rebuild's build Machine.
        // Holding it here would deadlock a rebuild under PROPR_FLY_MACHINES_MAX.
        slot.release();
        const waiting = Date.now();
        state.selection = await selectFlyPackageImage(images, prepared, options);
        state.imageWaitMs += Date.now() - waiting;
        if (state.selection.derived === derived || !mayRetry()) throw error;
        await slot.reacquire();
        if (!mayRetry()) throw error;
        // The image preparation above may outlast the boot timeout: the replacement Machine gets its own window.
        onAttempt();
        return api.create(prepared.launch, onBootStart);
    }
}

/** Test seam: forget cached images and failures. */
export function resetFlyPackageImages() {
    images.clear();
    failures.clear();
    installFailures.clear();
    for (const builder of unresolvedBuilders.values()) clearTimeout(builder.timer);
    unresolvedBuilders.clear();
    leftoverSearches.clear();
    activeBuilders.clear();
}
