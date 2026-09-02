import {
  evaluateProprApiCompatibility,
  parseProprDesktopDiscoveryJson,
  PROPR_CONNECT_DISCOVERY_MAX_BYTES,
  type ProprApiCompatibilityResult,
  type ProprCompatibilityMetadata,
} from '@propr/shared';
import {
  apiUrl,
  normalizeApiBaseUrl,
  type NormalizeApiBaseUrlOptions,
  type ProprApiBaseUrl,
} from './baseUrl.js';
import { DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED, ProprClientError } from './errors.js';
import {
  buildSocketConnection,
  connectProprSocket,
  type ProprAuthentication,
  type ProprSocketOptions,
  type Socket,
} from './socket.js';
import {
  completeDesktopPairing,
  parseDesktopDiscovery,
  parseDesktopPairingStart,
  parseDesktopPairingActivationReceipt,
  type ProprDesktopDiscovery,
  type ProprDesktopPairingComplete,
  type ProprDesktopPairingActivationReceipt,
  type ProprDesktopPairingOptions,
  type ProprDesktopPairingStart,
} from './desktopPairing.js';
import {
  requestPairingProtocol,
  type PairingProtocolRequestOptions,
} from './pairingProtocol.js';

export interface ProprClientOptions extends NormalizeApiBaseUrlOptions {
  baseUrl?: string | null;
  authentication?: ProprAuthentication;
  defaultTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** @internal Deterministic response-lifecycle proof; production uses fixed protocol defaults. */
  pairingProtocol?: PairingProtocolRequestOptions;
}

export interface ProprFetchOptions {
  /** Zero or omitted uses the client default; a zero client default disables timeouts. */
  timeoutMs?: number;
}

export interface ProprRequestOptions extends ProprFetchOptions {
  responseType?: 'json' | 'text' | 'response';
}

export interface ProprCompatibilityOptions {
  path?: string;
  timeoutMs?: number;
}

const responseErrorBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  try {
    return contentType.includes('json') ? await response.clone().json() : await response.clone().text();
  } catch {
    return undefined;
  }
};

const errorCode = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || !('code' in body)) return undefined;
  return typeof body.code === 'string' ? body.code : undefined;
};

const isCompatibilityMetadata = (value: unknown): value is Partial<ProprCompatibilityMetadata> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return ['version', 'apiCompatibility', 'uiCompatibility'].every(key =>
    metadata[key] === undefined || metadata[key] === null || typeof metadata[key] === 'string'
  );
};

const assertTimeout = (timeoutMs: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new ProprClientError('Request timeouts must be finite, non-negative numbers.', {
      kind: 'configuration',
    });
  }
};

export class ProprClient {
  readonly baseUrl: ProprApiBaseUrl;
  readonly authentication: ProprAuthentication;
  readonly defaultTimeoutMs: number;

  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly pairingProtocolOptions: PairingProtocolRequestOptions;

