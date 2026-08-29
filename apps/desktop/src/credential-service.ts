import { randomBytes } from 'node:crypto';
import { ProprClient, ProprClientError, type ProprDesktopPairingOptions } from '@propr/client';
import type { DesktopProfileInput, DesktopConnectionResult, DesktopAccessInvalidation } from './shared/contract';
import { normalizeApiBaseUrl } from './security';
import type { ProfileStore, StoredCredential } from './profile-store';

const DEFINITIVE_INVALID_CODES = new Set([
  'INVALID_INSTANCE_TOKEN',
  'INSTANCE_TOKEN_EXPIRED',
  'INSTANCE_TOKEN_REVOKED',
]);

export interface CredentialServiceDependencies {
  profiles: Pick<ProfileStore,
    'list' | 'save' | 'remove' | 'setActive' | 'security'
    | 'readCredential' | 'writeCredential' | 'removeCredential' | 'removeCredentialIfCurrent'>;
  fetch: typeof globalThis.fetch;
  openExternal(url: string): Promise<void>;
  clientName: string;
  /** Deterministic pairing timing for protocol tests. Production uses the client defaults. */
  pairingTiming?: Pick<ProprDesktopPairingOptions, 'sleep' | 'now'>;
}

interface ActiveCredential extends StoredCredential {
  connectionGeneration: number;
  profileGeneration: number;
}

type RequestHeaders = Record<string, string | string[]>;
export interface DesktopRequestDecision {
  cancel?: true;
  requestHeaders?: RequestHeaders;
}

const headerName = (headers: RequestHeaders, name: string): string | undefined =>
  Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());

const removeHeader = (headers: RequestHeaders, name: string): void => {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
};

const requestOrigin = (value: string): { origin: string; pathname: string } | null => {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
};

const parseCode = async (response: Response): Promise<string | undefined> => {
  try {
    const value = await response.clone().json() as { code?: unknown };
    return typeof value.code === 'string' ? value.code : undefined;
  } catch {
    return undefined;
  }
};

const authenticationSummary = (capabilities: {
  browserPairing: boolean;
  instanceBearerTokens: boolean;
  socketIoBearerAuthentication: boolean;
}): string => capabilities.browserPairing
  && capabilities.instanceBearerTokens
  && capabilities.socketIoBearerAuthentication
  ? 'Browser approval · REST and Socket.IO bearer access'
  : 'Secure desktop pairing is unavailable';

export class DesktopCredentialService {
  readonly #profiles: CredentialServiceDependencies['profiles'];
  readonly #fetch: typeof globalThis.fetch;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #clientName: string;
  readonly #pairingTiming: Pick<ProprDesktopPairingOptions, 'sleep' | 'now'>;
  readonly #internalRequestKey = randomBytes(32).toString('base64url');
  readonly #profileGenerations = new Map<string, number>();
  readonly #pairingControllers = new Map<string, AbortController>();
  #selectionGeneration = 0;
  #nextConnectionGeneration = 0;
  #active: ActiveCredential | null = null;

  constructor(dependencies: CredentialServiceDependencies) {
    this.#profiles = dependencies.profiles;
    this.#fetch = dependencies.fetch;
    this.#openExternal = dependencies.openExternal;
    this.#clientName = dependencies.clientName;
    this.#pairingTiming = dependencies.pairingTiming ?? {};
  }

