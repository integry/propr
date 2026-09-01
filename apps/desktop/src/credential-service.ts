import { randomBytes } from 'node:crypto';
import {
  ProprClient,
  ProprClientError,
  type PairingProtocolRequestOptions,
  type ProprDesktopPairingOptions,
} from '@propr/client';
import {
  DESKTOP_REVOCATION_BINDING_HEADER,
  DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  DESKTOP_TOKEN_REVOCATION_SCHEMA,
  DESKTOP_TOKEN_REVOCATION_VERSION,
  DESKTOP_TOKEN_TERMINAL_CODES,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  canonicalProprHttpUrlOrigin,
} from '@propr/shared';
import {
  type DesktopProfileInput,
  type DesktopConnectionResult,
  type DesktopActivatedConnection,
  type DesktopAccessInvalidation,
  type DesktopConnectionScope,
} from './shared/contract';
import { normalizeApiBaseUrl } from './security';
import type { PendingCredentialRevocation, ProfileStore, StoredCredential } from './profile-store';

const DEFINITIVE_INVALID_CODES = new Set([
  'INVALID_INSTANCE_TOKEN',
  'INSTANCE_TOKEN_EXPIRED',
  'INSTANCE_TOKEN_REVOKED',
]);

export interface CredentialServiceDependencies {
  profiles: Pick<ProfileStore,
    'list' | 'saveAndDetachCredential' | 'commitPairedProfile' | 'detachProfile' | 'setActive' | 'activateProfile' | 'security'
    | 'readCredential' | 'readProfileCredential' | 'writeCredential' | 'removeCredential'
    | 'removeCredentialIfCurrent' | 'journalPendingRevocation' | 'releasePendingRevocation'
    | 'pendingRevocations' | 'completePendingRevocation' | 'awaitIdle'>;
  fetch: typeof globalThis.fetch;
  openPairingBrowser(request: DesktopPairingBrowserRequest): Promise<void>;
  clientName: string;
  /** Deterministic pairing timing for protocol tests. Production uses the client defaults. */
  pairingTiming?: Pick<ProprDesktopPairingOptions, 'sleep' | 'now'>;
  /** Deterministic service/native lifecycle proof; production uses fixed protocol defaults. */
  pairingProtocol?: PairingProtocolRequestOptions;
  /** Tests may shorten, but never enlarge, the production revocation deadlines. */
  revocationDeadlines?: Partial<RevocationDeadlines>;
  reportRevocationFailure?(diagnostic: {
    code: 'network' | 'http' | 'local-cleanup';
    status?: number;
  }): void;
}

export interface DesktopPairingBrowserRequest {
  apiBaseUrl: string;
  pairingId: string;
  approvalUrl: string;
}

export interface CredentialServiceInitialization {
  status: 'ready' | 'degraded';
  retryPending: boolean;
}

interface RevocationDeadlines {
  headerMs: number;
  bodyMs: number;
  recordMs: number;
  aggregateMs: number;
}

interface ActiveCredential extends StoredCredential {
  identityEpoch: string;
  profileGeneration: number;
  selectionGeneration: number;
  transportScope: string;
}

interface PendingActivation {
  ticket: string;
  probeTicket: number;
  profileId: string;
  origin: string;
  profileGeneration: number;
  selectionGeneration: number;
  activeProfileId: string | null;
  credential: StoredCredential;
  identityEpoch: string;
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

const headerValues = (headers: RequestHeaders, name: string): string[] => {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values;
};

const TRANSPORT_SCOPE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_REVOCATION_RESPONSE_BYTES = 2_048;
const TERMINAL_REVOCATION_CODES = new Set<string>(DESKTOP_TOKEN_TERMINAL_CODES);
const REVOCATION_DEADLINES: RevocationDeadlines = {
  headerMs: 8_000,
  bodyMs: 2_000,
  recordMs: 10_000,
  aggregateMs: 12_000,
};

const boundedRevocationDeadlines = (
  requested: Partial<RevocationDeadlines> | undefined,
): RevocationDeadlines => Object.fromEntries(
  Object.entries(REVOCATION_DEADLINES).map(([key, maximum]) => {
    const value = requested?.[key as keyof RevocationDeadlines] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error('Invalid desktop revocation deadline');
    }
    return [key, value];
  }),
) as unknown as RevocationDeadlines;

const linkedAbortController = (signals: readonly AbortSignal[]): {
  controller: AbortController;
  dispose: () => void;
} => {
  const controller = new AbortController();
  const onAbort = (event: Event): void => {
    const signal = event.target as AbortSignal;
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    controller,
    dispose: () => signals.forEach(signal => signal.removeEventListener('abort', onAbort)),
  };
};

