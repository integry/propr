import crypto, { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import logger from '../../../utils/logger.js';
import type { AgentRuntimePackageAvailabilityCheck } from '../agentRuntimePackageIndex.js';
import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS, agentRuntimePackagesLogFields } from '../agentRuntimePackageProfile.js';
import { createRejected, type MachineLaunch, type MachinesApi } from './api.js';
import { deleteFlyMachine, FlyMachineSlot } from './capacity.js';
import type { FlyConfig } from './config.js';
import { scanFile } from './files.js';
import { helper } from './launch.js';
import { flyPackageInstallError, flyPackageInstallSpec, type FlyPackageInstall } from './packages.js';
import { MEDIA, sha256, type ImageManifest, type RegistryApi } from './registry.js';
import { RUN, WRAPPER, wrapper } from './wrapper.js';

/**
 * The derived-image build Machine: created from the base image in the agent app, it runs the apt install,
 * captures the change as a layer and verifies it against dpkg; the worker downloads and checks the layer,
 * and pushes it with the base layers. The Machine counts against `PROPR_FLY_MACHINES_MAX` while it may exist.
 */

const LAYER_LIMIT = 4 * 1024 ** 3;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The build could not produce an image in a way that a start-time install would not avoid (apt failed), or its Machine may still exist. */
export class FlyPackageImageError extends Error {}

/** apt failed on the build Machine. Remembered per base manifest and package list, so queued runs do not each rebuild. */
export class FlyPackageInstallFailure extends FlyPackageImageError {}

/** Prefix of every build Machine name; an earlier worker process's leftovers are found by it. */
export const FLY_BUILDER_PREFIX = 'propr-build-';

/** A build Machine whose deletion could not be confirmed: its ID, or only its unique name when the create response was lost. */
export interface FlyBuilderMachine { name: string; id?: string }

/**
 * A build Machine may still exist. The worker keeps the obligation to delete it, and no later run
 * for the same configured image and package list builds again or creates its agent Machine until
 * Fly confirms it gone.
 */
export class FlyBuilderCleanupError extends FlyPackageImageError {
    /** Frees the build Machine's capacity slot; called only once Fly confirms the Machine gone. */
    release: () => void = () => {};
    constructor(message: string, readonly builder: FlyBuilderMachine, options?: ErrorOptions) { super(message, options); }
}

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
    /** Background retry interval for a build Machine whose deletion is unconfirmed, while it holds its capacity slot. */
    reconcileMs: number;
    /** The backoff doubles after each failed build for the same base manifest and package list, up to this. */
    failureBackoffMaxMs: number;
    /** Failed build status probes in a row after which the worker asks Fly whether the build Machine still exists. */
    probeFailuresBeforeGoneCheck: number;
    /** How long pushing the derived image (layer upload, config and manifest) may take. */
    pushTimeoutMs: number;
}

export const DEFAULT_FLY_PACKAGE_IMAGE_TIMINGS: FlyPackageImageTimings = {
    failureBackoffMs: 10 * 60_000, lostCreateWindowMs: 60_000, removalWindowMs: 60_000, recheckAfterMs: 5 * 60_000, pollMs: 2000, reconcileMs: 60_000,
    failureBackoffMaxMs: 24 * 60 * 60_000, probeFailuresBeforeGoneCheck: 3, pushTimeoutMs: 30 * 60_000,
};

export interface BuildResult extends FlyPackageInstall {
    layer?: { digest: string; size: number; diffId: string; changed: number; removed: number };
    /** The build Machine read the layer back: every package installed, each file dpkg lists for it in the layer or the base. */
    verified?: { packages: number; files: number; installedBytes: number; layerBytes: number };
    error?: string;
}

export interface SelectOptions {
    api: MachinesApi;
    config: FlyConfig;
    packages: readonly string[];
    signal: AbortSignal;
    run: string;
    /** The package source's archive check, run only before a new installation (a build or a start-time install). */
    checkAvailability?: AgentRuntimePackageAvailabilityCheck;
}

/** How long a build may take from create: boot, install, snapshot and the layer download, which the deadline bounds as well. */
export const buildDeadlineMs = (config: FlyConfig) => config.bootTimeout + AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS + 30 * 60_000;

/**
 * The longest a build Machine of a live worker may exist: the build deadline (which ends the download too),
 * then its deletion window, with a margin for the create request and clock skew between Fly and the worker.
 * The startup search deletes only build Machines older than this.
 */
export const builderLifetimeMs = (config: FlyConfig, timings: FlyPackageImageTimings) =>
    buildDeadlineMs(config) + timings.removalWindowMs + timings.lostCreateWindowMs + 10 * 60_000;

/** Build Machines this worker process is running now, by name, so the startup search never counts them twice. */
export const activeBuilders = new Set<string>();

/**
 * Builds the layer on a build Machine. `published` looks the derived tag up again once the slot is held, just
 * before the create: another worker may have pushed it meanwhile, and then no build Machine is created.
 */
