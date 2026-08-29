import { hostname } from 'node:os';
import type { Session } from 'electron';
import { ProprClient, isProprClientError, normalizeApiBaseUrl } from '@propr/client';
import type { ProfileStore } from './profile-store';
import type { DesktopConnectionResult, DesktopProfileView } from './shared/contract';
import { isSafeExternalUrl } from './security';

interface PairingStart {
  pairingId: string;
  deviceSecret: string;
  approvalUrl: string;
  expiresAt: string;
  interval: number;
}

type PairingPoll =
  | { status: 'pending'; interval: number }
  | { status: 'complete'; token: string; tokenType: 'Bearer'; expiresAt: string | null };

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const safeProfileBaseUrl = (profile: DesktopProfileView): string =>
  normalizeApiBaseUrl(profile.baseUrl, { allowInsecureHttp: false });

const profileExistsAtOrigin = async (store: ProfileStore, profile: DesktopProfileView): Promise<void> => {
  const stored = (await store.list()).profiles.find(item => item.id === profile.id);
  if (!stored || stored.apiBaseUrl !== safeProfileBaseUrl(profile)) {
    throw new Error('Desktop profile changed while authentication was in progress');
  }
};

export class DesktopConnectionController {
  readonly #session: Session;
  readonly #profiles: ProfileStore;
  readonly #openExternal: (url: string) => Promise<void>;

  constructor(options: {
    session: Session;
    profiles: ProfileStore;
    openExternal(url: string): Promise<void>;
  }) {
    this.#session = options.session;
    this.#profiles = options.profiles;
    this.#openExternal = options.openExternal;
  }

  async probe(profile: DesktopProfileView): Promise<DesktopConnectionResult> {
    const baseUrl = safeProfileBaseUrl(profile);
    const credential = await this.#profiles.readCredential(profile.id);
    const client = new ProprClient({
      baseUrl,
      authentication: credential.available && credential.value
        ? { type: 'bearer', getAccessToken: () => credential.value }
        : { type: 'none' },
      fetch: (input, init) => this.#session.fetch(input instanceof URL ? input.href : input, init),
    });
    try {
      const compatibility = await client.negotiateCompatibility();
      if (!compatibility.compatible && compatibility.reason !== 'missing') {
        return {
          status: 'incompatible',
          message: compatibility.message,
          version: compatibility.apiVersion ?? undefined,
        };
      }
      try {
        await client.request('/api/status', {}, { timeoutMs: 8_000, responseType: 'response' });
      } catch (error) {
        if (isProprClientError(error) && (error.status === 401 || error.status === 403)) {
          return { status: 'authentication-required', message: 'Sign in to continue to this instance.' };
        }
        throw error;
      }
      return { status: 'ready', version: compatibility.apiVersion ?? undefined };
    } catch (error) {
      return { status: 'offline', message: error instanceof Error ? error.message : 'The instance is unavailable.' };
    }
  }

  async authenticate(profile: DesktopProfileView): Promise<void> {
    await profileExistsAtOrigin(this.#profiles, profile);
    if (!this.#profiles.security().available) {
      throw new Error('Secure OS credential storage is required before this instance can be paired');
    }
    const baseUrl = safeProfileBaseUrl(profile);
    const response = await this.#session.fetch(`${baseUrl}/api/desktop/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: `ProPR Desktop on ${hostname()}`.slice(0, 80) }),
    });
    if (!response.ok) throw new Error(`The instance could not start desktop sign-in (HTTP ${response.status})`);
    const pairing = await response.json() as PairingStart;
    if (!pairing.pairingId || !pairing.deviceSecret || !pairing.approvalUrl || !pairing.expiresAt) {
      throw new Error('The instance returned an invalid desktop pairing response');
    }
    if (!isSafeExternalUrl(pairing.approvalUrl)) throw new Error('The instance returned an unsafe pairing approval URL');
    await this.#openExternal(pairing.approvalUrl);

    let interval = Math.max(1, Number(pairing.interval) || 5);
    while (Date.now() < Date.parse(pairing.expiresAt)) {
      await delay(interval * 1000);
      const poll = await this.#session.fetch(
        `${baseUrl}/api/desktop/pairings/${encodeURIComponent(pairing.pairingId)}/poll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceSecret: pairing.deviceSecret }),
        },
      );
      if (poll.status === 429) {
        interval = Math.max(interval, Number(poll.headers.get('retry-after')) || interval);
        continue;
      }
      if (poll.status === 202) {
        const pending = await poll.json() as PairingPoll;
        if (pending.status === 'pending') interval = Math.max(1, pending.interval || interval);
        continue;
      }
      if (!poll.ok) throw new Error(`Desktop sign-in failed (HTTP ${poll.status})`);
      const completed = await poll.json() as PairingPoll;
      if (completed.status !== 'complete' || !completed.token) {
        throw new Error('The instance returned an invalid desktop credential');
      }
      await profileExistsAtOrigin(this.#profiles, profile);
      const stored = await this.#profiles.writeCredential(profile.id, completed.token);
      if (!stored.stored) throw new Error('Secure credential storage became unavailable');
      return;
    }
    throw new Error('Desktop sign-in expired. Try again.');
  }
}