  constructor(options: ProprClientOptions = {}) {
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl, options);
    this.authentication = options.authentication ?? { type: 'session' };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
    assertTimeout(this.defaultTimeoutMs);
    this.fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.pairingProtocolOptions = options.pairingProtocol ?? {};
  }

  url(path: string): string {
    return apiUrl(this.baseUrl, path);
  }

  async fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    options: ProprFetchOptions = {}
  ): Promise<Response> {
    const target = this.resolveRequestTarget(input);
    const authentication = this.authenticate(init);
    const authenticatedInit = authentication instanceof Promise
      ? await authentication
      : authentication;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    assertTimeout(timeoutMs);

    const controller = timeoutMs > 0 || authenticatedInit?.signal ? new AbortController() : undefined;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => controller?.abort(authenticatedInit?.signal?.reason);

    if (controller && authenticatedInit?.signal) {
      if (authenticatedInit.signal.aborted) onAbort();
      else authenticatedInit.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (controller && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      return await this.fetchImplementation(target, controller
        ? { ...authenticatedInit, signal: controller.signal }
        : authenticatedInit);
    } catch (cause) {
      if (timedOut) {
        throw new ProprClientError('The ProPR API request timed out.', { kind: 'timeout', cause });
      }
      if (authenticatedInit?.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
        throw new ProprClientError('The ProPR API request was cancelled.', { kind: 'aborted', cause });
      }
      if (cause instanceof ProprClientError) throw cause;
      throw new ProprClientError('The ProPR API could not be reached.', { kind: 'network', cause });
    } finally {
      if (timeout) clearTimeout(timeout);
      authenticatedInit?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    options: ProprRequestOptions = {}
  ): Promise<T> {
    const response = await this.fetch(this.url(path), init, options);
    if (!response.ok) {
      const body = await responseErrorBody(response);
      throw new ProprClientError(`The ProPR API request failed with HTTP ${response.status}.`, {
        kind: 'http',
        status: response.status,
        code: errorCode(body),
        body,
      });
    }
    if (options.responseType === 'response') return response as T;
    if (options.responseType === 'text') return await response.text() as T;
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch (cause) {
      throw new ProprClientError('The ProPR API returned an invalid JSON response.', {
        kind: 'invalid_response',
        status: response.status,
        cause,
      });
    }
  }

  async negotiateCompatibility(
    options: ProprCompatibilityOptions = {}
  ): Promise<ProprApiCompatibilityResult> {
    const response = await this.fetch(this.url(options.path ?? '/api/compatibility'), {
      credentials: this.authentication.type === 'session'
        ? (this.authentication.credentials ?? 'include')
        : undefined,
      cache: 'no-store',
    }, { timeoutMs: options.timeoutMs ?? 8000 });

    if (response.status === 404) return evaluateProprApiCompatibility({});
    if (!response.ok) {
      const body = await responseErrorBody(response);
      throw new ProprClientError(`Compatibility negotiation failed with HTTP ${response.status}.`, {
        kind: 'http', status: response.status, code: errorCode(body), body,
      });
    }

    let metadata: unknown;
    try {
      metadata = await response.json();
    } catch (cause) {
      throw new ProprClientError('The ProPR API returned invalid compatibility metadata.', {
        kind: 'invalid_response', status: response.status, cause,
      });
    }
    if (!isCompatibilityMetadata(metadata)) {
      throw new ProprClientError('The ProPR API returned invalid compatibility metadata.', {
        kind: 'invalid_response', status: response.status,
      });
    }
    return evaluateProprApiCompatibility(metadata);
  }

  async requireCompatibility(
    options: ProprCompatibilityOptions = {}
  ): Promise<ProprApiCompatibilityResult & { compatible: true }> {
    const result = await this.negotiateCompatibility(options);
    if (!result.compatible) {
      throw new ProprClientError(result.message, {
        kind: 'compatibility',
        code: result.reason,
        body: result,
      });
    }
    return result;
  }

  async discoverDesktop(timeoutMs = 8000, signal?: AbortSignal): Promise<ProprDesktopDiscovery> {
    const response = await this.fetch(this.url('/api/desktop/discovery'), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal,
    }, { timeoutMs });
    const discoveryContentType = response.headers.get('content-type')
      ?.split(';', 1)[0]?.trim().toLowerCase();
    if (!response.ok || response.redirected || discoveryContentType !== 'application/json') {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best-effort response disposal */ }
      const authenticationGated = response.status === 401
        && !response.redirected
        && discoveryContentType === 'application/json';
      throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
        kind: 'invalid_response',
        status: response.status,
        ...(authenticationGated ? { code: DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED } : {}),
      });
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > PROPR_CONNECT_DISCOVERY_MAX_BYTES)) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best-effort response disposal */ }
      throw new ProprClientError('The ProPR instance returned oversized desktop discovery metadata.', {
        kind: 'invalid_response', status: response.status,
      });
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let rejectDeadline!: (reason: unknown) => void;
    let bodyTimedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const bodyTimer = setTimeout(() => {
      bodyTimedOut = true;
      rejectDeadline(new Error('desktop discovery body timed out'));
    }, Math.max(1, timeoutMs));
    const onAbort = (): void => rejectDeadline(signal?.reason ?? new Error('desktop discovery was cancelled'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (reader) {
        while (true) {
          const part = await Promise.race([reader.read(), deadline]);
          if (part.done) break;
          received += part.value.byteLength;
          if (received > PROPR_CONNECT_DISCOVERY_MAX_BYTES) throw new Error('oversized');
          chunks.push(part.value);
        }
      }
    } catch (cause) {
      try { void reader?.cancel().catch(() => undefined); } catch { /* best-effort body cancellation */ }
      if (bodyTimedOut) throw new ProprClientError('Desktop discovery timed out.', { kind: 'timeout', cause });
      if (signal?.aborted) throw new ProprClientError('Desktop discovery was cancelled.', { kind: 'aborted', cause });
      throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
        kind: 'invalid_response', status: response.status, cause,
      });
    } finally {
      clearTimeout(bodyTimer);
      signal?.removeEventListener('abort', onAbort);
      try { reader?.releaseLock(); } catch { /* hostile streams may retain a pending read */ }
    }
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (declaredLength !== null && (!contentEncoding || contentEncoding === 'identity')
      && Number(declaredLength) !== received) {
      throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
        kind: 'invalid_response', status: response.status,
      });
    }
    const bytes = new Uint8Array(received);
    let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    let contents: string;
    try { contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (cause) {
      throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
        kind: 'invalid_response', status: response.status, cause,
      });
    }
    const metadata = parseProprDesktopDiscoveryJson(contents);
    if (!metadata) {
      throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
        kind: 'invalid_response', status: response.status,
      });
    }
    const compatibility = evaluateProprApiCompatibility(
      metadata,
    );
    return parseDesktopDiscovery(metadata, compatibility);
  }

  async startDesktopPairing(
    clientName: string,
    options: Pick<ProprDesktopPairingOptions, 'signal' | 'now' | 'binding'>,
  ): Promise<ProprDesktopPairingStart> {
    const path = '/api/desktop/pairings';
    const expectedOrigin = this.resolveRequestOrigin(this.url(path));
    return parseDesktopPairingStart(await this.requestDesktopPairing(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName, ...options.binding }),
      redirect: 'manual',
      signal: options.signal,
    }), expectedOrigin, options.now);
  }

  async pairDesktop(
    clientName: string,
    options: ProprDesktopPairingOptions,
  ): Promise<ProprDesktopPairingComplete> {
    const start = await this.startDesktopPairing(clientName, options);
    return completeDesktopPairing(this, start, options);
  }

  async activateDesktopPairing(
    pairing: ProprDesktopPairingComplete,
    signal?: AbortSignal,
  ): Promise<ProprDesktopPairingActivationReceipt> {
    return parseDesktopPairingActivationReceipt(await this.requestDesktopPairing(
      `/api/desktop/pairings/${encodeURIComponent(pairing.pairingId)}/activate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceSecret: pairing.deviceSecret,
          activationTicket: pairing.activationTicket,
          instanceId: pairing.instanceId,
          origin: pairing.origin,
          scope: pairing.scope,
          credentialGeneration: pairing.credentialGeneration,
        }),
        redirect: 'manual',
        signal,
      },
    ));
  }

  async cancelDesktopPairing(
    pairing: ProprDesktopPairingComplete,
    signal?: AbortSignal,
  ): Promise<{ status: 'cancelled'; cancelledAt: string }> {
    const value = await this.requestDesktopPairing(
      `/api/desktop/pairings/${encodeURIComponent(pairing.pairingId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceSecret: pairing.deviceSecret,
          activationTicket: pairing.activationTicket,
          instanceId: pairing.instanceId,
          origin: pairing.origin,
          scope: pairing.scope,
          credentialGeneration: pairing.credentialGeneration,
        }),
        redirect: 'manual',
        signal,
      },
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProprClientError('The ProPR instance returned an invalid pairing cancellation receipt.', {
        kind: 'invalid_response',
      });
    }
    const receipt = value as Record<string, unknown>;
    if (receipt.status !== 'cancelled' || typeof receipt.cancelledAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.cancelledAt))
      || Object.keys(receipt).some(key => !['status', 'cancelledAt'].includes(key))) {
      throw new ProprClientError('The ProPR instance returned an invalid pairing cancellation receipt.', {
        kind: 'invalid_response',
      });
    }
    return receipt as unknown as { status: 'cancelled'; cancelledAt: string };
  }

  /** @internal Pairing keeps transport ownership through the complete body. */
  async requestDesktopPairing(
    path: string,
    init: RequestInit,
    overallTimeoutMs?: number,
    overallTimeoutError?: PairingProtocolRequestOptions['overallTimeoutError'],
  ): Promise<unknown> {
    const target = this.resolveRequestTarget(this.url(path));
    const authentication = this.authenticate(init);
    const authenticatedInit = authentication instanceof Promise
      ? await authentication
      : authentication;
    return requestPairingProtocol(
      this.fetchImplementation,
      target,
      authenticatedInit ?? {},
      {
        ...this.pairingProtocolOptions,
        overallTimeoutMs: overallTimeoutMs ?? this.pairingProtocolOptions.overallTimeoutMs,
        overallTimeoutError: overallTimeoutError
          ?? this.pairingProtocolOptions.overallTimeoutError,
      },
    );
  }

  connectSocket(options: ProprSocketOptions = {}): Socket {
    return connectProprSocket(buildSocketConnection(this.baseUrl, this.authentication, options));
  }

  private resolveRequestTarget(input: RequestInfo | URL): RequestInfo | URL {
    const raw = input instanceof Request ? input.url : input.toString();
    if (raw.startsWith('/')) {
      return apiUrl(this.baseUrl, raw);
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ProprClientError('The ProPR API request URL is invalid.', { kind: 'configuration' });
    }
    if (parsed.username || parsed.password) {
      throw new ProprClientError('ProPR API request URLs must not contain embedded credentials.', {
        kind: 'configuration',
      });
    }
    const browserOrigin = typeof globalThis.location !== 'undefined'
      ? globalThis.location.origin
      : undefined;
    const expectedOrigin = this.baseUrl || browserOrigin;
    if (!expectedOrigin || parsed.origin !== expectedOrigin) {
      throw new ProprClientError('The request URL does not belong to the configured ProPR instance.', {
        kind: 'configuration',
      });
    }
    return input;
  }

  private resolveRequestOrigin(input: RequestInfo | URL): string {
    const raw = input instanceof Request ? input.url : input.toString();
    const browserOrigin = typeof globalThis.location !== 'undefined'
      ? globalThis.location.origin
      : undefined;
    try {
      const origin = new URL(raw, browserOrigin).origin;
      if (origin === 'null') throw new Error();
      return origin;
    } catch {
      throw new ProprClientError('The ProPR instance origin could not be established.', {
        kind: 'configuration',
      });
    }
  }

  private authenticate(init?: RequestInit): RequestInit | undefined | Promise<RequestInit> {
    if (this.authentication.type === 'none') return init;
    if (this.authentication.type === 'session') {
      if (init?.credentials !== undefined || this.authentication.applyByDefault === false) return init;
      return { ...init, credentials: this.authentication.credentials ?? 'include' };
    }
    return this.authenticateBearer(init, this.authentication.getAccessToken);
  }

  private async authenticateBearer(
    init: RequestInit | undefined,
    getAccessToken: () => string | null | undefined | Promise<string | null | undefined>
  ): Promise<RequestInit> {
    let token: string | undefined;
    try {
      token = (await getAccessToken())?.trim();
    } catch (cause) {
      if (cause instanceof ProprClientError) throw cause;
      throw new ProprClientError('ProPR bearer authentication is unavailable.', {
        kind: 'authentication', cause,
      });
    }
    const headers = new Headers(init?.headers);
    headers.delete('Authorization');
    if (token) {
      if (/\r|\n/.test(token)) {
        throw new ProprClientError('The bearer token is invalid.', { kind: 'configuration' });
      }
      headers.set('Authorization', `Bearer ${token}`);
    }
    // Bearer profiles must never accidentally inherit a browser/Electron cookie
    // identity from another named profile on the same origin.
    return { ...init, credentials: 'omit', headers };
  }
}