const requestOrigin = (value: string): { origin: string; pathname: string; url: URL } | null => {
  try {
    const httpValue = value.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    if (canonicalProprHttpUrlOrigin(httpValue) !== url.origin) return null;
    return { origin: url.origin, pathname: url.pathname, url };
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

const isEndpointBoundTerminalRevocation = async (
  response: Response,
  credential: StoredCredential,
  credentialGeneration: string,
  signal: AbortSignal,
  abortNetwork: () => void,
  bodyDeadlineMs: number,
): Promise<boolean> => {
  if (response.redirected) return false;
  if (response.url) {
    try {
      const url = new URL(response.url);
      if (url.href !== `${credential.origin}${DESKTOP_TOKEN_REVOCATION_ENDPOINT}`) return false;
    } catch {
      return false;
    }
  }
  if (response.ok) return true;
  if (response.status !== 401 && response.status !== 404) return false;
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return false;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)
      || Number(declaredLength) > MAX_REVOCATION_RESPONSE_BYTES)) return false;
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason ?? new Error('Desktop revocation body was cancelled'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  deadline = setTimeout(() => {
    abortNetwork();
    rejectAbort(new Error('Desktop revocation body timed out'));
  }, bodyDeadlineMs);
  let text: string;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) {
        abortNetwork();
        return false;
      }
      received += part.value.byteLength;
      if (received > MAX_REVOCATION_RESPONSE_BYTES) {
        abortNetwork();
        return false;
      }
      chunks.push(Uint8Array.from(part.value));
    }
    if (declaredLength !== null && Number(declaredLength) !== received) {
      abortNetwork();
      return false;
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    abortNetwork();
    return false;
  } finally {
    if (deadline) clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      // Invoking both primitives is important for native fetch and deterministic
      // ReadableStream tests. Network abort is the authoritative bounded wait.
      let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reader.cancel(),
          new Promise<void>(resolve => {
            cancelDeadline = setTimeout(resolve, Math.min(bodyDeadlineMs, 100));
          }),
        ]);
      } catch {
        // The owning network controller is already aborted.
      } finally {
        if (cancelDeadline) clearTimeout(cancelDeadline);
      }
    }
    try { reader.releaseLock(); } catch { /* A hostile stream may retain a pending read. */ }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    abortNetwork();
    return false;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    abortNetwork();
    return false;
  }
  const body = raw as Record<string, unknown>;
  const expectedKeys = [
    'schema', 'version', 'endpoint', 'terminal', 'code', 'credentialGeneration',
  ];
  if (Object.keys(body).length !== expectedKeys.length
    || expectedKeys.some(key => !(key in body))) {
    abortNetwork();
    return false;
  }
  if (body.schema !== DESKTOP_TOKEN_REVOCATION_SCHEMA
    || body.version !== DESKTOP_TOKEN_REVOCATION_VERSION
    || body.endpoint !== DESKTOP_TOKEN_REVOCATION_ENDPOINT
    || body.terminal !== true
    || body.credentialGeneration !== credentialGeneration
    || typeof body.code !== 'string'
    || !TERMINAL_REVOCATION_CODES.has(body.code)) {
    abortNetwork();
    return false;
  }
  const terminal = response.status === 404
    ? body.code === 'TOKEN_NOT_FOUND'
    : body.code === 'INSTANCE_TOKEN_REVOKED' || body.code === 'INSTANCE_TOKEN_EXPIRED';
  if (!terminal) abortNetwork();
  return terminal;
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
  readonly #openPairingBrowser: (request: DesktopPairingBrowserRequest) => Promise<void>;
  readonly #clientName: string;
  readonly #pairingTiming: Pick<ProprDesktopPairingOptions, 'sleep' | 'now'>;
  readonly #pairingProtocol: PairingProtocolRequestOptions;
  readonly #reportRevocationFailure: NonNullable<CredentialServiceDependencies['reportRevocationFailure']>;
  readonly #revocationDeadlines: RevocationDeadlines;
  readonly #internalRequestKey = randomBytes(32).toString('base64url');
  readonly #lifecycleController = new AbortController();
  readonly #profileGenerations = new Map<string, number>();
  readonly #pairingControllers = new Map<string, AbortController>();
  #selectionGeneration = 0;
  #latestProbeTicket = 0;
  #pendingActivation: PendingActivation | null = null;
  #active: ActiveCredential | null = null;
  #publishingPair = false;
  #publishWaiters: Array<() => void> = [];
  #retryRequested = false;
  #retryIncludeDeferred = false;
  #revocationWorker: Promise<CredentialServiceInitialization> | null = null;
  readonly #backgroundTasks = new Set<Promise<unknown>>();
  readonly #operationTasks = new Set<Promise<void>>();
  readonly #operationControllers = new Set<AbortController>();
  #closed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(dependencies: CredentialServiceDependencies) {
    this.#profiles = dependencies.profiles;
    this.#fetch = dependencies.fetch;
    this.#openPairingBrowser = dependencies.openPairingBrowser;
    this.#clientName = dependencies.clientName;
    this.#pairingTiming = dependencies.pairingTiming ?? {};
    this.#pairingProtocol = dependencies.pairingProtocol ?? {};
    this.#reportRevocationFailure = dependencies.reportRevocationFailure ?? (() => undefined);
    this.#revocationDeadlines = boundedRevocationDeadlines(dependencies.revocationDeadlines);
  }

  async initialize(): Promise<CredentialServiceInitialization> {
    const operation = this.#beginOperation();
    try {
    const worker = this.#requestPendingRevocationRetry(true);
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        worker,
        new Promise<CredentialServiceInitialization>(resolve => {
          startupTimer = setTimeout(
            () => resolve({ status: 'degraded', retryPending: true }),
            this.#revocationDeadlines.aggregateMs,
          );
        }),
      ]);
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    } finally {
      operation.done();
    }
  }

  awaitIdle(): Promise<void> {
    return this.#awaitIdle();
  }

  async listProfiles() {
    const operation = this.#beginOperation();
    try {
      return await this.#profiles.list();
    } finally {
      operation.done();
    }
  }

  async storageSecurity() {
    const operation = this.#beginOperation();
    try {
      return this.#profiles.security();
    } finally {
      operation.done();
    }
  }

  async retryPendingRevocations(): Promise<CredentialServiceInitialization> {
    const operation = this.#beginOperation();
    try {
      return await this.#requestPendingRevocationRetry(true);
    } finally {
      operation.done();
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#closed = true;
    this.#active = null;
    this.#pendingActivation = null;
    this.#lifecycleController.abort(new Error('Desktop credential service disposed'));
    for (const controller of this.#operationControllers) controller.abort(new Error('Desktop credential service disposed'));
    for (const controller of this.#pairingControllers.values()) controller.abort();
    this.#pairingControllers.clear();
    this.#disposePromise = (async () => {
      await this.#awaitIdle();
      await this.#profiles.awaitIdle();
    })();
    return this.#disposePromise;
  }

  async saveProfile(
    input: DesktopProfileInput,
    beforeOriginChangeCommit?: (previousOrigin: string, nextOrigin: string) => Promise<void>,
  ) {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    const before = input.id
      ? (await this.#profiles.list()).profiles.find(profile => profile.id === input.id)
      : undefined;
    const nextOrigin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!nextOrigin) throw new Error('Invalid desktop API URL');
    let invalidatedBeforeSave = false;
    if (before && before.apiBaseUrl !== nextOrigin) {
      this.#invalidateProfileOperations(before.id);
      invalidatedBeforeSave = true;
    }
    const transaction = await this.#profiles.saveAndDetachCredential(input, beforeOriginChangeCommit);
    if (transaction.originChanged && !invalidatedBeforeSave) {
      this.#invalidateProfileOperations(transaction.profile.id);
    }
    if (transaction.detachedCredential) this.#clearActiveIfCredential(transaction.detachedCredential);
    if (transaction.originChanged && this.#active?.profileId === transaction.profile.id) this.#active = null;
    this.#schedulePendingRevocationRetry();
    return transaction.profile;
    } finally {
      operation.done();
    }
  }

  async removeProfile(
    profileId: string,
    beforeCommit?: (origin: string) => Promise<void>,
  ): Promise<string | null> {
    const operation = this.#beginOperation();
    try {
    if (this.#publishingPair) await this.#waitForPairPublish();
    this.#invalidateProfileOperations(profileId);
    this.#schedulePendingRevocationRetry();
    const detached = await this.#profiles.detachProfile(profileId, beforeCommit);
    if (!detached) return null;
    if (detached.credential) this.#clearActiveIfCredential(detached.credential);
    this.#schedulePendingRevocationRetry();
    return detached.profile.apiBaseUrl;
    } finally {
      operation.done();
    }
  }

  async setActiveProfile(profileId: string | null): Promise<void> {
    const operation = this.#beginOperation();
    try {
    if (this.#publishingPair) await this.#waitForPairPublish();
    this.#selectionGeneration += 1;
    this.#latestProbeTicket += 1;
    this.#pendingActivation = null;
    for (const controller of this.#pairingControllers.values()) controller.abort();
    this.#pairingControllers.clear();
    this.#active = null;
    this.#schedulePendingRevocationRetry();
    await this.#profiles.setActive(profileId);
    } finally {
      operation.done();
    }
  }

  async cancelPairing(profileId: string): Promise<void> {
    const operation = this.#beginOperation();
    try {
      if (this.#publishingPair) await this.#waitForPairPublish();
      this.#cancelPairingNow(profileId);
    } finally {
      operation.done();
    }
  }

  #cancelPairingNow(profileId: string): void {
    const generation = this.#bumpGeneration(profileId);
    // Cancelling an in-progress edit must not disable the still-committed
    // credential for an active profile.
    if (this.#active?.profileId === profileId) this.#active.profileGeneration = generation;
    this.#pairingControllers.get(profileId)?.abort();
    this.#pairingControllers.delete(profileId);
  }

  async pair(input: DesktopProfileInput): Promise<{ paired: true }> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (!input.id) throw new Error('Desktop profile id is required');
    if (!this.#profiles.security().available) {
      throw new Error('OS-backed secure storage is required for desktop pairing.');
    }
    const origin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!origin) throw new Error('Invalid desktop API URL');
    const label = input.label?.trim();
    if (!label || label.length > 80) throw new Error('Profile label must contain 1 to 80 characters');
    const proposed = { ...input, id: input.id, label, apiBaseUrl: origin };
    const baseline = await this.#profiles.readProfileCredential(proposed.id);
    this.#cancelPairingNow(proposed.id);
    if (this.#pendingActivation?.profileId === proposed.id) this.#pendingActivation = null;
    const controller = new AbortController();
    this.#pairingControllers.set(proposed.id, controller);
    const profileGeneration = this.#generation(proposed.id);
    const selectionGeneration = this.#selectionGeneration;
    const credentialGeneration = randomBytes(16).toString('base64url');
    let transient: StoredCredential | null = null;
    let transientRevocation: PendingCredentialRevocation | null = null;
    let provisional: Awaited<ReturnType<ProprClient['pairDesktop']>> | null = null;
    let publicationStarted = false;
    const client = this.#client(proposed.apiBaseUrl);

    try {
      const completed = await client.pairDesktop(this.#clientName, {
        ...this.#pairingTiming,
        binding: {
          instanceId: proposed.id,
          origin: proposed.apiBaseUrl,
          scope: 'desktop-instance',
          credentialGeneration,
        },
        signal: controller.signal,
        onApprovalRequired: async (approvalUrl, _expiresAt, pairingId) => {
          this.#assertPairingCurrent(
            proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal,
          );
          await this.#openPairingBrowser({
            apiBaseUrl: proposed.apiBaseUrl,
            pairingId,
            approvalUrl,
          });
        },
      });
      provisional = completed;
      transient = {
        version: 1,
        profileId: proposed.id,
        origin: proposed.apiBaseUrl,
        token: completed.token,
      };
      const journaled = await this.#profiles.journalPendingRevocation(transient, credentialGeneration);
      if ('stored' in journaled) {
        throw new Error('OS-backed secure storage is required for desktop pairing.');
      }
      transientRevocation = journaled;
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal,
      );
      let activationError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await client.activateDesktopPairing(completed, controller.signal);
          activationError = undefined;
          break;
        } catch (error) {
          activationError = error;
          if (controller.signal.aborted) break;
        }
      }
      if (activationError) throw activationError;
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal,
      );
      const committed = await this.#profiles.commitPairedProfile(
        proposed,
        transient,
        baseline,
        () => !controller.signal.aborted
          && this.#generation(proposed.id) === profileGeneration
          && this.#selectionGeneration === selectionGeneration,
        () => this.#beginPairPublish(
          proposed.id, profileGeneration, selectionGeneration, controller.signal,
        ),
        () => {
          publicationStarted = true;
          if (this.#active?.profileId === proposed.id) this.#active = null;
        },
        transientRevocation.id,
      );
      if (committed && 'stored' in committed) {
        throw new Error('OS-backed secure storage is required for desktop pairing.');
      }
      if (!committed) throw new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' });
      transient = null;
      transientRevocation = null;
      this.#schedulePendingRevocationRetry();
      return { paired: true };
    } catch (error) {
      if (transient && !transientRevocation && !publicationStarted) {
        try {
          const journaled = await this.#profiles.journalPendingRevocation(transient, credentialGeneration);
          if (!('stored' in journaled)) transientRevocation = journaled;
        } catch {
          // Preserve the original pairing/storage error. A retry is attempted
          // below whenever durable material was established.
        }
      }
      if (transientRevocation && !publicationStarted) {
        let cancelled = false;
        if (provisional) {
          try {
            await client.cancelDesktopPairing(provisional, operation.signal);
            cancelled = await this.#profiles.completePendingRevocation(
              transientRevocation.id,
              transientRevocation.credential,
              transientRevocation.credentialGeneration,
            );
          } catch {
            // The encrypted rollback remains authoritative until either exact
            // cancellation or the endpoint-bound revocation worker confirms it.
          }
        }
        if (!cancelled) {
          const released = await this.#profiles.releasePendingRevocation(
            transientRevocation.id,
            transientRevocation.credentialGeneration,
          );
          if (released) await this.#requestPendingRevocationRetry();
        }
      }
      if (controller.signal.aborted || operation.signal.aborted
        || (error instanceof ProprClientError && error.kind === 'aborted')) {
        throw new Error('Desktop pairing was cancelled.');
      }
      throw error;
    } finally {
      if (this.#pairingControllers.get(proposed.id) === controller) this.#pairingControllers.delete(proposed.id);
    }
    } finally {
      operation.done();
    }
  }

  async probe(input: DesktopProfileInput): Promise<DesktopConnectionResult> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (!input.id) throw new Error('Desktop profile id is required');
    const origin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!origin || origin !== input.apiBaseUrl) throw new Error('Invalid desktop API URL');
    const probeTicket = ++this.#latestProbeTicket;
    this.#pendingActivation = null;
    const operationGeneration = this.#generation(input.id);
    const operationSelection = this.#selectionGeneration;
    const discoveryClient = this.#client(origin);
    let discovery;
    try {
      discovery = await discoveryClient.discoverDesktop(8_000, operation.signal);
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

    const initial = await this.#profiles.readProfileCredential(input.id);
    if (this.#generation(input.id) !== operationGeneration
      || this.#selectionGeneration !== operationSelection
      || this.#latestProbeTicket !== probeTicket) {
      return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
    }
    if (initial.profile?.apiBaseUrl !== origin) {
      return {
        status: 'authentication-required',
        message: discovery.desktopAuthentication.browserPairing
          ? 'Approve this desktop in your browser to continue.'
          : 'This instance does not support secure desktop pairing.',
        version: discovery.version,
        authentication,
      };
    }
    const credential = initial.credential;
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
    if (credential.origin !== origin) {
      const removed = await this.#profiles.removeCredentialIfCurrent(
        credential,
        origin,
        () => this.#generation(input.id!) === operationGeneration
          && this.#selectionGeneration === operationSelection
          && this.#latestProbeTicket === probeTicket,
      );
      if (!removed) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      this.#clearActiveIfCredential(credential);
      this.#schedulePendingRevocationRetry();
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
      response = await this.#authenticatedFetch(
        credential, '/api/auth/user', { cache: 'no-store', signal: operation.signal }, 8_000,
      );
    } catch {
      return { status: 'offline', message: 'The instance was discovered but authentication could not be checked.' };
    }
    if (response.ok) {
      const current = await this.#profiles.readProfileCredential(input.id);
      if (this.#generation(input.id) !== operationGeneration
        || this.#selectionGeneration !== operationSelection
        || this.#latestProbeTicket !== probeTicket
        || current.profile?.apiBaseUrl !== origin
        || current.credential?.origin !== origin) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      if (!current.credential
        || current.credential.version !== credential.version
        || current.credential.profileId !== credential.profileId
        || current.credential.origin !== credential.origin
        || current.credential.token !== credential.token) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      const activationTicket = randomBytes(32).toString('base64url');
      this.#pendingActivation = {
        ticket: activationTicket,
        probeTicket,
        profileId: input.id,
        origin,
        profileGeneration: operationGeneration,
        selectionGeneration: operationSelection,
        activeProfileId: current.activeProfileId,
        credential: { ...credential },
        identityEpoch: current.identityEpoch!,
      };
      return { status: 'ready', version: discovery.version, authentication, activationTicket };
    }

    const code = await parseCode(response);
    if (code && DEFINITIVE_INVALID_CODES.has(code)) {
      const removed = await this.#profiles.removeCredentialIfCurrent(
        credential,
        origin,
        () => this.#generation(input.id!) === operationGeneration
          && this.#selectionGeneration === operationSelection
          && this.#latestProbeTicket === probeTicket,
      );
      if (!removed) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      this.#clearActiveIfCredential(credential);
      this.#schedulePendingRevocationRetry();
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
    } finally {
      operation.done();
    }
  }

  async activate(activationTicket: unknown): Promise<DesktopActivatedConnection> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (typeof activationTicket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(activationTicket)) {
      throw new Error('Invalid desktop activation ticket');
    }
    const pending = this.#pendingActivation;
    // Consume before awaiting so concurrent calls and replays can never share a
    // credential-bearing activation decision.
    this.#pendingActivation = null;
    if (!pending || pending.ticket !== activationTicket || !this.#pendingIsCurrent(pending)) {
      throw new Error('Desktop activation expired. Check the connection again.');
    }

    const activated = await this.#profiles.activateProfile(
      pending.credential,
      pending.identityEpoch,
      pending.origin,
      pending.activeProfileId,
      () => this.#pendingIsCurrent(pending),
    );
    if (activated !== pending.identityEpoch || !this.#pendingIsCurrent(pending)) {
      this.#active = null;
      throw new Error('Desktop activation expired. Check the connection again.');
    }

    const transportScope = randomBytes(16).toString('base64url');
    this.#selectionGeneration += 1;
    for (const controller of this.#pairingControllers.values()) controller.abort();
    this.#pairingControllers.clear();
    this.#active = {
      ...pending.credential,
      identityEpoch: pending.identityEpoch,
      profileGeneration: pending.profileGeneration,
      selectionGeneration: this.#selectionGeneration,
      transportScope,
    };
    return {
      status: 'ready',
      profileId: pending.profileId,
      transportScope,
      identityEpoch: pending.identityEpoch,
    };
    } finally {
      operation.done();
    }
  }

  async invalidate(value: DesktopAccessInvalidation): Promise<{ invalidated: boolean }> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (!DEFINITIVE_INVALID_CODES.has(value.code)) return { invalidated: false };
    const active = this.#active;
    if (!active || active.profileId !== value.profileId
      || active.transportScope !== value.transportScope
      || this.#generation(active.profileId) !== active.profileGeneration
      || this.#selectionGeneration !== active.selectionGeneration) return { invalidated: false };
    this.#active = null;
    const invalidationGeneration = this.#bumpGeneration(active.profileId);
    const removed = await this.#profiles.removeCredentialIfCurrent(
      active,
      active.origin,
      () => this.#generation(active.profileId) === invalidationGeneration,
    );
    if (removed) this.#schedulePendingRevocationRetry();
    return { invalidated: removed };
    } finally {
      operation.done();
    }
  }

  async discardActivation(value: DesktopConnectionScope): Promise<{ discarded: boolean }> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    const active = this.#active;
    if (!active || typeof value?.profileId !== 'string' || typeof value?.transportScope !== 'string'
      || active.profileId !== value.profileId || active.transportScope !== value.transportScope
      || this.#generation(active.profileId) !== active.profileGeneration
      || this.#selectionGeneration !== active.selectionGeneration) return { discarded: false };
    this.#active = null;
    this.#selectionGeneration += 1;
    this.#latestProbeTicket += 1;
    this.#pendingActivation = null;
    await this.#profiles.setActive(null);
    return { discarded: true };
    } finally {
      operation.done();
    }
  }

  prepareRequest(
    url: string,
    originalHeaders: RequestHeaders,
    details: { method?: string; resourceType?: string } = {},
  ): DesktopRequestDecision {
    if (this.#closed) return { cancel: true };
    const headers = { ...originalHeaders };
    if (/^(?:https?|wss?):/i.test(url)) {
      const httpUrl = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
      if (!canonicalProprHttpUrlOrigin(httpUrl)) return { cancel: true };
    }
    const internalHeader = headerName(headers, 'x-propr-desktop-main-request');
    const trustedMainRequest = internalHeader !== undefined
      && headers[internalHeader] === this.#internalRequestKey;
    if (internalHeader) delete headers[internalHeader];

    const scopeValues = headerValues(headers, DESKTOP_TRANSPORT_SCOPE_HEADER);
    removeHeader(headers, DESKTOP_TRANSPORT_SCOPE_HEADER);

    // The packaged renderer has no cookie identity on any remote HTTP(S) or
    // WS(S) origin. It also cannot supply its own bearer. Main-process bearer
    // requests are distinguished by the per-process secret marker above.
    removeHeader(headers, 'cookie');
    if (!trustedMainRequest) removeHeader(headers, 'authorization');

    const target = requestOrigin(url);
    if (target && target.url.protocol === 'http:' && !normalizeApiBaseUrl(target.origin)) {
      return { cancel: true };
    }
    if (trustedMainRequest) return { requestHeaders: headers };

    const markedRestRequest = scopeValues.length > 0;
    if (markedRestRequest && (scopeValues.length !== 1 || !TRANSPORT_SCOPE_PATTERN.test(scopeValues[0]))) {
      return { cancel: true };
    }
    if (!trustedMainRequest && target
      && (target.pathname.startsWith('/api/desktop/pairings')
        || target.pathname.startsWith('/api/desktop/tokens'))) return { cancel: true };

    const active = this.#active;
    const activeIsCurrent = active !== null
      && this.#generation(active.profileId) === active.profileGeneration
      && this.#selectionGeneration === active.selectionGeneration;
    const isApiRequest = target?.pathname.startsWith('/api/') === true;
    const isSocketUpgrade = target?.pathname === '/socket.io/'
      && target.url.searchParams.get('transport') === 'websocket'
      && (details.resourceType === 'webSocket'
        || headerValues(originalHeaders, 'upgrade').some(value => value.toLowerCase() === 'websocket'));

    if (isSocketUpgrade && target) {
      const queryScopes = target.url.searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
      if (queryScopes.length !== 1 || !TRANSPORT_SCOPE_PATTERN.test(queryScopes[0])
        || !activeIsCurrent || target.origin !== active.origin
        || queryScopes[0] !== active.transportScope) return { cancel: true };
      headers.Authorization = `Bearer ${active.token}`;
      return { requestHeaders: headers };
    }

    if (!markedRestRequest) return { requestHeaders: headers };
    if (!target || !isApiRequest || !activeIsCurrent || target.origin !== active.origin
      || scopeValues[0] !== active.transportScope) return { cancel: true };
    if (details.method?.toUpperCase() === 'OPTIONS') return { requestHeaders: headers };
    headers.Authorization = `Bearer ${active.token}`;
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
      pairingProtocol: this.#pairingProtocol,
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

  #schedulePendingRevocationRetry(includeDeferred = false): void {
    this.#requestPendingRevocationRetry(includeDeferred);
  }

  #requestPendingRevocationRetry(
    includeDeferred = false,
  ): Promise<CredentialServiceInitialization> {
    if (this.#closed) return Promise.resolve({ status: 'degraded', retryPending: true });
    this.#retryRequested = true;
    this.#retryIncludeDeferred ||= includeDeferred;
    if (this.#revocationWorker) return this.#revocationWorker;
    const worker = this.#runPendingRevocationWorker();
    this.#revocationWorker = worker;
    this.#backgroundTasks.add(worker);
    const settled = (): void => {
      this.#backgroundTasks.delete(worker);
      if (this.#revocationWorker === worker) this.#revocationWorker = null;
    };
    worker.then(settled, settled);
    return worker;
  }

  async #runPendingRevocationWorker(): Promise<CredentialServiceInitialization> {
    const aggregate = linkedAbortController([this.#lifecycleController.signal]);
    const aggregateTimer = setTimeout(
      () => aggregate.controller.abort(new Error('Desktop revocation aggregate deadline exceeded')),
      this.#revocationDeadlines.aggregateMs,
    );
    const attemptedGenerations = new Set<string>();
    let retryPending = false;
    try {
      while (this.#retryRequested && !this.#closed && !aggregate.controller.signal.aborted) {
        this.#retryRequested = false;
        const includeDeferred = this.#retryIncludeDeferred;
        this.#retryIncludeDeferred = false;
        let pending: PendingCredentialRevocation[];
        try {
          pending = await this.#profiles.pendingRevocations(includeDeferred);
        } catch {
          retryPending = true;
          this.#reportFixedRevocationFailure({ code: 'local-cleanup' });
          continue;
        }
        for (const entry of pending) {
          if (attemptedGenerations.has(entry.credentialGeneration)) continue;
          if (this.#closed || aggregate.controller.signal.aborted) {
            retryPending = true;
            this.#reportFixedRevocationFailure({ code: 'network' });
            break;
          }
          attemptedGenerations.add(entry.credentialGeneration);
          const result = await this.#retryPendingRevocation(entry, aggregate.controller.signal);
          if (result === 'complete') continue;
          retryPending = true;
          if (result === 'network') {
            this.#reportFixedRevocationFailure({ code: 'network' });
          } else if (typeof result === 'object') {
            this.#reportFixedRevocationFailure({ code: 'http', status: result.status });
          } else {
            this.#reportFixedRevocationFailure({ code: 'local-cleanup' });
          }
        }
      }
      if (aggregate.controller.signal.aborted || this.#closed) retryPending = true;
      return { status: retryPending ? 'degraded' : 'ready', retryPending };
    } finally {
      clearTimeout(aggregateTimer);
      aggregate.dispose();
    }
  }

  async #retryPendingRevocation(
    entry: PendingCredentialRevocation,
    aggregateSignal: AbortSignal,
  ): Promise<'complete' | 'network' | 'local-cleanup' | { status: number; type: 'http' }> {
    const record = linkedAbortController([
      this.#lifecycleController.signal,
      aggregateSignal,
    ]);
    const recordTimer = setTimeout(
      () => record.controller.abort(new Error('Desktop revocation record deadline exceeded')),
      this.#revocationDeadlines.recordMs,
    );
    try {
      const headers = new Headers({
        Authorization: `Bearer ${entry.credential.token}`,
        [DESKTOP_REVOCATION_BINDING_HEADER]: entry.credentialGeneration,
      });
      let response: Response;
      const headerTimer = setTimeout(
        () => record.controller.abort(new Error('Desktop revocation header deadline exceeded')),
        this.#revocationDeadlines.headerMs,
      );
      try {
        response = await this.#mainFetch(
          `${entry.credential.origin}${DESKTOP_TOKEN_REVOCATION_ENDPOINT}`,
          {
            method: 'DELETE',
            headers,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'manual',
            signal: record.controller.signal,
          },
        );
      } catch {
        return 'network';
      } finally {
        clearTimeout(headerTimer);
      }
      if (!await isEndpointBoundTerminalRevocation(
        response,
        entry.credential,
        entry.credentialGeneration,
        record.controller.signal,
        () => record.controller.abort(new Error('Desktop revocation response rejected')),
        this.#revocationDeadlines.bodyMs,
      )) {
        return { type: 'http', status: response.status };
      }
      record.controller.abort();
      try {
        const completed = await this.#profiles.completePendingRevocation(
          entry.id, entry.credential, entry.credentialGeneration,
        );
        return completed ? 'complete' : 'local-cleanup';
      } catch {
        return 'local-cleanup';
      }
    } finally {
      record.controller.abort();
      clearTimeout(recordTimer);
      record.dispose();
    }
  }

  async #awaitIdle(): Promise<void> {
    while (this.#backgroundTasks.size > 0 || this.#operationTasks.size > 0) {
      await Promise.allSettled([...this.#backgroundTasks, ...this.#operationTasks]);
    }
  }

  #reportFixedRevocationFailure(diagnostic: {
    code: 'network' | 'http' | 'local-cleanup';
    status?: number;
  }): void {
    try {
      this.#reportRevocationFailure(diagnostic);
    } catch {
      // Diagnostics must never alter durable retry state or task settlement.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Desktop credential service is closed');
  }

  #beginOperation(): { signal: AbortSignal; done: () => void } {
    this.#assertOpen();
    const linked = linkedAbortController([this.#lifecycleController.signal]);
    const controller = linked.controller;
    let settle!: () => void;
    const task = new Promise<void>(resolve => { settle = resolve; });
    this.#operationTasks.add(task);
    this.#operationControllers.add(controller);
    let finished = false;
    return {
      signal: controller.signal,
      done: () => {
        if (finished) return;
        finished = true;
        linked.dispose();
        this.#operationControllers.delete(controller);
        this.#operationTasks.delete(task);
        settle();
      },
    };
  }

  #beginPairPublish(
    profileId: string,
    profileGeneration: number,
    selectionGeneration: number,
    signal: AbortSignal,
  ): (() => void) | null {
    if (this.#publishingPair || signal.aborted
      || this.#generation(profileId) !== profileGeneration
      || this.#selectionGeneration !== selectionGeneration) return null;
    this.#publishingPair = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#publishingPair = false;
      const waiters = this.#publishWaiters.splice(0);
      waiters.forEach(waiter => waiter());
    };
  }

  #waitForPairPublish(): Promise<void> {
    if (!this.#publishingPair) return Promise.resolve();
    return new Promise(resolve => this.#publishWaiters.push(resolve));
  }

  #generation(profileId: string): number {
    return this.#profileGenerations.get(profileId) ?? 0;
  }

  #pendingIsCurrent(pending: PendingActivation): boolean {
    return this.#latestProbeTicket === pending.probeTicket
      && this.#generation(pending.profileId) === pending.profileGeneration
      && this.#selectionGeneration === pending.selectionGeneration;
  }

  #clearActiveIfCredential(credential: StoredCredential): void {
    if (this.#active?.profileId === credential.profileId
      && this.#active.origin === credential.origin
      && this.#active.token === credential.token) this.#active = null;
  }

  #bumpGeneration(profileId: string): number {
    const generation = this.#generation(profileId) + 1;
    this.#profileGenerations.set(profileId, generation);
    return generation;
  }

  #invalidateProfileOperations(profileId: string): void {
    this.#bumpGeneration(profileId);
    if (this.#pendingActivation?.profileId === profileId) this.#pendingActivation = null;
    if (this.#active?.profileId === profileId) this.#active = null;
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

}
