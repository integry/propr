import crypto, { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import logger from '../../../utils/logger.js';
import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS, agentRuntimePackageInstallCommand, agentRuntimePackagesLogFields } from '../agentRuntimePackageProfile.js';
import { createRejected, type MachineLaunch, type MachinesApi } from './api.js';
import type { FlyConfig } from './config.js';
import { scanFile } from './files.js';
import { helper } from './launch.js';
import { flyPackageInstallError, type FlyPackageInstall } from './packages.js';
import { FLY_REGISTRY, FlyRegistry, MEDIA, parseFlyImage, sha256, type ImageManifest, type RegistryApi } from './registry.js';
import { RUN, WRAPPER, wrapper } from './wrapper.js';

/** Part of every derived tag: bump it when the layer recipe changes so older images are not reused. */
export const FLY_PACKAGE_IMAGE_RECIPE = 1;
const LAYER_LIMIT = 4 * 1024 ** 3;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const POLL_MS = 2000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The build could not produce an image in a way that a start-time install would not avoid (apt failed), or its Machine may still exist. */
export class FlyPackageImageError extends Error {}

interface BuildResult extends FlyPackageInstall {
    layer?: { digest: string; size: number; diffId: string; changed: number; removed: number };
    error?: string;
}

export interface SelectOptions {
    api: MachinesApi;
    config: FlyConfig;
    packages: readonly string[];
    signal: AbortSignal;
    run: string;
}

// Shared by every runtime instance in the worker process: one build per base image and package list.
const images = new Map<string, Promise<string>>();
const failures = new Map<string, number>();

/** The derived tag for a base manifest and package list; the same inputs on any worker give the same tag. */
export function flyPackageImageTag(baseDigest: string, packages: readonly string[]) {
    const hash = crypto.createHash('sha256').update(JSON.stringify({ recipe: FLY_PACKAGE_IMAGE_RECIPE, base: baseDigest, packages })).digest('hex');
    return 'propr-packages-' + hash.slice(0, 24);
}

