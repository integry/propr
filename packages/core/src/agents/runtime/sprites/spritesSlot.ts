import type { NetworkPolicy, Sprite } from '@fly/sprites';
import { packageServersDigest, type RemotePackageInstall } from '../../../extensions/remotePackageServers.js';
import { agentRuntimePackagesDigest } from '../agentRuntimePackageProfile.js';

/** A pooled Sprite: its clean checkpoint, what that checkpoint has installed, and the run-time state of a checkout. */
export type Slot = { sprite: Sprite; lease?: AbortSignal; checkpoint: string; provisioningMs: number; restoreMs: number;
    /** Digest of the runtime packages baked into the checkpoint; a slot whose digest is no longer current is retired. */
    packagesDigest: string;
    /** Time the runtime package install took while provisioning this slot; absent on recycled slots and without packages. */
    packageInstallMs?: number;
    /** Digest of the package MCP servers in the clean checkpoint; only a run needing exactly these servers uses the Sprite. */
    packageServersDigest: string;
    /** Those servers, so a replacement for this Sprite is provisioned with the same set. */
    packages?: RemotePackageInstall;
    /** Time installing those servers took while provisioning this slot; absent on recycled slots and without servers. */
    packageServerInstallMs?: number;
    restricted?: { policy: NetworkPolicy; run: string; recordDiagnostic: (message: string) => void } };

/** The package fields of a newly provisioned slot: digests of what its checkpoint has installed, and the install times. */
export function provisionedPackages(packages: readonly string[], packageInstallMs: number | undefined,
    servers: RemotePackageInstall | undefined, packageServerInstallMs: number | undefined) {
    return { packagesDigest: agentRuntimePackagesDigest(packages), ...(packageInstallMs !== undefined && { packageInstallMs }),
        packageServersDigest: packageServersDigest(servers?.servers), ...(servers?.servers.length ? { packages: servers } : {}),
        ...(packageServerInstallMs !== undefined && { packageServerInstallMs }) };
}

/**
 * The warm-pool key: a Sprite is reused only by a run whose runtime package list and package MCP
 * server set both match what its checkpoint has installed.
 */
export const spritePoolKey = (packagesDigest: string, serversDigest: string) => packagesDigest + '/' + serversDigest;
export const slotPoolKey = (slot: Pick<Slot, 'packagesDigest' | 'packageServersDigest'>) => spritePoolKey(slot.packagesDigest, slot.packageServersDigest);

/** Every Sprite slot (`PROPR_SPRITES_MAX`) stayed in use for the whole queue wait. */
export class SpritePoolCapacityError extends Error {
    constructor(message: string, readonly cap: number | undefined) {
        super(message);
        this.name = 'SpritePoolCapacityError';
    }
}

/** How long `acquire` queues at the cap: `PROPR_SPRITES_QUEUE_TIMEOUT` minutes, or a caller's shorter wait (an interactive login). */
export function queueWindow(minutes: number, maxQueueMs?: number) {
    return maxQueueMs === undefined ? { ms: minutes * 60_000, label: `${minutes}m` } : { ms: maxQueueMs, label: `${Math.round(maxQueueMs / 1000)}s` };
}
