import { readAccountResponse } from './account-response';
import { type DesktopGitHubAccount } from './shared/github-account';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED,
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
  isPublicInstanceIdentity,
} from '@propr/shared';
import {
  type DesktopProfileInput,
  type DesktopConnectionResult,
  type DesktopActivatedConnection,
  type DesktopAccessInvalidation,
  type DesktopConnectionScope,
  type DesktopPairingFailureCode as ContractDesktopPairingFailureCode,
  type DesktopPairingProgress as ContractDesktopPairingProgress,
  type DesktopPairingApprovalActionResult,
  isDesktopPairingOperationId,
} from './shared/contract';
import { normalizeApiBaseUrl } from './security';
import type { PendingCredentialRevocation, ProfileStore, StoredCredential } from './profile-store';
import type { DesktopConnectIdentityClaimSnapshot } from './connect-discovery';
import { isDesktopPairingBrowserOpenError } from './pairing-browser';

const DEFINITIVE_INVALID_CODES = new Set([
  'INVALID_INSTANCE_TOKEN',
  'INSTANCE_TOKEN_EXPIRED',
  'INSTANCE_TOKEN_REVOKED',
]);

export interface DesktopCredentialDecision {
  reason: 'logout' | 'renderer-invalidation' | 'probe-authentication' | 'discovery-validation' | 'instance-identity';
  outcome: 'requested' | 'retained' | 'retired';
}

export interface CredentialServiceDependencies {
  profiles: Pick<ProfileStore,
    'list' | 'saveAndDetachCredential' | 'commitPairedProfile' | 'detachProfile' | 'setActive' | 'activateProfile' | 'security'
    | 'readCredential' | 'readProfileCredential' | 'writeCredential' | 'removeCredential'
    | 'removeCredentialIfCurrent' | 'journalPendingRevocation' | 'releasePendingRevocation'
    | 'pendingRevocations' | 'completePendingRevocation' | 'awaitIdle'>;
  fetch: typeof globalThis.fetch;
  openPairingBrowser(request: DesktopPairingBrowserRequest): Promise<void>;
  copyPairingApproval?(request: DesktopPairingBrowserRequest): void | Promise<void>;
  clientName: string;
  /** Trusted host confirmation, never a renderer-provided identity. Missing hosts fail closed. */
  confirmAccount?(account: DesktopGitHubAccount, origin: string, signal: AbortSignal): Promise<boolean>;
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
  /** Fixed decision provenance; never includes identities, URLs, scopes or credentials. */
  reportCredentialDecision?(decision: DesktopCredentialDecision): void;
  /** Fixed, bounded, secret-free evidence for packaged acceptance. */
  reportWebSocketHandshake?(evidence: DesktopWebSocketHandshakeEvidence): void;
  /** Fixed, bounded, secret-free evidence for scoped renderer user validation. */
  reportCurrentUserValidation?(evidence: DesktopCurrentUserProxyEvidence): void;
  /** Secret-free pairing lifecycle evidence and renderer progress. */
  reportPairingProgress?(progress: DesktopPairingProgress): void;
  /** Main-owned Connect evidence; renderer input can never provide this snapshot. */
  snapshotConnectIdentityClaim?(profileId: string, origin: string): DesktopConnectIdentityClaimSnapshot;
}

export type DesktopWebSocketRejectionCategory =
  | 'none' | 'untrusted-http-origin' | 'wrong-path' | 'wrong-transport'
  | 'wrong-resource-type' | 'scope-missing' | 'scope-duplicate'
  | 'scope-malformed' | 'no-active-binding' | 'stale-generation'
  | 'wrong-origin' | 'stale-scope';

export interface DesktopWebSocketHandshakeEvidence {
  schemaVersion: 1;
  path: 'socket-io' | 'other';
  transport: 'websocket' | 'other';
  resource: 'websocket' | 'other';
  scopeQueryPresent: boolean;
  scopeQueryCount: number;
  scopeEqualsActive: boolean;
  activeBindingPresent: boolean;
  profileGenerationCurrent: boolean;
  originEqualsActive: boolean;
  rendererBearerPresent: boolean;
  rendererCookiePresent: boolean;
  outboundBearerPresent: boolean;
  bearerMainInjected: boolean;
  accepted: boolean;
  rejectionCategory: DesktopWebSocketRejectionCategory;
}

export type DesktopCurrentUserProxyRejectionCategory =
  | 'none' | 'scope-missing' | 'scope-duplicate' | 'scope-malformed'
  | 'no-active-binding' | 'stale-generation' | 'wrong-origin' | 'stale-scope';

export interface DesktopCurrentUserProxyEvidence {
  schemaVersion: 2;
  correlation: 'current-scope-user-validation';
  requestObserved: true;
  method: 'get';
  rendererScopeGeneration: number | null;
  scopeGenerationQueryCount: 0 | 1 | 2;
  scopeGenerationQueryValid: boolean;
  scopeHeaderCount: 0 | 1 | 2;
  activeBindingPresent: boolean;
  activeScopeGeneration: number;
  profileGenerationCurrent: boolean;
  scopeEqualsActive: boolean;
  originEqualsActive: boolean;
  rendererBearerPresent: boolean;
  rendererCookiePresent: boolean;
  outboundBearerPresent: boolean;
  bearerMainInjected: boolean;
  accepted: boolean;
  rejectionCategory: DesktopCurrentUserProxyRejectionCategory;
}

export type DesktopActiveWorkFetchResult =
  | { status: 'disconnected' | 'stale' }
  | { status: 'response'; response: Response };

export interface DesktopPairingBrowserRequest {
  apiBaseUrl: string;
  pairingId: string;
  approvalUrl: string;
}

export type DesktopPairingProgress = ContractDesktopPairingProgress;
export type DesktopPairingFailureCode = ContractDesktopPairingFailureCode;

class DesktopPairingFailureError extends Error {
  readonly code: DesktopPairingFailureCode;

