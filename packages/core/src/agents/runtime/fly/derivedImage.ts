import crypto, { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import logger from '../../../utils/logger.js';
import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS, agentRuntimePackagesLogFields } from '../agentRuntimePackageProfile.js';
import { startupStep } from '../startupStep.js';
import { createRejected, type MachineLaunch, type MachinesApi } from './api.js';
import type { FlyConfig } from './config.js';
import { scanFile } from './files.js';
import { helper } from './launch.js';
import { flyPackageInstallError, flyPackageInstallSpec, type FlyPackageInstall } from './packages.js';
import { FLY_REGISTRY, FlyRegistry, MEDIA, parseFlyImage, sha256, type ImageManifest, type RegistryApi } from './registry.js';
import { RUN, WRAPPER, wrapper } from './wrapper.js';

/** Part of every derived tag: bump it when the layer recipe changes so older images are not reused. */
// 2: recipe 1 left every regular file out on an overlay root (layers of a few hundred bytes); never reuse those.
export const FLY_PACKAGE_IMAGE_RECIPE = 2;
const LAYER_LIMIT = 4 * 1024 ** 3;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The build could not produce an image in a way that a start-time install would not avoid (apt failed), or its Machine may still exist. */
export class FlyPackageImageError extends Error {}

/** apt failed on the build Machine. Remembered per base manifest and package list, so queued runs do not each rebuild. */
export class FlyPackageInstallFailure extends FlyPackageImageError {}

/** Timings; tests shorten them. */
export interface FlyPackageImageTimings {
    /** Registry or build failures fall back to the start-time install for this long; apt failures are replayed as long. */
    failureBackoffMs: number;
    /** How long to keep looking up a build Machine whose create response was lost. */
    lostCreateWindowMs: number;
    /** How long deleting a build Machine may take, independent of the build deadline. */
    removalWindowMs: number;
    /** A cached derived image older than this is checked in the registry before it is reused. */
    recheckAfterMs: number;
    /** Build status, lost-create lookup and delete retry interval. */
    pollMs: number;
}

const DEFAULT_TIMINGS: FlyPackageImageTimings = {
    failureBackoffMs: 10 * 60_000, lostCreateWindowMs: 60_000, removalWindowMs: 60_000, recheckAfterMs: 5 * 60_000, pollMs: 2000,
};

interface BuildResult extends FlyPackageInstall {
    layer?: { digest: string; size: number; diffId: string; changed: number; removed: number };
    /** The build Machine read the layer back: every package installed, each file dpkg lists for it in the layer or the base. */
    verified?: { packages: number; files: number; installedBytes: number };
    error?: string;
}

export interface SelectOptions {
    api: MachinesApi;
    config: FlyConfig;
    packages: readonly string[];
    signal: AbortSignal;
    run: string;
}

interface Derived { image: string; repository: string; tag: string; digest: string }
interface CachedImage { pending: Promise<Derived>; checkedAt: number; registry: RegistryApi; derived?: Derived }

// Shared by every runtime instance in the worker process: one build per base image and package list.
const images = new Map<string, CachedImage>();
const failures = new Map<string, number>();
const installFailures = new Map<string, { message: string; at: number }>();

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
        this.timings = { ...DEFAULT_TIMINGS, ...timings };
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
        if (Date.now() - (failures.get(configured) ?? -Infinity) < failureBackoffMs) return;
        try {
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
            let cached = images.get(key);
            if (cached?.derived && Date.now() - cached.checkedAt >= this.timings.recheckAfterMs && !await this.stillPublished(cached, cached.derived, signal)) {
                images.delete(key);
                cached = undefined;
            }
            if (!cached) {
                signal.throwIfAborted();
                // Shared, and outlives this run's cancellation: it deletes its own build Machine.
                const entry: CachedImage = { pending: this.prepare(options, registry, base.repository, resolved ?? base.reference), checkedAt: Date.now(), registry };
                cached = entry;
                images.set(key, entry);
                entry.pending.then(derived => { entry.derived = derived; }, error => {
                    if (images.get(key) === entry) images.delete(key);
                    if (error instanceof FlyPackageInstallFailure) installFailures.set(key, { message: error.message, at: Date.now() });
                });
            }
            const pending = cached.pending;
            return (await startupStep(signal, () => pending)).image;
        } catch (error) {
            if (signal.aborted || error instanceof FlyPackageImageError) throw error;
            failures.set(configured, Date.now());
            logger.warn({ ...fields, err: error }, 'Could not prepare the derived Fly Machine image; installing agent runtime packages at Fly Machine start');
            return;
        }
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