  async saveProfile(input: DesktopProfileInput) {
    const before = input.id
      ? (await this.#profiles.list()).profiles.find(profile => profile.id === input.id)
      : undefined;
    const nextOrigin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!nextOrigin) throw new Error('Invalid desktop API URL');
    if (before && before.apiBaseUrl !== nextOrigin) {
      this.#invalidateProfileOperations(before.id);
      const credential = await this.#profiles.readCredential(before.id);
      if (credential) await this.#revoke(credential).catch(() => undefined);
      await this.#profiles.removeCredential(before.id);
      if (this.#active?.profileId === before.id) this.#active = null;
    }
    const saved = await this.#profiles.save(input);
    this.#profileGenerations.set(saved.id, this.#generation(saved.id));
    return saved;
  }

  async removeProfile(profileId: string): Promise<void> {
    this.#invalidateProfileOperations(profileId);
    const credential = await this.#profiles.readCredential(profileId);
    if (credential) await this.#revoke(credential).catch(() => undefined);
    if (this.#active?.profileId === profileId) this.#active = null;
    await this.#profiles.remove(profileId);
  }

  async setActiveProfile(profileId: string | null): Promise<void> {
    this.#selectionGeneration += 1;
    for (const controller of this.#pairingControllers.values()) controller.abort();
    this.#pairingControllers.clear();
    if (this.#active?.profileId !== profileId) this.#active = null;
    await this.#profiles.setActive(profileId);
  }

  cancelPairing(profileId: string): void {
    this.#bumpGeneration(profileId);
    this.#pairingControllers.get(profileId)?.abort();
    this.#pairingControllers.delete(profileId);
  }

  async pair(input: DesktopProfileInput): Promise<{ paired: true }> {
    const profile = await this.saveProfile(input);
    this.cancelPairing(profile.id);
    const controller = new AbortController();
    this.#pairingControllers.set(profile.id, controller);
    const profileGeneration = this.#generation(profile.id);
    const selectionGeneration = this.#selectionGeneration;
    let transient: StoredCredential | null = null;
    const client = this.#client(profile.apiBaseUrl);

    try {
      const completed = await client.pairDesktop(this.#clientName, {
        ...this.#pairingTiming,
        signal: controller.signal,
        onApprovalRequired: async approvalUrl => {
          this.#assertPairingCurrent(profile.id, profile.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal);
          await this.#openExternal(approvalUrl);
        },
      });
      transient = {
        version: 1,
        profileId: profile.id,
        origin: profile.apiBaseUrl,
        token: completed.token,
      };
      await this.#assertPersistedPairingCurrent(
        profile.id, profile.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal,
      );
      const stored = await this.#profiles.writeCredential(transient);
      if (!stored.stored) throw new Error('OS-backed secure storage is required for desktop pairing.');
      await this.#assertPersistedPairingCurrent(
        profile.id, profile.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal,
      );
      transient = null;
      return { paired: true };
    } catch (error) {
      if (transient) {
        await this.#revoke(transient).catch(() => undefined);
        await this.#profiles.removeCredential(profile.id).catch(() => undefined);
      }
      if (error instanceof ProprClientError && error.kind === 'aborted') {
        throw new Error('Desktop pairing was cancelled.');
      }
      throw error;
    } finally {
      if (this.#pairingControllers.get(profile.id) === controller) this.#pairingControllers.delete(profile.id);
    }
  }

  async probe(input: DesktopProfileInput): Promise<DesktopConnectionResult> {
    if (!input.id) throw new Error('Desktop profile id is required');
    const origin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!origin || origin !== input.apiBaseUrl) throw new Error('Invalid desktop API URL');
    const operationGeneration = this.#generation(input.id);
    const operationSelection = this.#selectionGeneration;
    const discoveryClient = this.#client(origin);
    let discovery;
    try {
      discovery = await discoveryClient.discoverDesktop();
    } catch (error) {
      return {
        status: 'offline',
        message: error instanceof Error
          ? `ProPR could not discover this instance. ${error.message}`
          : 'ProPR could not discover this instance.',
      };
    }
    const authentication = authenticationSummary(discovery.desktopAuthentication);
    if (!discovery.compatibility.compatible) {
      return { status: 'incompatible', message: discovery.compatibility.message, version: discovery.version };
    }
    if (!this.#profiles.security().available) {
      return {
        status: 'authentication-required',
        message: 'OS-backed secure storage is unavailable. Enable your system keychain before pairing.',
        version: discovery.version,
        authentication,
      };
    }

    let credential = await this.#profiles.readCredential(input.id);
    if (credential && credential.origin !== origin) {
      this.#bumpGeneration(input.id);
      await this.#revoke(credential).catch(() => undefined);
      await this.#profiles.removeCredential(input.id);
      if (this.#active?.profileId === input.id) this.#active = null;
      credential = null;
    }
    if (!credential) {
      return {
        status: 'authentication-required',
        message: discovery.desktopAuthentication.browserPairing
          ? 'Approve this desktop in your browser to continue.'
          : 'This instance does not support secure desktop pairing.',
        version: discovery.version,
        authentication,
      };
    }

    let response: Response;
    try {
      response = await this.#authenticatedFetch(credential, '/api/auth/user', { cache: 'no-store' }, 8_000);
    } catch {
      return { status: 'offline', message: 'The instance was discovered but authentication could not be checked.' };
    }
    if (response.ok) {
      const persisted = (await this.#profiles.list()).profiles.find(profile => profile.id === input.id);
      if (this.#generation(input.id) !== operationGeneration
        || this.#selectionGeneration !== operationSelection
        || !persisted || persisted.apiBaseUrl !== origin) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      const connectionGeneration = ++this.#nextConnectionGeneration;
      this.#active = { ...credential, profileGeneration: operationGeneration, connectionGeneration };
      return { status: 'ready', version: discovery.version, authentication, connectionGeneration };
    }

    const code = await parseCode(response);
    if (code && DEFINITIVE_INVALID_CODES.has(code)) {
      const removed = await this.#profiles.removeCredentialIfCurrent(
        credential,
        origin,
        () => this.#generation(input.id!) === operationGeneration
          && this.#selectionGeneration === operationSelection,
      );
      if (!removed) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      if (this.#active?.profileId === input.id
        && this.#active.profileGeneration === operationGeneration
        && this.#active.origin === credential.origin
        && this.#active.token === credential.token) this.#active = null;
      return {
        status: 'authentication-required',
        message: 'Access to this instance was revoked or expired. Pair again to continue.',
        version: discovery.version,
        authentication,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'offline',
        message: 'The credential is still paired, but current authorization could not be confirmed. Try again.',
      };
    }
    return { status: 'offline', message: `The instance returned HTTP ${response.status} while checking authentication.` };
  }

  async invalidate(value: DesktopAccessInvalidation): Promise<{ invalidated: boolean }> {
    if (!DEFINITIVE_INVALID_CODES.has(value.code)) return { invalidated: false };
    const active = this.#active;
    if (!active || active.profileId !== value.profileId
      || active.connectionGeneration !== value.connectionGeneration) return { invalidated: false };
    this.#active = null;
    this.#bumpGeneration(active.profileId);
    await this.#profiles.removeCredential(active.profileId);
    return { invalidated: true };
  }

  prepareRequest(url: string, originalHeaders: RequestHeaders): DesktopRequestDecision {
    const headers = { ...originalHeaders };
    const internalHeader = headerName(headers, 'x-propr-desktop-main-request');
    const trustedMainRequest = internalHeader !== undefined
      && headers[internalHeader] === this.#internalRequestKey;
    if (internalHeader) delete headers[internalHeader];

    // The packaged renderer has no cookie identity on any remote HTTP(S) or
    // WS(S) origin. It also cannot supply its own bearer. Main-process bearer
    // requests are distinguished by the per-process secret marker above.
    removeHeader(headers, 'cookie');
    if (!trustedMainRequest) removeHeader(headers, 'authorization');

    const target = requestOrigin(url);
    if (!trustedMainRequest && target
      && (target.pathname.startsWith('/api/desktop/pairings')
        || target.pathname.startsWith('/api/desktop/tokens'))) return { cancel: true };

    const active = this.#active;
    if (!target || !active || this.#generation(active.profileId) !== active.profileGeneration
      || target.origin !== active.origin
      || (!target.pathname.startsWith('/api/') && !target.pathname.startsWith('/socket.io/'))) {
      return { requestHeaders: headers };
    }
    if (!trustedMainRequest) headers.Authorization = `Bearer ${active.token}`;
    return { requestHeaders: headers };
  }

  authorizeRequest(url: string, originalHeaders: RequestHeaders): RequestHeaders {
    return this.prepareRequest(url, originalHeaders).requestHeaders ?? {};
  }

  sanitizeResponseHeaders(url: string, originalHeaders: RequestHeaders): RequestHeaders {
    const headers = { ...originalHeaders };
    const target = requestOrigin(url);
    if (target) removeHeader(headers, 'set-cookie');
    return headers;
  }

  #client(origin: string): ProprClient {
    return new ProprClient({
      baseUrl: origin,
      authentication: { type: 'none' },
      fetch: this.#mainFetch,
      defaultTimeoutMs: 8_000,
    });
  }

  #authenticatedFetch(
    credential: StoredCredential,
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const client = new ProprClient({
      baseUrl: credential.origin,
      authentication: { type: 'bearer', getAccessToken: () => credential.token },
      fetch: this.#mainFetch,
    });
    return client.fetch(client.url(path), { ...init, redirect: 'manual' }, { timeoutMs });
  }

  readonly #mainFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-ProPR-Desktop-Main-Request', this.#internalRequestKey);
    return this.#fetch(input, { ...init, headers });
  };

