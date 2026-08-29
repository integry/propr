import {
  evaluateProprApiCompatibility,
  type ProprApiCompatibilityResult,
  type ProprCompatibilityMetadata,
} from '@propr/shared';
import {
  apiUrl,
  normalizeApiBaseUrl,
  type NormalizeApiBaseUrlOptions,
  type ProprApiBaseUrl,
} from './baseUrl.js';
import { ProprClientError } from './errors.js';
import {
  buildSocketConnection,
  connectProprSocket,
  type ProprAuthentication,
  type ProprSocketOptions,
  type Socket,
} from './socket.js';

export interface ProprClientOptions extends NormalizeApiBaseUrlOptions {
  baseUrl?: string | null;
  authentication?: ProprAuthentication;
  defaultTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
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

  constructor(options: ProprClientOptions = {}) {
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl, options);
    this.authentication = options.authentication ?? { type: 'session' };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
    assertTimeout(this.defaultTimeoutMs);
    this.fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
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
    return { ...init, headers };
  }
}