  constructor(code: DesktopPairingFailureCode, cause?: unknown) {
    // Preserve the in-process failure for durability tests and local control
    // flow. IPC returns only `code`, and the protected logger never receives
    // this message or the underlying error object.
    super(cause instanceof Error ? cause.message : 'Desktop pairing failed');
    this.name = 'DesktopPairingFailureError';
    this.code = code;
  }
}

export const desktopPairingFailureCode = (error: unknown): DesktopPairingFailureCode | null => {
  if (error instanceof DesktopPairingFailureError) return error.code;
  if (!(error instanceof ProprClientError)) return null;
  if (error.kind === 'aborted') return 'PAIRING_CANCELLED';
  if (error.kind === 'authentication' && error.code === 'PAIRING_EXPIRED') return 'APPROVAL_EXPIRED';
  if (error.kind === 'network' || error.kind === 'timeout') return 'PAIRING_UNREACHABLE';
  return 'PAIRING_REJECTED';
};

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
  connectClaim: DesktopConnectIdentityClaimSnapshot;
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
  connectClaim: DesktopConnectIdentityClaimSnapshot;
}

interface PendingPairingApproval {
  operationId: string;
  profileId: string;
  origin: string;
  request: DesktopPairingBrowserRequest;
  expiresAt: number;
  profileGeneration: number;
  selectionGeneration: number;
  controller: AbortController;
  connectClaim: DesktopConnectIdentityClaimSnapshot;
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

const CURRENT_USER_SCOPE_GENERATION_QUERY = 'proprDesktopScopeGeneration';
const PUBLIC_GITHUB_AVATAR_HOST = 'avatars.githubusercontent.com';

const isPublicGitHubAvatarRequest = (
  target: ReturnType<typeof requestOrigin>,
  resourceType: string | undefined,
): boolean => target !== null
  && target.url.protocol === 'https:'
  && target.url.hostname === PUBLIC_GITHUB_AVATAR_HOST
  && target.url.port === ''
  && resourceType?.toLowerCase() === 'image';

const currentUserScopeGeneration = (url: URL): {
  count: 0 | 1 | 2;
  generation: number | null;
  valid: boolean;
} => {
  const values = url.searchParams.getAll(CURRENT_USER_SCOPE_GENERATION_QUERY);
  const count = Math.min(values.length, 2) as 0 | 1 | 2;
  if (values.length !== 1 || !/^(?:0|[1-9]\d{0,15})$/.test(values[0])) {
    return { count, generation: null, valid: false };
  }
  const generation = Number(values[0]);
  const exact = url.search === `?${CURRENT_USER_SCOPE_GENERATION_QUERY}=${values[0]}`;
  return Number.isSafeInteger(generation) && exact
    ? { count, generation, valid: true }
    : { count, generation: null, valid: false };
};

const parseCode = async (response: Response, signal?: AbortSignal): Promise<string | undefined> => {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]);
  let onAbort = () => {};
  try {
    if (deadline.aborted) return undefined;
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return undefined;
    }
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Credential validation cancelled'));
      deadline.addEventListener('abort', onAbort, { once: true });
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REVOCATION_RESPONSE_BYTES) return undefined;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { code?: unknown } | null;
    return typeof value?.code === 'string' ? value.code : undefined;
  } catch {
    return undefined;
  } finally {
    deadline.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
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
  readonly #copyPairingApproval: (request: DesktopPairingBrowserRequest) => void | Promise<void>;
  readonly #confirmAccount: NonNullable<CredentialServiceDependencies['confirmAccount']>;
  readonly #clientName: string;
  readonly #pairingTiming: Pick<ProprDesktopPairingOptions, 'sleep' | 'now'>;
  readonly #pairingProtocol: PairingProtocolRequestOptions;
  readonly #reportRevocationFailure: NonNullable<CredentialServiceDependencies['reportRevocationFailure']>;
  readonly #reportCredentialDecision: NonNullable<CredentialServiceDependencies['reportCredentialDecision']>;
  readonly #reportWebSocketHandshake: NonNullable<CredentialServiceDependencies['reportWebSocketHandshake']>;
  readonly #reportCurrentUserValidation: NonNullable<CredentialServiceDependencies['reportCurrentUserValidation']>;
  readonly #reportPairingProgress: NonNullable<CredentialServiceDependencies['reportPairingProgress']>;
  readonly #revocationDeadlines: RevocationDeadlines;
  readonly #snapshotConnectIdentityClaim: NonNullable<CredentialServiceDependencies['snapshotConnectIdentityClaim']>;
  readonly #internalRequestKey = randomBytes(32).toString('base64url');
  readonly #lifecycleController = new AbortController();
  readonly #profileGenerations = new Map<string, number>();
  readonly #pairingControllers = new Map<string, AbortController>();
  readonly #pendingPairingApprovals = new Map<string, PendingPairingApproval>();
  #selectionGeneration = 0;
  #latestProbeTicket = 0;
  #pendingActivation: PendingActivation | null = null;
  #active: ActiveCredential | null = null;
  readonly #loggingOutProfiles = new Set<string>();
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
    this.#copyPairingApproval = dependencies.copyPairingApproval ?? (() => {
      throw new Error('Desktop pairing approval clipboard is unavailable');
    });
    this.#confirmAccount = dependencies.confirmAccount ?? (async () => false);
    this.#clientName = dependencies.clientName;
    this.#pairingTiming = dependencies.pairingTiming ?? {};
    this.#pairingProtocol = dependencies.pairingProtocol ?? {};
    this.#reportRevocationFailure = dependencies.reportRevocationFailure ?? (() => undefined);
    this.#reportCredentialDecision = dependencies.reportCredentialDecision ?? (() => undefined);
    this.#reportWebSocketHandshake = dependencies.reportWebSocketHandshake ?? (() => undefined);
    this.#reportCurrentUserValidation = dependencies.reportCurrentUserValidation ?? (() => undefined);
    this.#reportPairingProgress = dependencies.reportPairingProgress ?? (() => undefined);
    this.#revocationDeadlines = boundedRevocationDeadlines(dependencies.revocationDeadlines);
    this.#snapshotConnectIdentityClaim = dependencies.snapshotConnectIdentityClaim ?? (() => ({
      status: 'unclaimed',
      isCurrent: () => true,
      beginCommit: () => () => undefined,
    }));
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

  /** Fixed main-process fetch for the native tray; no URL or credential crosses IPC. */
  async fetchActiveWork(signal: AbortSignal): Promise<DesktopActiveWorkFetchResult> {
    const operation = this.#beginOperation();
    try {
      const active = this.#active;
      if (!active
        || this.#generation(active.profileId) !== active.profileGeneration
        || this.#selectionGeneration !== active.selectionGeneration
        || !active.connectClaim.isCurrent()) return { status: 'disconnected' };

      const response = await this.#authenticatedFetch(
        active,
        // Older servers ignore this query and return their strict v2 shape;
        // current servers use it as the explicit opt-in for executing goals.
        '/api/desktop/active-work?schemaVersion=3',
        { cache: 'no-store', signal },
        8_000,
      );
      if (this.#active !== active
        || this.#generation(active.profileId) !== active.profileGeneration
        || this.#selectionGeneration !== active.selectionGeneration
        || !active.connectClaim.isCurrent()) return { status: 'stale' };
      return { status: 'response', response };
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
    this.#pendingPairingApprovals.clear();
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
    this.#pendingPairingApprovals.clear();
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

  async reopenPairingApproval(
    profileId: string,
    operationId: string,
  ): Promise<DesktopPairingApprovalActionResult> {
    return this.#usePendingPairingApproval(profileId, operationId, async request => {
      await this.#openPairingBrowser(request);
    });
  }

  async copyPendingPairingApproval(
    profileId: string,
    operationId: string,
  ): Promise<DesktopPairingApprovalActionResult> {
    return this.#usePendingPairingApproval(profileId, operationId, async request => {
      await this.#copyPairingApproval(request);
    });
  }

  #cancelPairingNow(profileId: string): void {
    if (this.#loggingOutProfiles.has(profileId)) throw new Error('Desktop logout is in progress');
    const generation = this.#bumpGeneration(profileId);
    // Cancelling an in-progress edit must not disable the still-committed
    // credential for an active profile.
    if (this.#active?.profileId === profileId) this.#active.profileGeneration = generation;
    this.#pairingControllers.get(profileId)?.abort();
    this.#pairingControllers.delete(profileId);
    this.#pendingPairingApprovals.delete(profileId);
  }

  async pair(input: DesktopProfileInput, operationId: string = randomUUID()): Promise<{ paired: true }> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (!input.id) throw new Error('Desktop profile id is required');
    if (this.#loggingOutProfiles.has(input.id)) throw new Error('Desktop logout is in progress');
    if (!isDesktopPairingOperationId(operationId)) {
      throw new Error('Invalid desktop pairing operation');
    }
    if (!this.#profiles.security().available) {
      throw new DesktopPairingFailureError('SECURE_STORAGE_FAILED');
    }
    const origin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!origin) throw new Error('Invalid desktop API URL');
    const label = input.label?.trim();
    if (!label || label.length > 80) throw new Error('Profile label must contain 1 to 80 characters');
    const proposed = { ...input, id: input.id, label, apiBaseUrl: origin };
    const connectClaim = this.#snapshotConnectIdentityClaim(proposed.id, proposed.apiBaseUrl);
    if (connectClaim.status === 'origin-mismatch' || connectClaim.status === 'pending') {
      throw new Error('The ProPR Connect origin changed. Use the currently discovered instance.');
    }
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
      const discovery = await client.discoverDesktop(8_000, controller.signal);
      if (!discovery.compatibility.compatible
        || !discovery.desktopAuthentication.browserPairing
        || !discovery.desktopAuthentication.instanceBearerTokens
        || !discovery.desktopAuthentication.socketIoBearerAuthentication
        || (connectClaim.status === 'claimed'
          && connectClaim.publicInstanceIdentity !== discovery.publicInstanceIdentity)) {
        throw new Error('The ProPR instance identity or desktop protocol changed. Approve the new instance again.');
      }
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      const completed = await client.pairDesktop(this.#clientName, {
        ...this.#pairingTiming,
        binding: {
          instanceId: proposed.id,
          origin: proposed.apiBaseUrl,
          scope: 'desktop-instance',
          credentialGeneration,
        },
        signal: controller.signal,
        onApprovalRequired: async (approvalUrl, expiresAt, pairingId) => {
          this.#assertPairingCurrent(
            proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
          );
          const pendingApproval: PendingPairingApproval = {
            operationId,
            profileId: proposed.id,
            origin: proposed.apiBaseUrl,
            request: { apiBaseUrl: proposed.apiBaseUrl, pairingId, approvalUrl },
            expiresAt: Date.parse(expiresAt),
            profileGeneration,
            selectionGeneration,
            controller,
            connectClaim,
          };
          this.#pendingPairingApprovals.set(proposed.id, pendingApproval);
          this.#reportFixedPairingProgress({ operationId, profileId: proposed.id, stage: 'browser-opening' });
          try {
            await this.#openPairingBrowser(pendingApproval.request);
            this.#reportFixedPairingProgress({ operationId, profileId: proposed.id, stage: 'approval-pending' });
          } catch (error) {
            if (!isDesktopPairingBrowserOpenError(error)) throw error;
            // Linux desktop portals can reject xdg-open after the selected
            // browser has already started. Keep the server-owned pairing
            // deadline and poll alive; an approval that actually arrived must
            // win over this ambiguous OS launch acknowledgement.
            this.#reportFixedPairingProgress({ operationId, profileId: proposed.id, stage: 'browser-open-failed' });
          }
        },
      });
      provisional = completed;
      transient = {
        version: 2,
        profileId: proposed.id,
        origin: proposed.apiBaseUrl,
        publicInstanceIdentity: discovery.publicInstanceIdentity,
        token: completed.token,
      };
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      let journaled: Awaited<ReturnType<CredentialServiceDependencies['profiles']['journalPendingRevocation']>>;
      try {
        journaled = await this.#profiles.journalPendingRevocation(transient, credentialGeneration);
      } catch (error) {
        throw new DesktopPairingFailureError('SECURE_STORAGE_FAILED', error);
      }
      if ('stored' in journaled) {
        throw new DesktopPairingFailureError('SECURE_STORAGE_FAILED');
      }
      transientRevocation = journaled;
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      let activationError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          this.#assertPairingCurrent(
            proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
          );
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
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      const userResponse = await this.#authenticatedFetch(
        transient, '/api/auth/user?desktop_account_confirmation=1', { cache: 'no-store', signal: controller.signal }, 8_000,
      );
      const account = await readAccountResponse(userResponse, controller.signal);
      if (!account) throw new DesktopPairingFailureError('PAIRING_REJECTED');
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      // Reauthorization must never replace a saved account with the browser's other user.
      if (baseline.profile?.account && baseline.profile.account.id !== account.id) {
        throw new DesktopPairingFailureError('ACCOUNT_MISMATCH');
      }
      if (!await this.#confirmAccount(account, proposed.apiBaseUrl, controller.signal)) {
        throw new DesktopPairingFailureError('PAIRING_CANCELLED');
      }
      this.#assertPairingCurrent(
        proposed.id, proposed.apiBaseUrl, profileGeneration, selectionGeneration, controller.signal, connectClaim,
      );
      let committed: Awaited<ReturnType<CredentialServiceDependencies['profiles']['commitPairedProfile']>>;
      try {
        committed = await this.#profiles.commitPairedProfile(
          proposed,
          transient,
          baseline,
          () => !controller.signal.aborted
            && this.#generation(proposed.id) === profileGeneration
            && this.#selectionGeneration === selectionGeneration
            && connectClaim.isCurrent(),
          () => this.#beginPairPublish(
            proposed.id, profileGeneration, selectionGeneration, controller.signal, connectClaim,
          ),
          () => {
            publicationStarted = true;
            if (this.#active?.profileId === proposed.id) this.#active = null;
          },
          transientRevocation.id,
          account,
        );
      } catch (error) {
        throw new DesktopPairingFailureError('SECURE_STORAGE_FAILED', error);
      }
      if (committed && 'stored' in committed) {
        throw new DesktopPairingFailureError('SECURE_STORAGE_FAILED');
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
        throw new DesktopPairingFailureError(
          'PAIRING_CANCELLED',
          new Error('Desktop pairing was cancelled.'),
        );
      }
      throw error;
    } finally {
      if (this.#pairingControllers.get(proposed.id) === controller) this.#pairingControllers.delete(proposed.id);
      const pendingApproval = this.#pendingPairingApprovals.get(proposed.id);
      if (pendingApproval?.controller === controller) this.#pendingPairingApprovals.delete(proposed.id);
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
    if (this.#loggingOutProfiles.has(input.id)) throw new Error('Desktop logout is in progress');
    const origin = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
    if (!origin || origin !== input.apiBaseUrl) throw new Error('Invalid desktop API URL');
    const connectClaim = this.#snapshotConnectIdentityClaim(input.id, origin);
    if (connectClaim.status === 'origin-mismatch' || connectClaim.status === 'pending') {
      return {
        status: 'authentication-required',
        message: 'The ProPR Connect instance changed. Use the currently discovered instance and approve it again.',
      };
    }
    const probeTicket = ++this.#latestProbeTicket;
    this.#pendingActivation = null;
    const operationGeneration = this.#generation(input.id);
    const operationSelection = this.#selectionGeneration;
    const discoveryClient = this.#client(origin);
    let discovery;
    try {
      discovery = await discoveryClient.discoverDesktop(8_000, operation.signal);
    } catch (error) {
      // Only the client's typed signal for the exact credential-free public
      // discovery request is actionable here. Generic HTTP 401s, malformed
      // identity, redirects, and authenticated operation failures stay strict.
      if (error instanceof ProprClientError
        && error.kind === 'invalid_response'
        && error.code === DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED) {
        return {
          status: 'incompatible',
          message: 'This instance requires authentication for public desktop discovery. Check its proxy configuration or update ProPR, then try again.',
        };
      }
      if (error instanceof ProprClientError && error.kind === 'invalid_response') {
        // An incomplete/proxy response cannot prove an identity change. Refuse
        // this connection attempt without turning a transient failure into logout.
        this.#credentialDecision('discovery-validation', 'retained');
        return {
          status: 'offline',
          message: 'This endpoint returned invalid identity metadata. Check the connection and try again.',
        };
      }
      return {
        status: 'offline',
        message: error instanceof Error
          ? `ProPR could not discover this instance. ${error.message}`
          : 'ProPR could not discover this instance.',
      };
    }
    const authentication = authenticationSummary(discovery.desktopAuthentication);
    if (!connectClaim.isCurrent()) {
      return {
        status: 'authentication-required',
        message: 'The ProPR Connect instance changed. Use the currently discovered instance and approve it again.',
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
    const identityMismatched = initial.profile?.apiBaseUrl === origin
      && initial.credential?.origin === origin
      && (!isPublicInstanceIdentity(initial.credential.publicInstanceIdentity)
        || initial.credential.publicInstanceIdentity !== discovery.publicInstanceIdentity);
    if (identityMismatched) {
      const removed = await this.#detachIdentityFailedCredential(
        initial.credential!,
        operationGeneration,
        operationSelection,
        probeTicket,
      );
      if (!removed) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
    }
    if (!discovery.compatibility.compatible) {
      return { status: 'incompatible', message: discovery.compatibility.message, version: discovery.version };
    }
    if (!discovery.desktopAuthentication.browserPairing
      || !discovery.desktopAuthentication.instanceBearerTokens
      || !discovery.desktopAuthentication.socketIoBearerAuthentication) {
      return {
        status: 'authentication-required',
        message: 'This instance does not support the complete secure desktop authentication protocol.',
        version: discovery.version,
        authentication,
      };
    }
    if (!this.#profiles.security().available) {
      return {
        status: 'authentication-required',
        message: 'OS-backed secure storage is unavailable. Enable your system keychain before pairing.',
        version: discovery.version,
        authentication,
      };
    }

    if (connectClaim.status === 'claimed'
      && connectClaim.publicInstanceIdentity !== discovery.publicInstanceIdentity) {
      return {
        status: 'authentication-required',
        message: 'The ProPR Connect instance changed. Use the currently discovered instance and approve it again.',
        version: discovery.version,
        authentication,
      };
    }
    if (identityMismatched) {
      return {
        status: 'authentication-required',
        message: 'This endpoint now identifies as a different ProPR instance. Approve it again to continue.',
        version: discovery.version,
        authentication,
      };
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
      if (!connectClaim.isCurrent()) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      response = await this.#authenticatedFetch(
        credential, '/api/auth/user', { cache: 'no-store', signal: operation.signal }, 8_000,
      );
    } catch {
      return { status: 'offline', message: 'The instance was discovered but authentication could not be checked.' };
    }
    if (response.ok) {
      if (initial.profile?.account) {
        const account = await readAccountResponse(response, operation.signal);
        if (!account || account.id !== initial.profile.account.id) {
          return { status: 'authentication-required', message: 'The saved GitHub identity could not be verified. Approve this account again.' };
        }
      }
      const current = await this.#profiles.readProfileCredential(input.id);
      if (this.#generation(input.id) !== operationGeneration
        || this.#selectionGeneration !== operationSelection
        || this.#latestProbeTicket !== probeTicket
        || !connectClaim.isCurrent()
        || current.profile?.apiBaseUrl !== origin
        || current.credential?.origin !== origin) {
        return { status: 'offline', message: 'This connection changed while it was being checked. Try again.' };
      }
      if (!current.credential
        || current.credential.version !== credential.version
        || current.credential.profileId !== credential.profileId
        || current.credential.origin !== credential.origin
        || current.credential.publicInstanceIdentity !== credential.publicInstanceIdentity
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
        connectClaim,
      };
      return { status: 'ready', version: discovery.version, authentication, activationTicket };
    }

    const code = await parseCode(response, operation.signal);
    if (response.status === 401 && code && DEFINITIVE_INVALID_CODES.has(code)) {
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
      this.#credentialDecision('probe-authentication', 'retired');
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
      connectClaim: pending.connectClaim,
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

  /** Retire only the renderer's current bearer; retain the saved instance and other credentials. */
  async logout(value: DesktopConnectionScope): Promise<void> {
    const operation = this.#beginOperation();
    this.#credentialDecision('logout', 'requested');
    let active: ActiveCredential | null = null;
    let generation: number | undefined;
    try {
      await this.#waitForPairPublish();
      active = this.#active;
      if (!active || !value || typeof value !== 'object'
        || active.profileId !== value.profileId || active.transportScope !== value.transportScope
        || this.#loggingOutProfiles.has(active.profileId)) {
        throw new Error('Desktop logout scope is no longer active');
      }
      this.#loggingOutProfiles.add(active.profileId);
      // Fence old probes, pairing, REST and socket reconnects before any disk I/O.
      generation = this.#bumpGeneration(active.profileId);
      this.#pendingActivation = null;
      this.#pairingControllers.get(active.profileId)?.abort();
      this.#pairingControllers.delete(active.profileId);
      this.#pendingPairingApprovals.delete(active.profileId);
      const removed = await this.#profiles.removeCredentialIfCurrent(
        active, active.origin, () => this.#generation(active!.profileId) === generation, true,
      );
      if (!removed) throw new Error('Desktop credential changed before logout completed');
      if (this.#active === active) this.#active = null;
      this.#credentialDecision('logout', 'retired');
      // The store atomically detaches the credential into its encrypted retry
      // journal. No network result can make it locally usable after this point.
      this.#schedulePendingRevocationRetry();
    } catch (error) {
      this.#credentialDecision('logout', 'retained');
      // A failed local commit is not logout. Keep the same identity retryable,
      // without restoring it over a concurrent profile change or shutdown.
      if (!this.#closed && active && this.#active === active
        && generation !== undefined && this.#generation(active.profileId) === generation) {
        const retained = await this.#profiles.readCredential(active.profileId).catch(() => null);
        if (retained?.token === active.token && retained.origin === active.origin
          && retained.publicInstanceIdentity === active.publicInstanceIdentity
          && this.#active === active && this.#generation(active.profileId) === generation) {
          active.profileGeneration = generation;
        }
      }
      throw error;
    } finally {
      if (active && generation !== undefined) this.#loggingOutProfiles.delete(active.profileId);
      operation.done();
    }
  }

  async invalidate(value: DesktopAccessInvalidation): Promise<{ invalidated: boolean }> {
    const operation = this.#beginOperation();
    try {
    await this.#waitForPairPublish();
    this.#schedulePendingRevocationRetry();
    if (!value || !DEFINITIVE_INVALID_CODES.has(value.code)) return { invalidated: false };
    const active = this.#active;
    if (!active || active.profileId !== value.profileId
      || active.transportScope !== value.transportScope
      || this.#generation(active.profileId) !== active.profileGeneration
      || this.#selectionGeneration !== active.selectionGeneration) return { invalidated: false };
    this.#credentialDecision('renderer-invalidation', 'requested');
    // Renderer REST/socket errors are hints. Verify with the main-owned bearer
    // at the pinned instance before allowing a hint to retire a saved login.
    const isCurrent = () => this.#active === active && this.isActiveConnectionScope(value);
    try {
      const discovery = await this.#client(active.origin).discoverDesktop(8_000, operation.signal);
      if (!isCurrent() || discovery.publicInstanceIdentity !== active.publicInstanceIdentity
        || !discovery.compatibility.compatible || !discovery.desktopAuthentication.instanceBearerTokens) {
        this.#credentialDecision('renderer-invalidation', 'retained');
        return { invalidated: false };
      }
      const response = await this.#authenticatedFetch(
        active, '/api/auth/user', { cache: 'no-store', signal: operation.signal }, 8_000,
      );
      const code = response.status === 401 && !response.redirected
        ? await parseCode(response, operation.signal) : undefined;
      if (!code || !DEFINITIVE_INVALID_CODES.has(code) || !isCurrent()) {
        void response.body?.cancel().catch(() => undefined);
        this.#credentialDecision('renderer-invalidation', 'retained');
        return { invalidated: false };
      }
    } catch {
      this.#credentialDecision('renderer-invalidation', 'retained');
      return { invalidated: false };
    }
    const removed = await this.#profiles.removeCredentialIfCurrent(
      active,
      active.origin,
      isCurrent,
    );
    if (removed) {
      this.#invalidateProfileOperations(active.profileId);
      this.#schedulePendingRevocationRetry();
    }
    this.#credentialDecision('renderer-invalidation', removed ? 'retired' : 'retained');
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

  /** Whether main still owns the complete binding required by renderer transport and LNA. */
  hasActiveRendererBinding(): boolean {
    const active = this.#active;
    return active !== null
      && this.#generation(active.profileId) === active.profileGeneration
      && this.#selectionGeneration === active.selectionGeneration
      && active.connectClaim.isCurrent();
  }

  /** A secret-free snapshot used to bind delayed native navigation to one connection. */
  activeConnectionScope(): DesktopConnectionScope | null {
    const active = this.#active;
    return this.hasActiveRendererBinding() && active
      ? { profileId: active.profileId, transportScope: active.transportScope }
      : null;
  }

  /** Secret-free scope check for main-process features fed by the authenticated renderer stream. */
  isActiveConnectionScope(value: { profileId: string; transportScope: string }): boolean {
    const active = this.#active;
    return active !== null
      && value.profileId === active.profileId
      && value.transportScope === active.transportScope
      && this.#generation(active.profileId) === active.profileGeneration
      && this.#selectionGeneration === active.selectionGeneration
      && active.connectClaim.isCurrent();
  }

  prepareRequest(
    url: string,
    originalHeaders: RequestHeaders,
    details: { method?: string; rendererOwned?: boolean; resourceType?: string } = {},
    verifiedSocketCredential?: ActiveCredential,
  ): DesktopRequestDecision {
    if (this.#closed) return { cancel: true };
    const headers = { ...originalHeaders };
    const canonicalTarget = !/^(?:https?|wss?):/i.test(url)
      || canonicalProprHttpUrlOrigin(url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')) !== null;
    const internalHeader = headerName(headers, 'x-propr-desktop-main-request');
    const trustedMainRequest = internalHeader !== undefined
      && headers[internalHeader] === this.#internalRequestKey;
    if (internalHeader) delete headers[internalHeader];

    const scopeValues = headerValues(headers, DESKTOP_TRANSPORT_SCOPE_HEADER);
    removeHeader(headers, DESKTOP_TRANSPORT_SCOPE_HEADER);

    const target = requestOrigin(url);
    const rendererAuthorizationPresent = !trustedMainRequest
      && headerValues(originalHeaders, 'authorization').length > 0;
    const rendererCookiePresent = !trustedMainRequest
      && headerValues(originalHeaders, 'cookie').length > 0;
    const path = target?.pathname === '/socket.io/' ? 'socket-io' : 'other';
    const transportValues = target?.url.searchParams.getAll('transport') ?? [];
    const transport = transportValues.length === 1 && transportValues[0] === 'websocket'
      ? 'websocket' : 'other';
    const resource = details.resourceType?.toLowerCase() === 'websocket'
      || headerValues(originalHeaders, 'upgrade').some(value => value.toLowerCase() === 'websocket')
      ? 'websocket' : 'other';
    const socketScopeValues = target?.url.searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY) ?? [];
    const active = this.#active;
    const activeIsCurrent = active !== null
      && this.#generation(active.profileId) === active.profileGeneration
      && this.#selectionGeneration === active.selectionGeneration
      && active.connectClaim.isCurrent();
    const scopeEqualsActive = socketScopeValues.length === 1
      && active !== null && socketScopeValues[0] === active.transportScope;
    const isSocketCandidate = path === 'socket-io' || socketScopeValues.length > 0;
    const isCurrentUserRequest = !trustedMainRequest
      && target?.pathname === '/api/auth/user'
      && (details.method ?? 'GET').toUpperCase() === 'GET';
    const rendererCurrentUserGeneration = target && isCurrentUserRequest
      ? currentUserScopeGeneration(target.url)
      : { count: 0 as const, generation: null, valid: false };
    const reportHandshake = (
      accepted: boolean,
      rejectionCategory: DesktopWebSocketRejectionCategory,
      bearerMainInjected = false,
    ): void => {
      if (!isSocketCandidate || trustedMainRequest) return;
      try {
        this.#reportWebSocketHandshake({
          schemaVersion: 1, path, transport, resource,
          scopeQueryPresent: socketScopeValues.length > 0,
          scopeQueryCount: socketScopeValues.length,
          scopeEqualsActive,
          activeBindingPresent: active !== null,
          profileGenerationCurrent: activeIsCurrent,
          originEqualsActive: target !== null && active !== null && target.origin === active.origin,
          rendererBearerPresent: rendererAuthorizationPresent,
          rendererCookiePresent,
          outboundBearerPresent: headerValues(headers, 'authorization').length > 0,
          bearerMainInjected,
          accepted,
          rejectionCategory,
        });
      } catch {
        // Acceptance diagnostics cannot alter the authorization decision.
      }
    };
    const reportCurrentUser = (
      accepted: boolean,
      rejectionCategory: DesktopCurrentUserProxyRejectionCategory,
      bearerMainInjected = false,
    ): void => {
      if (!isCurrentUserRequest) return;
      try {
        this.#reportCurrentUserValidation({
          schemaVersion: 2,
          correlation: 'current-scope-user-validation',
          requestObserved: true,
          method: 'get',
          rendererScopeGeneration: rendererCurrentUserGeneration.generation,
          scopeGenerationQueryCount: rendererCurrentUserGeneration.count,
          scopeGenerationQueryValid: rendererCurrentUserGeneration.valid,
          scopeHeaderCount: Math.min(scopeValues.length, 2) as 0 | 1 | 2,
          activeBindingPresent: active !== null,
          activeScopeGeneration: active?.profileGeneration ?? 0,
          profileGenerationCurrent: activeIsCurrent,
          scopeEqualsActive: scopeValues.length === 1 && active !== null
            && scopeValues[0] === active.transportScope,
          originEqualsActive: target !== null && active !== null && target.origin === active.origin,
          rendererBearerPresent: rendererAuthorizationPresent,
          rendererCookiePresent,
          outboundBearerPresent: headerValues(headers, 'authorization').length > 0,
          bearerMainInjected,
          accepted,
          rejectionCategory,
        });
      } catch {
        // Acceptance diagnostics cannot alter the authorization decision.
      }
    };

    // The packaged renderer has no cookie identity on any remote HTTP(S) or
    // WS(S) origin. It also cannot supply its own bearer. Main-process bearer
    // requests are distinguished by the per-process secret marker above.
    removeHeader(headers, 'cookie');
    if (!trustedMainRequest) removeHeader(headers, 'authorization');

    if (!canonicalTarget) {
      reportHandshake(false, 'untrusted-http-origin');
      return { cancel: true };
    }
    if (target && target.url.protocol === 'http:' && !normalizeApiBaseUrl(target.origin)) {
      reportHandshake(false, 'untrusted-http-origin');
      return { cancel: true };
    }
    if (trustedMainRequest) return { requestHeaders: headers };

    const markedRestRequest = scopeValues.length > 0;
    if (markedRestRequest && (scopeValues.length !== 1 || !TRANSPORT_SCOPE_PATTERN.test(scopeValues[0]))) {
      reportCurrentUser(false, scopeValues.length !== 1 ? 'scope-duplicate' : 'scope-malformed');
      return { cancel: true };
    }
    if (!trustedMainRequest && target
      && (target.pathname.startsWith('/api/desktop/pairings')
        || target.pathname.startsWith('/api/desktop/tokens'))) return { cancel: true };

    const isApiRequest = target?.pathname.startsWith('/api/') === true;
    const isSocketUpgrade = path === 'socket-io' && transport === 'websocket' && resource === 'websocket';

    // Session security supplies this ownership bit at the actual WebContents
    // boundary. A foreign renderer may load only unmarked credentialless
    // resources; it can never exercise a REST/Socket scope or receive a bearer.
    if (details.rendererOwned === false) {
      if (markedRestRequest || isSocketCandidate) {
        reportHandshake(false, 'stale-generation');
        reportCurrentUser(false, 'stale-generation');
        return { cancel: true };
      }
      return { requestHeaders: headers };
    }

    // Chromium can cache Local Network Access after activation is discarded.
    // The live main renderer must therefore remain pinned to the exact current
    // origin even for sanitized traffic that does not carry a transport scope,
    // apart from this exact credentialless public-image exception.
    const publicGitHubAvatarRequest = !markedRestRequest
      && !isSocketCandidate
      && isPublicGitHubAvatarRequest(target, details.resourceType);
    if (details.rendererOwned === true && target
      && (!activeIsCurrent || target.origin !== active.origin)
      && !publicGitHubAvatarRequest) {
      reportHandshake(false, !active ? 'no-active-binding' : !activeIsCurrent ? 'stale-generation' : 'wrong-origin');
      reportCurrentUser(false, !active ? 'no-active-binding' : !activeIsCurrent ? 'stale-generation' : 'wrong-origin');
      return { cancel: true };
    }

    if (isSocketCandidate && !isSocketUpgrade) {
      reportHandshake(false, path !== 'socket-io'
        ? 'wrong-path' : transport !== 'websocket' ? 'wrong-transport' : 'wrong-resource-type');
      return { cancel: true };
    }

    if (isSocketUpgrade && target) {
      const rejection = socketScopeValues.length === 0 ? 'scope-missing'
        : socketScopeValues.length !== 1 ? 'scope-duplicate'
          : !TRANSPORT_SCOPE_PATTERN.test(socketScopeValues[0]) ? 'scope-malformed'
            : !active ? 'no-active-binding'
              : !activeIsCurrent || active !== verifiedSocketCredential ? 'stale-generation'
                : target.origin !== active.origin ? 'wrong-origin'
                  : socketScopeValues[0] !== active.transportScope ? 'stale-scope' : null;
      if (rejection) {
        reportHandshake(false, rejection);
        return { cancel: true };
      }
      if (!active) return { cancel: true };
      headers.Authorization = `Bearer ${active.token}`;
      reportHandshake(true, 'none', true);
      return { requestHeaders: headers };
    }

    if (!markedRestRequest) return { requestHeaders: headers };
    if (!target || !isApiRequest || !active || !activeIsCurrent || target.origin !== active.origin
      || scopeValues[0] !== active.transportScope) {
      reportCurrentUser(false, !active ? 'no-active-binding'
        : !activeIsCurrent ? 'stale-generation'
          : target?.origin !== active.origin ? 'wrong-origin' : 'stale-scope');
      return { cancel: true };
    }
    if (details.method?.toUpperCase() === 'OPTIONS') return { requestHeaders: headers };
    headers.Authorization = `Bearer ${active.token}`;
    reportCurrentUser(true, 'none', true);
    return { requestHeaders: headers };
  }

  /** Socket reconnects cross a fresh asynchronous identity gate before main attaches a bearer. */
  async prepareRequestAsync(
    url: string,
    originalHeaders: RequestHeaders,
    details: { method?: string; rendererOwned?: boolean; resourceType?: string } = {},
  ): Promise<DesktopRequestDecision> {
    const target = requestOrigin(url);
    const isSocketUpgrade = target?.pathname === '/socket.io/'
      && target.url.searchParams.get('transport') === 'websocket'
      && (details.resourceType === 'webSocket'
        || headerValues(originalHeaders, 'upgrade').some(value => value.toLowerCase() === 'websocket'));
    if (!isSocketUpgrade || details.rendererOwned === false) {
      return this.prepareRequest(url, originalHeaders, details);
    }
    const active = this.#active;
    if (!active || target.origin !== active.origin) return this.prepareRequest(url, originalHeaders, details);
    try {
      const discovery = await this.#client(active.origin).discoverDesktop(8_000, this.#lifecycleController.signal);
      const stillCurrent = this.#active === active
        && this.#generation(active.profileId) === active.profileGeneration
        && this.#selectionGeneration === active.selectionGeneration
        && active.connectClaim.isCurrent();
      if (!stillCurrent) return { cancel: true };
      const supportsRequest = discovery.compatibility.compatible
        && discovery.desktopAuthentication.instanceBearerTokens
        && discovery.desktopAuthentication.socketIoBearerAuthentication;
      if (discovery.publicInstanceIdentity !== active.publicInstanceIdentity) {
        await this.#detachIdentityFailedCredential(
          active,
          active.profileGeneration,
          active.selectionGeneration,
        );
        return { cancel: true };
      }
      if (!supportsRequest) {
        this.#credentialDecision('discovery-validation', 'retained');
        return { cancel: true };
      }
      return this.prepareRequest(url, originalHeaders, details, active);
    } catch (error) {
      if (error instanceof ProprClientError && error.kind === 'invalid_response' && this.#active === active) {
        this.#credentialDecision('discovery-validation', 'retained');
      }
      return { cancel: true };
    }
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
      try {
        const discovery = await this.#client(entry.credential.origin)
          .discoverDesktop(Math.min(8_000, this.#revocationDeadlines.recordMs), record.controller.signal);
        if (discovery.publicInstanceIdentity !== entry.credential.publicInstanceIdentity) return 'network';
      } catch {
        return 'network';
      }
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

  #credentialDecision(reason: DesktopCredentialDecision['reason'], outcome: DesktopCredentialDecision['outcome']): void {
    try { this.#reportCredentialDecision({ reason, outcome }); } catch {
      // Diagnostics cannot change credential decisions.
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

  #reportFixedPairingProgress(progress: DesktopPairingProgress): void {
    try {
      this.#reportPairingProgress(progress);
    } catch {
      // Diagnostics and renderer progress must never alter pairing settlement.
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
    connectClaim: DesktopConnectIdentityClaimSnapshot,
  ): (() => void) | null {
    if (this.#publishingPair || signal.aborted
      || this.#generation(profileId) !== profileGeneration
      || this.#selectionGeneration !== selectionGeneration
      || !connectClaim.isCurrent()) return null;
    const releaseConnectClaim = connectClaim.beginCommit();
    if (!releaseConnectClaim) return null;
    this.#publishingPair = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#publishingPair = false;
      releaseConnectClaim();
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
      && this.#selectionGeneration === pending.selectionGeneration
      && pending.connectClaim.isCurrent();
  }

  #clearActiveIfCredential(credential: StoredCredential): void {
    if (this.#active?.profileId === credential.profileId
      && this.#active.origin === credential.origin
      && this.#active.token === credential.token) this.#active = null;
  }

  async #detachIdentityFailedCredential(
    credential: StoredCredential,
    expectedProfileGeneration: number,
    expectedSelectionGeneration: number,
    expectedProbeTicket?: number,
  ): Promise<boolean> {
    if (this.#generation(credential.profileId) !== expectedProfileGeneration
      || this.#selectionGeneration !== expectedSelectionGeneration
      || (expectedProbeTicket !== undefined && this.#latestProbeTicket !== expectedProbeTicket)) return false;
    this.#invalidateProfileOperations(credential.profileId);
    const invalidationGeneration = this.#generation(credential.profileId);
    const removed = await this.#profiles.removeCredentialIfCurrent(
      credential,
      credential.origin,
      () => this.#generation(credential.profileId) === invalidationGeneration
        && this.#selectionGeneration === expectedSelectionGeneration
        && (expectedProbeTicket === undefined || this.#latestProbeTicket === expectedProbeTicket),
    );
    if (removed) {
      this.#credentialDecision('instance-identity', 'retired');
      this.#schedulePendingRevocationRetry();
    }
    return removed;
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
    this.#pendingPairingApprovals.delete(profileId);
  }

  async #usePendingPairingApproval(
    profileId: string,
    operationId: string,
    action: (request: DesktopPairingBrowserRequest) => void | Promise<void>,
  ): Promise<DesktopPairingApprovalActionResult> {
    const operation = this.#beginOperation();
    try {
      if (!isDesktopPairingOperationId(operationId)) return { status: 'unavailable' };
      const pending = this.#pendingPairingApprovals.get(profileId);
      if (!pending || pending.operationId !== operationId || pending.profileId !== profileId
        || pending.origin !== pending.request.apiBaseUrl
        || !Number.isFinite(pending.expiresAt)
        || (this.#pairingTiming.now?.() ?? Date.now()) >= pending.expiresAt) {
        if (pending?.operationId === operationId) this.#pendingPairingApprovals.delete(profileId);
        return { status: 'unavailable' };
      }
      try {
        this.#assertPairingCurrent(
          pending.profileId,
          pending.origin,
          pending.profileGeneration,
          pending.selectionGeneration,
          pending.controller.signal,
          pending.connectClaim,
        );
      } catch {
        return { status: 'unavailable' };
      }
      try {
        await action(pending.request);
        return { status: 'succeeded' };
      } catch {
        return { status: 'failed' };
      }
    } finally {
      operation.done();
    }
  }

  #assertPairingCurrent(
    profileId: string,
    origin: string,
    profileGeneration: number,
    selectionGeneration: number,
    signal: AbortSignal,
    connectClaim: DesktopConnectIdentityClaimSnapshot,
  ): void {
    if (signal.aborted || this.#generation(profileId) !== profileGeneration
      || this.#selectionGeneration !== selectionGeneration
      || !connectClaim.isCurrent()) {
      throw new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' });
    }
    if (normalizeApiBaseUrl(origin) !== origin) throw new Error('Invalid desktop API URL');
  }

}