export async function buildLayer({ options, timings, baseImage, target, published }: LayerBuild) {
    const { config } = options;
    const name = FLY_BUILDER_PREFIX + randomUUID();
    // The build Machine counts against PROPR_FLY_MACHINES_MAX for as long as it may exist. The build is
    // shared, so no single run's cancellation ends the wait; the slot is freed once Fly confirms it gone.
    const slot = new FlyMachineSlot(options.api, config, name, name);
    await slot.acquire(AbortSignal.any([]));
    activeBuilders.add(name);
    let held = true;
    try {
        const existing = await published?.().catch(() => undefined);
        if (existing) return { existing };
        return await runBuilder({ options, timings, baseImage, target, name });
    } catch (error) {
        // A build Machine that may still exist keeps the slot; the unresolved record frees it once it is gone.
        if (error instanceof FlyBuilderCleanupError) { error.release = () => slot.releaseUnused(); held = false; }
        throw error;
    } finally {
        activeBuilders.delete(name);
        // Refused, or confirmed deleted (`removeBuilder`): no build Machine of this name exists.
        if (held) slot.releaseUnused();
    }
}

interface LayerBuild { options: SelectOptions; timings: FlyPackageImageTimings; baseImage: string; target: string; published?: () => Promise<string | undefined> }

interface BuilderRun { options: SelectOptions; timings: FlyPackageImageTimings; baseImage: string; target: string; name: string }

async function runBuilder({ options, timings, baseImage, target, name }: BuilderRun) {
    const { api, config, packages } = options;
    const file = (guest_path: string, content: string, mode = 0o600) => ({ guest_path, mode, raw_value: Buffer.from(content).toString('base64') });
    const launch: MachineLaunch = { name, skip_service_registration: true, skip_secrets: true, region: config.region, config: {
        image: baseImage, guest: config.guest, metadata: { propr_run_id: name }, auto_destroy: true, restart: { policy: 'no' },
        processes: [{ user: 'root', ignore_app_secrets: true, entrypoint: ['/usr/bin/setpriv', '--no-new-privs', ...helper], cmd: ['build'] }],
        files: [file(WRAPPER, wrapper, 0o644), file(RUN + '/build.json', JSON.stringify({ ...flyPackageInstallSpec(packages), verify: packageNames(packages) }))],
    } };
    // Boot, install, snapshot and transfer; the build is shared, so no single run's cancellation stops it.
    const deadline = Date.now() + buildDeadlineMs(config);
    const id = await api.create(launch).catch(error => settleLostBuilder(api, name, error, timings));
    try {
        const state = await waitForBuild(api, id, { bootDeadline: Date.now() + config.bootTimeout, deadline, timings });
        // The rest of the build deadline bounds the result read and the layer download: the build Machine and its slot are held meanwhile.
        const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
        const read = await api.exec(id, ['/bin/cat', RUN + '/build-result'], signal).catch(() => undefined);
        let result: BuildResult | undefined;
        try { result = read?.exit_code === 0 ? JSON.parse(read.stdout) as BuildResult : undefined; } catch { result = undefined; }
        if (state === 'build-failed') throw new FlyPackageInstallFailure(flyPackageInstallError(packages, result).message);
        const layer = result?.layer;
        if (state !== 'built' || !layer || !DIGEST.test(layer.digest) || !DIGEST.test(layer.diffId)
            || !Number.isSafeInteger(layer.size) || layer.size <= 0 || layer.size > LAYER_LIMIT)
            throw new Error(`Fly image build Machine ${id} produced no layer (${state ?? 'no status'}${result?.error ? ': ' + result.error : ''})`);
        const verified = verifiedLayer(id, result!, packages);
        const rawBytes = await download(api, id, { layer, target, signal });
        // The bytes of the packages' regular files in the layer (each inode once, nothing dpkg path-exclude
        // kept out, unlike apt's Installed-Size); a tar entry holds the data plus a header, never less.
        if (rawBytes < verified.layerBytes)
            throw new Error(`Fly image build layer holds ${rawBytes} bytes, less than the ${verified.layerBytes} bytes of package files the build Machine read back`);
        return { layer, install: result!, machine: id, verified, rawBytes };
    } finally {
        void api.exec(id, ['/usr/bin/touch', RUN + '/packages-read']).catch(() => {});
        await removeBuilder(api, { name, id }, timings);
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
    const unconfirmed = (cause: unknown) => new FlyBuilderCleanupError('Fly image build Machine creation could not be confirmed', { name }, { cause });
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
            await removeBuilder(api, { name, id: found }, timings);
            throw new Error(`Fly image build Machine ${found} appeared after its create response was lost and was deleted`, { cause: error });
        }
        if (Date.now() >= deadline) break;
        await delay(timings.pollMs);
    }
    if (lookupError) throw unconfirmed(lookupError);
    throw new Error(`Fly image build Machine creation failed, and no Machine named ${name} appeared within ${Math.round(timings.lostCreateWindowMs / 1000)}s`, { cause: error });
}

/**
 * Polls the build status until the build ends or its deadline passes. After a few failed probes in a row
 * it asks Fly whether the Machine still exists: a wrapper that died mid-build (an OOM kill, a host failure)
 * leaves no status, and auto_destroy removes its Machine, so the build fails at once instead of at the deadline.
 */
