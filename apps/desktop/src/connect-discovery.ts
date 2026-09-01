import { parseProprConnectEndpoint } from '@propr/shared';
import type { ConnectStatusDocument } from '@propr/cli/desktop-discovery';
import type { ProfileStore } from './profile-store';
import type { DesktopDiscoveryCandidate } from './shared/contract';

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ConnectDiscoverySource {
  readonly supported: boolean;
  discover(): Promise<ConnectStatusDocument>;
}

const candidateFromStatus = (status: ConnectStatusDocument): DesktopDiscoveryCandidate | null => {
  const endpoint = status.canonicalEndpoint === null
    ? null
    : parseProprConnectEndpoint(status.canonicalEndpoint);
  if (
    status.status !== 'ready'
    || !status.apiReady
    || !endpoint
    || typeof status.publicInstanceIdentity !== 'string'
  ) return null;
  return {
    // One fixed main-owned CLI configuration selects one native stack root.
    // A constant UI identity avoids projecting even a hash of native evidence.
    id: 'propr-connect-discovered',
    label: 'ProPR Connect',
    apiBaseUrl: endpoint.origin,
  };
};

export class DesktopConnectDiscoveryService {
  constructor(
    private readonly profiles: Pick<ProfileStore, 'list'>,
    private readonly source: ConnectDiscoverySource,
  ) {}

  get supported(): boolean {
    return this.source.supported;
  }

  async discover(): Promise<DesktopDiscoveryCandidate[]> {
    if (!this.source.supported) throw new Error('Connect discovery is unavailable');
    const candidate = candidateFromStatus(await this.source.discover());
    return candidate ? [candidate] : [];
  }

  async rediscover(profileId: unknown): Promise<DesktopDiscoveryCandidate | null> {
    if (!this.source.supported || typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error('Connect rediscovery is unavailable');
    }
    const current = (await this.profiles.list()).profiles.find(profile => profile.id === profileId);
    if (!current || !parseProprConnectEndpoint(current.apiBaseUrl)) return null;
    const candidate = candidateFromStatus(await this.source.discover());
    if (!candidate) return null;
    return {
      id: current.id,
      label: current.label,
      apiBaseUrl: candidate.apiBaseUrl,
    };
  }
}
