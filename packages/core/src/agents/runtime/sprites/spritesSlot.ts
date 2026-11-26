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