async function buildLayer(options: SelectOptions, timings: FlyPackageImageTimings, baseImage: string, target: string) {
    const { api, config, packages } = options;
    const name = 'propr-build-' + randomUUID();
    const file = (guest_path: string, content: string, mode = 0o600) => ({ guest_path, mode, raw_value: Buffer.from(content).toString('base64') });
    const launch: MachineLaunch = { name, skip_service_registration: true, skip_secrets: true, region: config.region, config: {
        image: baseImage, guest: config.guest, metadata: { propr_run_id: name }, auto_destroy: true, restart: { policy: 'no' },
        processes: [{ user: 'root', ignore_app_secrets: true, entrypoint: ['/usr/bin/setpriv', '--no-new-privs', ...helper], cmd: ['build'] }],
        files: [file(WRAPPER, wrapper, 0o644), file(RUN + '/build.json', JSON.stringify({ ...flyPackageInstallSpec(packages), verify: packageNames(packages) }))],
    } };
    // Boot, install, snapshot and transfer; the build is shared, so no single run's cancellation stops it.
    const deadline = Date.now() + config.bootTimeout + AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS + 30 * 60_000;
    const id = await api.create(launch).catch(error => settleLostBuilder(api, name, error, timings));
    try {
        const state = await waitForBuild(api, id, { bootDeadline: Date.now() + config.bootTimeout, deadline, pollMs: timings.pollMs });
        const read = await api.exec(id, ['/bin/cat', RUN + '/build-result']).catch(() => undefined);
        let result: BuildResult | undefined;
        try { result = read?.exit_code === 0 ? JSON.parse(read.stdout) as BuildResult : undefined; } catch { result = undefined; }
        if (state === 'build-failed') throw new FlyPackageInstallFailure(flyPackageInstallError(packages, result).message);
        const layer = result?.layer;
        if (state !== 'built' || !layer || !DIGEST.test(layer.digest) || !DIGEST.test(layer.diffId)
            || !Number.isSafeInteger(layer.size) || layer.size <= 0 || layer.size > LAYER_LIMIT)
            throw new Error(`Fly image build Machine ${id} produced no layer (${state ?? 'no status'}${result?.error ? ': ' + result.error : ''})`);
        const verified = verifiedLayer(id, result!, packages);
        const rawBytes = await download(api, id, layer, target);
        // Installed-Size rounds each file up to 1 KiB; a tar entry is a 512-byte header plus the data padded to 512 bytes, never less.
        if (rawBytes < verified.installedBytes)
            throw new Error(`Fly image build layer holds ${rawBytes} bytes, less than the ${verified.installedBytes} bytes apt reports installed`);
        return { layer, install: result!, machine: id, verified, rawBytes };
    } finally {
        void api.exec(id, ['/usr/bin/touch', RUN + '/packages-read']).catch(() => {});
        await removeBuilder(api, id, timings);
    }
}

/**
 * After a build Machine create without a confirmed outcome. Fly may still be creating it, so the run
 * neither falls back nor creates its agent Machine yet: it keeps looking the Machine up by its unique
 * name for `lostCreateWindowMs`, and deletes it if it appears. It falls back (a plain error) only once
 * the Machine is confirmed gone or absent, and fails the run when that cannot be confirmed.
 */
async function settleLostBuilder(api: MachinesApi, name: string, error: unknown, timings: FlyPackageImageTimings): Promise<never> {
    if (createRejected(error)) throw error; // Fly refused the request: nothing of this name exists.
    const unconfirmed = (cause: unknown) => new FlyPackageImageError('Fly image build Machine creation could not be confirmed', { cause });
    if (!api.find) throw unconfirmed(error);
    const deadline = Date.now() + timings.lostCreateWindowMs;
    let lookupError: unknown;
    for (;;) {
        let found: string | undefined;
        try {
            found = await api.find(name);
            lookupError = undefined;
        } catch (lookup) { lookupError = lookup; }
        if (found) {
            logger.warn({ machine: found, name }, 'A Fly image build Machine appeared after its create response was lost; deleting it');
            await removeBuilder(api, found, timings);
            throw new Error(`Fly image build Machine ${found} appeared after its create response was lost and was deleted`, { cause: error });
        }
        if (Date.now() >= deadline) break;
        await delay(timings.pollMs);
    }
    if (lookupError) throw unconfirmed(lookupError);
    throw new Error(`Fly image build Machine creation failed, and no Machine named ${name} appeared within ${Math.round(timings.lostCreateWindowMs / 1000)}s`, { cause: error });
}

async function waitForBuild(api: MachinesApi, id: string, { bootDeadline, deadline, pollMs }: { bootDeadline: number; deadline: number; pollMs: number }) {
    let booted = false;
    while (Date.now() < (booted ? deadline : bootDeadline)) {
        const res = await api.exec(id, [...helper, 'probe']).catch(() => undefined);
        const state = res?.exit_code === 0 ? res.stdout.trim().split('\n')[0] : undefined;
        if (state === 'built' || state === 'build-failed' || state === 'build-error') return state;
        if (state === 'building') booted = true;
        await delay(pollMs);
    }
}

/**
 * The build Machine's read-back of its layer: every package `install ok installed`, and each file
 * `dpkg -L` lists for it in the layer (or unchanged in the base). Without it the digest is not used.
 */
