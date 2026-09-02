import { isPublicInstanceIdentity, parseProprConnectEndpoint } from '@propr/shared';
import type { ConnectStatusDocument } from '@propr/cli/desktop-discovery';
import type { ProfileStore } from './profile-store';
import type { DesktopDiscoveryCandidate } from './shared/contract';

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type RediscoveryProfile = Awaited<ReturnType<Pick<ProfileStore, 'list'>['list']>>['profiles'][number];

export type DesktopConnectIdentityClaimSnapshot = Readonly<
  | { status: 'unclaimed'; isCurrent(): boolean; beginCommit(): (() => void) | null }
  | {
    status: 'pending';
    generation: number;
    isCurrent(): false;
    beginCommit(): null;
  }
  | {
    status: 'origin-mismatch';
    generation: number;
    isCurrent(): boolean;
    beginCommit(): (() => void) | null;
  }
  | {
    status: 'claimed';
    generation: number;
    publicInstanceIdentity: string;
    isCurrent(): boolean;
    beginCommit(): (() => void) | null;
  }
>;

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
  readonly #identityClaims = new Map<string, {
    origin: string;
    publicInstanceIdentity: string;
    generation: number;
  }>();
  #discoveryGeneration = 0;
  #identityClaimGeneration = 0;
  readonly #claimIntentGenerations = new Map<string, number>();
  readonly #pendingClaimIntents = new Map<string, number>();
  readonly #claimCommitLocks = new Set<string>();
  readonly #claimCommitWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly profiles: Pick<ProfileStore, 'list'>,
    private readonly source: ConnectDiscoverySource,
  ) {}

  get supported(): boolean {
    return this.source.supported;
  }

  async discover(): Promise<DesktopDiscoveryCandidate[]> {
    if (!this.source.supported) throw new Error('Connect discovery is unavailable');
    const intentGeneration = this.#beginClaimIntent('propr-connect-discovered');
    const pendingCommit = this.#waitForClaimCommit('propr-connect-discovered');
    if (pendingCommit) await pendingCommit;
    const generation = ++this.#discoveryGeneration;
    const status = await this.source.discover();
    const candidate = candidateFromStatus(status);
    if (generation !== this.#discoveryGeneration
      || !this.#claimIntentIsCurrent('propr-connect-discovered', intentGeneration)) return [];
    if (candidate) this.#publishIdentityClaim(
      candidate.id, candidate.apiBaseUrl, status.publicInstanceIdentity!, intentGeneration,
    );
    return candidate ? [candidate] : [];
  }

  async rediscover(profileId: unknown): Promise<DesktopDiscoveryCandidate | null> {
    if (!this.source.supported || typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error('Connect rediscovery is unavailable');
    }
    const intentGeneration = this.#beginClaimIntent(profileId);
    const pendingCommit = this.#waitForClaimCommit(profileId);
    if (pendingCommit) await pendingCommit;
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
      || generation !== this.#discoveryGeneration
      || !this.#claimIntentIsCurrent(profileId, intentGeneration)) return null;
    this.#publishIdentityClaim(
      current.id, candidate.apiBaseUrl, status.publicInstanceIdentity!, intentGeneration,
    );
    return {
      id: current.id,
      label: current.label,
      apiBaseUrl: candidate.apiBaseUrl,
    };
  }

  snapshotIdentityClaim(profileId: string, origin: string): DesktopConnectIdentityClaimSnapshot {
    const claim = this.#identityClaims.get(profileId);
    const intentGeneration = this.#claimIntentGeneration(profileId);
    const isCurrent = () => this.#identityClaims.get(profileId) === claim
      && this.#claimIntentGeneration(profileId) === intentGeneration
      && !this.#pendingClaimIntents.has(profileId);
    const beginCommit = () => this.#beginClaimCommit(profileId, isCurrent);
    const pendingIntent = this.#pendingClaimIntents.get(profileId);
    if (pendingIntent !== undefined) {
      return Object.freeze({
        status: 'pending' as const,
        generation: pendingIntent,
        isCurrent: () => false as const,
        beginCommit: () => null,
      });
    }
    if (!claim) {
      return Object.freeze({
        status: 'unclaimed' as const,
        isCurrent,
        beginCommit,
      });
    }
    if (claim.origin !== origin) {
      return Object.freeze({
        status: 'origin-mismatch' as const,
        generation: claim.generation,
        isCurrent,
        beginCommit,
      });
    }
    return Object.freeze({
      status: 'claimed' as const,
      generation: claim.generation,
      publicInstanceIdentity: claim.publicInstanceIdentity,
      isCurrent,
      beginCommit,
    });
  }

  #claimIntentGeneration(profileId: string): number {
    return this.#claimIntentGenerations.get(profileId) ?? 0;
  }

  #beginClaimIntent(profileId: string): number {
    const generation = this.#claimIntentGeneration(profileId) + 1;
    this.#claimIntentGenerations.set(profileId, generation);
    // Publish pending synchronously before the first await. Existing active
    // snapshots become stale immediately, and no later pairing can acquire the
    // commit gate while native discovery is unresolved.
    this.#pendingClaimIntents.set(profileId, generation);
    return generation;
  }

  #claimIntentIsCurrent(profileId: string, generation: number): boolean {
    return this.#claimIntentGeneration(profileId) === generation
      && this.#pendingClaimIntents.get(profileId) === generation;
  }

  #waitForClaimCommit(profileId: string): Promise<void> | null {
    if (!this.#claimCommitLocks.has(profileId)) return null;
    return new Promise(resolve => {
      const waiters = this.#claimCommitWaiters.get(profileId) ?? [];
      waiters.push(resolve);
      this.#claimCommitWaiters.set(profileId, waiters);
    });
  }

  #beginClaimCommit(profileId: string, isCurrent: () => boolean): (() => void) | null {
    if (!isCurrent() || this.#claimCommitLocks.has(profileId)) return null;
    this.#claimCommitLocks.add(profileId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#claimCommitLocks.delete(profileId);
      const waiters = this.#claimCommitWaiters.get(profileId) ?? [];
      this.#claimCommitWaiters.delete(profileId);
      waiters.forEach(resolve => resolve());
    };
  }

  #publishIdentityClaim(
    profileId: string,
    origin: string,
    publicInstanceIdentity: string,
    intentGeneration: number,
  ): void {
    if (!this.#claimIntentIsCurrent(profileId, intentGeneration)
      || this.#claimCommitLocks.has(profileId)) return;
    this.#identityClaims.set(profileId, {
      origin,
      publicInstanceIdentity,
      generation: ++this.#identityClaimGeneration,
    });
    this.#pendingClaimIntents.delete(profileId);
  }
}
