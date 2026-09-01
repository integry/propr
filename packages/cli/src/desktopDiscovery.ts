import {
  getLocalConnectStatus,
  type ConnectStatusDocument,
  type LocalConnectStatusDependencies,
} from './commands/connectCommand.js';
import { createConfigManager } from './config/index.js';

export const DESKTOP_CONNECT_DISCOVERY_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  'darwin',
  'linux',
  'win32',
]);

export interface FixedConnectDiscoveryOptions {
  /** Fixed CLI configuration directory selected by the trusted desktop main process. */
  configRoot: string;
  platform?: NodeJS.Platform;
  readStatus?: (root: string | undefined) => Promise<ConnectStatusDocument>;
  /** @internal Packaged smoke keeps native authority real while replacing external network/process probes. */
  statusDependencies?: LocalConnectStatusDependencies;
}

/**
 * Read the configured native stack root from the fixed private CLI config and
 * run the same authority-checked, secret-free discovery used by `propr connect
 * status`. Neither root is returned to the caller.
 */
export async function discoverConfiguredConnect({
  configRoot,
  platform = process.platform,
  readStatus,
  statusDependencies,
}: FixedConnectDiscoveryOptions): Promise<ConnectStatusDocument> {
  if (!DESKTOP_CONNECT_DISCOVERY_PLATFORMS.has(platform)) {
    throw new Error('Connect discovery is unavailable on this host');
  }
  const config = await createConfigManager(configRoot, {
    readOnly: true,
    warn: () => undefined,
  });
  const root = config.getStackRoot();
  return readStatus ? readStatus(root) : getLocalConnectStatus(root, statusDependencies);
}

export type { ConnectStatusDocument } from './commands/connectCommand.js';