function verifiedLayer(id: string, result: BuildResult, packages: readonly string[]) {
    const verified = result.verified;
    if (!verified || verified.packages !== packages.length || !Number.isSafeInteger(verified.files) || verified.files < 0
        || !Number.isSafeInteger(verified.installedBytes) || verified.installedBytes < 0)
        throw new Error(`Fly image build Machine ${id} did not verify the layer against dpkg`);
    return verified;
}

/** The names dpkg knows the specs by: no version pin, no architecture qualifier. */
function packageNames(packages: readonly string[]) {
    return packages.map(spec => spec.split('=', 1)[0].split(':', 1)[0]);
}

/**
 * Reads the layer into `target`; its compressed digest, size and uncompressed diff ID are checked on the
 * worker. Returns the uncompressed size.
 */
async function download(api: MachinesApi, id: string, layer: NonNullable<BuildResult['layer']>, target: string) {
    const handle = await fs.open(target, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size: number | null;
    try {
        size = await scanFile(api, id, RUN + '/layer.tar.gz', { limit: LAYER_LIMIT, consume: async chunk => { hash.update(chunk); await handle.write(chunk); } });
    } finally { await handle.close(); }
    if (size !== layer.size || 'sha256:' + hash.digest('hex') !== layer.digest) throw new Error('Fly image build layer does not match its recorded digest');
    const raw = crypto.createHash('sha256');
    let rawBytes = 0;
    await pipeline(createReadStream(target), createGunzip(), async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) { raw.update(chunk); rawBytes += chunk.length; }
    });
    if ('sha256:' + raw.digest('hex') !== layer.diffId) throw new Error('Fly image build layer does not match its recorded diff ID');
    return rawBytes;
}

/**
 * Returns once Fly confirms the build Machine gone; the run must not create its agent Machine before then.
 * The delete has its own window, so a transient failure near the end of a long build is still retried.
 */
async function removeBuilder(api: MachinesApi, id: string, { removalWindowMs, pollMs }: FlyPackageImageTimings) {
    const deadline = Date.now() + removalWindowMs;
    for (;;) {
        try { await api.destroy(id); return; } catch (error) {
            if (await api.gone(id).catch(() => false)) return;
            if (Date.now() >= deadline)
                throw new FlyPackageImageError(`Could not confirm deletion of Fly image build Machine ${id}`, { cause: error });
        }
        await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
}

interface DerivedPush { repository: string; tag: string; manifest: ImageManifest; layer: NonNullable<BuildResult['layer']>; file: string; packages: readonly string[] }

async function pushDerived(registry: RegistryApi, { repository, tag, manifest, layer, file, packages }: DerivedPush) {
    await registry.upload(repository, layer.digest, layer.size, file);
    const config = JSON.parse((await registry.blob(repository, manifest.config.digest)).toString()) as {
        created?: string; rootfs?: { diff_ids?: string[] }; history?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(config.rootfs?.diff_ids) || config.rootfs.diff_ids.length !== manifest.layers.length) throw new Error('Unsupported Fly base image configuration');
    const created = new Date().toISOString();
    config.created = created;
    config.rootfs.diff_ids.push(layer.diffId);
    const { packagesDigest } = agentRuntimePackagesLogFields(packages);
    if (Array.isArray(config.history)) config.history.push({ created, created_by: `propr: apt-get install ${packages.length} agent runtime package(s), digest ${packagesDigest}` });
    const configBytes = Buffer.from(JSON.stringify(config));
    const configDigest = sha256(configBytes);
    await registry.upload(repository, configDigest, configBytes.length, configBytes);
    const oci = manifest.mediaType === MEDIA.ociManifest || manifest.config.mediaType.startsWith('application/vnd.oci.');
    const derived: ImageManifest = { ...manifest, config: { ...manifest.config, digest: configDigest, size: configBytes.length },
        layers: [...manifest.layers, { mediaType: oci ? MEDIA.ociLayer : MEDIA.dockerLayer, digest: layer.digest, size: layer.size }] };
    return registry.push(repository, tag, manifest.mediaType ?? (oci ? MEDIA.ociManifest : MEDIA.dockerManifest), Buffer.from(JSON.stringify(derived)));
}

/**
 * Points the launch at the derived image when one is available and returns the packages the Machine must
 * still install at start: none with a derived image, all of them without (no images source, or a fallback).
 */
export async function selectFlyPackageImage(images: FlyPackageImages | undefined,
    prepared: { launch: MachineLaunch; installPackages(packages: readonly string[]): void },
    options: SelectOptions): Promise<FlyPackageSelection> {
    const derived = options.packages.length && images ? await images.select(options) : undefined;
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
export async function createAgentMachine({ api, images, prepared, options, state, mayRetry, onAttempt, onBootStart }: AgentMachineCreate) {
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
        const waiting = Date.now();
        state.selection = await selectFlyPackageImage(images, prepared, options);
        state.imageWaitMs += Date.now() - waiting;
        if (state.selection.derived === derived || !mayRetry()) throw error;
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
}