async function waitForBuild(api: MachinesApi, id: string, { bootDeadline, deadline, timings }: { bootDeadline: number; deadline: number; timings: FlyPackageImageTimings }) {
    let booted = false;
    let failed = 0;
    while (Date.now() < (booted ? deadline : bootDeadline)) {
        const res = await api.exec(id, [...helper, 'probe']).catch(() => undefined);
        const state = res?.exit_code === 0 ? res.stdout.trim().split('\n')[0] : undefined;
        if (state === 'built' || state === 'build-failed' || state === 'build-error') return state;
        if (state === 'building') booted = true;
        failed = state ? 0 : failed + 1;
        if (failed >= timings.probeFailuresBeforeGoneCheck) {
            failed = 0;
            if (await api.gone(id).catch(() => false))
                throw new Error(`Fly image build Machine ${id} is gone before its build finished (${booted ? 'after it started building' : 'while booting'})`);
        }
        await delay(timings.pollMs);
    }
}

/**
 * The build Machine's read-back of its layer: every package `install ok installed`, and each file
 * `dpkg -L` lists for it in the layer (or unchanged in the base). Without it the digest is not used.
 */
function verifiedLayer(id: string, result: BuildResult, packages: readonly string[]) {
    const verified = result.verified;
    if (!verified || verified.packages !== packages.length || !Number.isSafeInteger(verified.files) || verified.files < 0
        || !Number.isSafeInteger(verified.installedBytes) || verified.installedBytes < 0 || !Number.isSafeInteger(verified.layerBytes) || verified.layerBytes < 0)
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
async function download(api: MachinesApi, id: string, { layer, target, signal }: { layer: NonNullable<BuildResult['layer']>; target: string; signal: AbortSignal }) {
    const handle = await fs.open(target, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size: number | null;
    try {
        size = await scanFile(api, id, RUN + '/layer.tar.gz', { limit: LAYER_LIMIT, signal, consume: async chunk => { hash.update(chunk); await handle.write(chunk); } });
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
 * The same rule as for agent Machines (`deleteFlyMachine`): a 404, or Fly reporting the Machine gone after a
 * failed deletion, counts as deleted, so a build Machine deleted outside ProPR frees its slot. The delete has
 * its own window, so a transient failure near the end of a long build is still retried.
 */
async function removeBuilder(api: MachinesApi, { name, id }: { name: string; id: string }, { removalWindowMs, pollMs }: FlyPackageImageTimings) {
    const deadline = Date.now() + removalWindowMs;
    for (;;) {
        try { await deleteFlyMachine(api, id, { name }); return; } catch (error) {
            if (Date.now() >= deadline)
                throw new FlyBuilderCleanupError(`Could not confirm deletion of Fly image build Machine ${id}`, { name, id }, { cause: error });
        }
        await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
}

/**
 * Confirms an unresolved build Machine gone: deletes it by ID, or first looks it up by its unique name
 * when its create response was lost (an earlier run already watched for it for `lostCreateWindowMs`,
 * so a successful lookup that finds nothing confirms it absent). Throws `FlyBuilderCleanupError` otherwise.
 */
export async function resolveBuilder(api: MachinesApi, builder: FlyBuilderMachine, timings: FlyPackageImageTimings) {
    let id = builder.id;
    if (!id) {
        const { name } = builder;
        try { id = await api.find(name); }
        catch (error) { throw new FlyBuilderCleanupError(`Could not look up Fly image build Machine ${name}`, { name }, { cause: error }); }
        if (!id) return;
        builder.id = id;
    }
    await removeBuilder(api, { name: builder.name, id }, timings);
}

interface DerivedPush { repository: string; tag: string; manifest: ImageManifest; layer: NonNullable<BuildResult['layer']>; file: string; packages: readonly string[]; signal: AbortSignal }

/** Pushes the layer, the derived config and then the tag; `signal` bounds the whole push (`pushTimeoutMs`). */
export async function pushDerived(registry: RegistryApi, { repository, tag, manifest, layer, file, packages, signal }: DerivedPush) {
    await registry.upload(repository, layer, file, signal);
    const config = JSON.parse((await registry.blob(repository, manifest.config.digest, signal)).toString()) as {
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
    await registry.upload(repository, { digest: configDigest, size: configBytes.length }, configBytes, signal);
    const oci = manifest.mediaType === MEDIA.ociManifest || manifest.config.mediaType.startsWith('application/vnd.oci.');
    const derived: ImageManifest = { ...manifest, config: { ...manifest.config, digest: configDigest, size: configBytes.length },
        layers: [...manifest.layers, { mediaType: oci ? MEDIA.ociLayer : MEDIA.dockerLayer, digest: layer.digest, size: layer.size }] };
    signal.throwIfAborted();
    return registry.push(repository, tag, { mediaType: manifest.mediaType ?? (oci ? MEDIA.ociManifest : MEDIA.dockerManifest), body: Buffer.from(JSON.stringify(derived)) }, signal);
}
