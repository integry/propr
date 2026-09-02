import { isPublicInstanceIdentity, parseProprConnectEndpoint } from '@propr/shared';
import type { ConnectStatusDocument } from '@propr/cli/desktop-discovery';
import type { ProfileStore } from './profile-store';
import type { DesktopDiscoveryCandidate } from './shared/contract';

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type RediscoveryProfile = Awaited<ReturnType<Pick<ProfileStore, 'list'>['list']>>['profiles'][number];

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
    || !isPublicInstanceIdentity(status.publicInstanceIdentity)
  ) return null;
  return {
    // One fixed main-owned CLI configuration selects one native stack root.
    // A constant UI identity avoids projecting even a hash of native evidence.
    id: 'propr-connect-discovered',
    label: 'ProPR Connect',
    apiBaseUrl: endpoint.origin,
  };
};

const sameRediscoveryProfile = (left: RediscoveryProfile, right: RediscoveryProfile): boolean =>
  left.id === right.id
  && left.label === right.label
  && left.apiBaseUrl === right.apiBaseUrl
  && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt;

export class DesktopConnectDiscoveryService {
  readonly #identityClaims = new Map<string, { origin: string; publicInstanceIdentity: string }>();
  #discoveryGeneration = 0;

  constructor(
    private readonly profiles: Pick<ProfileStore, 'list'>,
    private readonly source: ConnectDiscoverySource,
  ) {}

  get supported(): boolean {
    return this.source.supported;
  }

  async discover(): Promise<DesktopDiscoveryCandidate[]> {
    if (!this.source.supported) throw new Error('Connect discovery is unavailable');
    const generation = ++this.#discoveryGeneration;
    const status = await this.source.discover();
    const candidate = candidateFromStatus(status);
    if (generation !== this.#discoveryGeneration) return [];
    if (candidate) this.#publishIdentityClaim(candidate.id, candidate.apiBaseUrl, status.publicInstanceIdentity!);
    return candidate ? [candidate] : [];
  }

  async rediscover(profileId: unknown): Promise<DesktopDiscoveryCandidate | null> {
    if (!this.source.supported || typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error('Connect rediscovery is unavailable');
    }
    const generation = ++this.#discoveryGeneration;
    const current = (await this.profiles.list()).profiles.find(profile => profile.id === profileId);
    const currentEndpoint = current ? parseProprConnectEndpoint(current.apiBaseUrl) : null;
    if (!current || !currentEndpoint) return null;
    const status = await this.source.discover();
    const candidate = candidateFromStatus(status);
    if (!candidate) return null;
    const revalidated = (await this.profiles.list()).profiles.find(profile => profile.id === profileId);
    const revalidatedEndpoint = revalidated ? parseProprConnectEndpoint(revalidated.apiBaseUrl) : null;
    if (!revalidated
      || !revalidatedEndpoint
      || revalidatedEndpoint.origin !== currentEndpoint.origin
      || !sameRediscoveryProfile(current, revalidated)
      || generation !== this.#discoveryGeneration) return null;
    this.#publishIdentityClaim(current.id, candidate.apiBaseUrl, status.publicInstanceIdentity!);
    return {
      id: current.id,
      label: current.label,
      apiBaseUrl: candidate.apiBaseUrl,
    };
  }

  expectedPublicInstanceIdentity(profileId: string, origin: string): string | null {
    const claim = this.#identityClaims.get(profileId);
    return claim?.origin === origin ? claim.publicInstanceIdentity : null;
  }

  #publishIdentityClaim(profileId: string, origin: string, publicInstanceIdentity: string): void {
    this.#identityClaims.set(profileId, { origin, publicInstanceIdentity });
  }
}
