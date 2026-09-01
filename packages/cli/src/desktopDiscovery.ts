import {
  getLocalConnectStatus,
  type ConnectStatusDocument,
  type LocalConnectStatusDependencies,
} from './commands/connectCommand.js';
import { createConfigManager } from './config/index.js';
import { assertNativeDirectoryEntry } from './utils/directoryDescriptor.js';

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
  /** @internal Packaged smoke emits only these fixed phase/code pairs. */
  reportSmokeDiagnostic?: (diagnostic: DesktopConnectDiscoverySmokeDiagnostic) => void;
}

export type DesktopConnectDiscoverySmokePhase =
  | 'config-read'
  | 'addon-integrity-type'
  | 'addon-load'
  | 'descriptor-operation'
  | 'authority-inspection'
  | 'status-resolution';

export interface DesktopConnectDiscoverySmokeDiagnostic {
  readonly phase: DesktopConnectDiscoverySmokePhase;
  readonly code: 'STARTED' | 'PASSED' | 'FAILED';
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
  reportSmokeDiagnostic,
}: FixedConnectDiscoveryOptions): Promise<ConnectStatusDocument> {
  if (!DESKTOP_CONNECT_DISCOVERY_PLATFORMS.has(platform)) {
    throw new Error('Connect discovery is unavailable on this host');
  }
  reportSmokeDiagnostic?.({ phase: 'config-read', code: 'STARTED' });
  let root: string | undefined;
  try {
    const config = await createConfigManager(configRoot, {
      readOnly: true,
      warn: () => undefined,
    });
    root = config.getStackRoot();
    reportSmokeDiagnostic?.({ phase: 'config-read', code: 'PASSED' });
  } catch (error) {
    reportSmokeDiagnostic?.({ phase: 'config-read', code: 'FAILED' });
    throw error;
  }
  if (platform === 'linux' && root !== undefined) {
    assertNativeDirectoryEntry(configRoot, 'config.json', 'file', (phase, code) => {
      reportSmokeDiagnostic?.({ phase, code });
    });
  }
  if (readStatus) {
    reportSmokeDiagnostic?.({ phase: 'status-resolution', code: 'STARTED' });
    try {
      const result = await readStatus(root);
      reportSmokeDiagnostic?.({ phase: 'status-resolution', code: 'PASSED' });
      return result;
    } catch (error) {
      reportSmokeDiagnostic?.({ phase: 'status-resolution', code: 'FAILED' });
      throw error;
    }
  }
  return getLocalConnectStatus(root, {
    ...statusDependencies,
    reportSmokeDiagnostic: (phase, code) => {
      statusDependencies?.reportSmokeDiagnostic?.(phase, code);
      reportSmokeDiagnostic?.({ phase, code });
    },
  });
}

export type { ConnectStatusDocument } from './commands/connectCommand.js';