  async #revoke(credential: StoredCredential): Promise<void> {
    const response = await this.#authenticatedFetch(
      credential,
      '/api/desktop/tokens/current',
      { method: 'DELETE' },
      8_000,
    );
    if (!response.ok && response.status !== 401 && response.status !== 404) {
      throw new Error(`The instance could not revoke this connection (HTTP ${response.status}).`);
    }
  }

  #generation(profileId: string): number {
    return this.#profileGenerations.get(profileId) ?? 0;
  }

  #bumpGeneration(profileId: string): number {
    const generation = this.#generation(profileId) + 1;
    this.#profileGenerations.set(profileId, generation);
    return generation;
  }

  #invalidateProfileOperations(profileId: string): void {
    this.#bumpGeneration(profileId);
    this.#pairingControllers.get(profileId)?.abort();
    this.#pairingControllers.delete(profileId);
  }

  #assertPairingCurrent(
    profileId: string,
    origin: string,
    profileGeneration: number,
    selectionGeneration: number,
    signal: AbortSignal,
  ): void {
    if (signal.aborted || this.#generation(profileId) !== profileGeneration
      || this.#selectionGeneration !== selectionGeneration) {
      throw new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' });
    }
    if (normalizeApiBaseUrl(origin) !== origin) throw new Error('Invalid desktop API URL');
  }

  async #assertPersistedPairingCurrent(
    profileId: string,
    origin: string,
    profileGeneration: number,
    selectionGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.#assertPairingCurrent(profileId, origin, profileGeneration, selectionGeneration, signal);
    const current = (await this.#profiles.list()).profiles.find(profile => profile.id === profileId);
    if (!current || current.apiBaseUrl !== origin) {
      throw new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' });
    }
    this.#assertPairingCurrent(profileId, origin, profileGeneration, selectionGeneration, signal);
  }
}