function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
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
    constructor(private readonly registryFor: (config: FlyConfig) => RegistryApi = config => new FlyRegistry(config.token)) {}

    /**
     * The image to run with `packages` preinstalled, or undefined to install them at Machine start
     * (an image outside registry.fly.io, or a registry or build failure, retried after ten minutes).
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
        if (Date.now() - (failures.get(configured) ?? -Infinity) < FAILURE_BACKOFF_MS) return;
        try {
            const registry = this.registryFor(config);
            // A tag can be pushed to while the worker runs: resolve it for every run, so the cached
            // image follows the base manifest it names now. A digest names one manifest for good.
            const resolved = DIGEST.test(base.reference) ? undefined : await until(registry.manifest(base.repository, base.reference), signal);
            const key = JSON.stringify([config.app, base.repository, resolved?.digest ?? base.reference, packages]);
            let pending = images.get(key);
            if (!pending) {
                signal.throwIfAborted();
                // Shared, and outlives this run's cancellation: it deletes its own build Machine.
                pending = this.prepare(options, registry, base.repository, resolved ?? base.reference);
                images.set(key, pending);
                pending.catch(() => { images.delete(key); });
            }
            return await until(pending, signal);
        } catch (error) {
            if (signal.aborted || error instanceof FlyPackageImageError) throw error;
            failures.set(configured, Date.now());
            logger.warn({ ...fields, err: error }, 'Could not prepare the derived Fly Machine image; installing agent runtime packages at Fly Machine start');
            return;
        }
    }

    private async prepare(options: SelectOptions, registry: RegistryApi, repository: string,
        base: string | { digest: string; manifest: ImageManifest }) {
        const { digest, manifest } = typeof base === 'string' ? await registry.manifest(repository, base) : base;
        const tag = flyPackageImageTag(digest, options.packages);
        const existing = await registry.resolve(repository, tag);
        const image = (manifestDigest: string) => `${FLY_REGISTRY}/${repository}@${manifestDigest}`;
        if (existing) {
            logger.info({ run: options.run, image: image(existing), ...agentRuntimePackagesLogFields(options.packages) }, 'Using the derived Fly Machine image for agent runtime packages');
            return image(existing);
        }
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-fly-image-'));
        try {
            const started = Date.now();
            const { layer, install, machine } = await buildLayer(options, `${FLY_REGISTRY}/${repository}@${digest}`, path.join(directory, 'layer.tar.gz'));
            const pushed = image(await pushDerived(registry, { repository, tag, manifest, layer, file: path.join(directory, 'layer.tar.gz'), packages: options.packages }));
            logger.info({ run: options.run, machine, image: pushed, ...agentRuntimePackagesLogFields(options.packages), installMs: install.ms,
                layerBytes: layer.size, buildMs: Date.now() - started }, 'Installed agent runtime packages in a derived Fly Machine image');
            return pushed;
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
}

async function buildLayer(options: SelectOptions, baseImage: string, target: string) {
    const { api, config, packages } = options;
    const name = 'propr-build-' + randomUUID();
    const file = (guest_path: string, content: string, mode = 0o600) => ({ guest_path, mode, raw_value: Buffer.from(content).toString('base64') });
    const launch: MachineLaunch = { name, skip_service_registration: true, skip_secrets: true, region: config.region, config: {
        image: baseImage, guest: config.guest, metadata: { propr_run_id: name }, auto_destroy: true, restart: { policy: 'no' },
        processes: [{ user: 'root', ignore_app_secrets: true, entrypoint: ['/usr/bin/setpriv', '--no-new-privs', ...helper], cmd: ['build'] }],
        files: [file(WRAPPER, wrapper, 0o644), file(RUN + '/build.json', JSON.stringify({ argv: agentRuntimePackageInstallCommand(packages), path: PATH,
            timeout: AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS }))],
    } };
    // Boot, install, snapshot and transfer; the build is shared, so no single run's cancellation stops it.
    const deadline = Date.now() + config.bootTimeout + AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS + 30 * 60_000;
    const id = await api.create(launch).catch(error => {
        // A build Machine that may exist is not confirmed gone: do not go on to create the agent Machine beside it.
        if (createRejected(error)) throw error;
        throw new FlyPackageImageError('Fly image build Machine creation could not be confirmed', { cause: error });
    });
    try {
        const state = await waitForBuild(api, id, Date.now() + config.bootTimeout, deadline);
        const read = await api.exec(id, ['/bin/cat', RUN + '/build-result']).catch(() => undefined);
        let result: BuildResult | undefined;
        try { result = read?.exit_code === 0 ? JSON.parse(read.stdout) as BuildResult : undefined; } catch { result = undefined; }
        if (state === 'build-failed') throw new FlyPackageImageError(flyPackageInstallError(packages, result).message);
        const layer = result?.layer;
        if (state !== 'built' || !layer || !DIGEST.test(layer.digest) || !DIGEST.test(layer.diffId)
            || !Number.isSafeInteger(layer.size) || layer.size <= 0 || layer.size > LAYER_LIMIT)
            throw new Error(`Fly image build Machine ${id} produced no layer (${state ?? 'no status'}${result?.error ? ': ' + result.error : ''})`);
        await download(api, id, layer, target);
        return { layer, install: result!, machine: id };
    } finally {
        void api.exec(id, ['/usr/bin/touch', RUN + '/packages-read']).catch(() => {});
        await removeBuilder(api, id, deadline);
    }
}

async function waitForBuild(api: MachinesApi, id: string, bootDeadline: number, deadline: number) {
    let booted = false;
    while (Date.now() < (booted ? deadline : bootDeadline)) {
        const res = await api.exec(id, [...helper, 'probe']).catch(() => undefined);
        const state = res?.exit_code === 0 ? res.stdout.trim().split('\n')[0] : undefined;
        if (state === 'built' || state === 'build-failed' || state === 'build-error') return state;
        if (state === 'building') booted = true;
        await delay(POLL_MS);
    }
}

/** Reads the layer into `target`; its compressed digest, size and uncompressed diff ID are checked on the worker. */
async function download(api: MachinesApi, id: string, layer: NonNullable<BuildResult['layer']>, target: string) {
    const handle = await fs.open(target, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size: number | null;
    try {
        size = await scanFile(api, id, RUN + '/layer.tar.gz', { limit: LAYER_LIMIT, consume: async chunk => { hash.update(chunk); await handle.write(chunk); } });
    } finally { await handle.close(); }
    if (size !== layer.size || 'sha256:' + hash.digest('hex') !== layer.digest) throw new Error('Fly image build layer does not match its recorded digest');
    const raw = crypto.createHash('sha256');
    await pipeline(createReadStream(target), createGunzip(), async (source: AsyncIterable<Buffer>) => { for await (const chunk of source) raw.update(chunk); });
    if ('sha256:' + raw.digest('hex') !== layer.diffId) throw new Error('Fly image build layer does not match its recorded diff ID');
}

/** Returns once Fly confirms the build Machine gone; the run must not create its agent Machine before then. */
async function removeBuilder(api: MachinesApi, id: string, deadline: number) {
    for (;;) {
        try { await api.destroy(id); return; } catch (error) {
            if (await api.gone(id).catch(() => false)) return;
            if (Date.now() >= deadline)
                throw new FlyPackageImageError(`Could not confirm deletion of Fly image build Machine ${id}`, { cause: error });
        }
        await delay(5000);
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
    prepared: { launch: MachineLaunch; installPackages(packages: readonly string[]): void }, options: SelectOptions): Promise<readonly string[]> {
    const derived = options.packages.length && images ? await images.select(options) : undefined;
    if (derived) prepared.launch.config.image = derived;
    const packages = derived ? [] : options.packages;
    prepared.installPackages(packages);
    return packages;
}

/** Test seam: forget cached images and failures. */
export function resetFlyPackageImages() {
    images.clear();
    failures.clear();
}
