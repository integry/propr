import { lookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Logger } from 'pino';

export const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const DEFAULT_REMOTE_IMAGE_MAX_REDIRECTS = 3;
const MAX_DNS_RESULTS = 16;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

const blockedIpv4Addresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4Addresses.addSubnet(address, prefix, 'ipv4');
}
const blockedIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6Addresses.addSubnet(address, prefix, 'ipv6');
}

export interface ResolvedRemoteAddress {
  address: string;
  family: 4 | 6;
}

interface RemoteImageHopResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface RemoteImageFetchDependencies {
  resolve: (hostname: string) => Promise<ResolvedRemoteAddress[]>;
  request: (
    url: URL,
    address: ResolvedRemoteAddress,
    headers: Record<string, string>,
    limits: { maxBytes: number; timeoutMs: number },
  ) => Promise<RemoteImageHopResponse>;
}

export interface RemoteImageFetchOptions {
  authToken?: string;
  logger?: Logger;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isPublicRemoteAddress(address: string, family = isIP(address)): boolean {
  if (family !== 4 && family !== 6) return false;
  if (family === 4) return !blockedIpv4Addresses.check(address, 'ipv4');
  const firstWord = Number.parseInt(address.split(':', 1)[0], 16);
  const isGlobalUnicast = Number.isFinite(firstWord) && (firstWord & 0xe000) === 0x2000;
  return isGlobalUnicast && !blockedIpv6Addresses.check(address, 'ipv6');
}

export function isGitHubAssetHost(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  return normalized === 'github.com'
    || normalized.endsWith('.github.com')
    || normalized === 'githubusercontent.com'
    || normalized.endsWith('.githubusercontent.com');
}

export function redactRemoteUrl(url: URL): string {
  const redacted = new URL(url);
  redacted.username = '';
  redacted.password = '';
  redacted.search = '';
  redacted.hash = '';
  return redacted.toString();
}

function parseRemoteUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error('Remote image URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote image URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Remote image URL must not include credentials');
  }
  const hostname = normalizedHostname(url);
  const localHostname = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa');
  if (!hostname || localHostname || hostname.includes('%')) {
    throw new Error('Remote image URL targets a local or invalid host');
  }
  return url;
}

async function defaultResolve(hostname: string): Promise<ResolvedRemoteAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses
    .filter(({ family }) => family === 4 || family === 6)
    .map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

async function resolvePublicAddresses(
  url: URL,
  resolver: RemoteImageFetchDependencies['resolve'],
): Promise<ResolvedRemoteAddress[]> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);
  if (addresses.length === 0 || addresses.length > MAX_DNS_RESULTS) {
    throw new Error('Remote image host did not resolve safely');
  }
  if (addresses.some(({ address, family }) => !isPublicRemoteAddress(address, family))) {
    throw new Error('Remote image host resolves to a private or reserved address');
  }
  return addresses;
}

export async function collectBoundedBody(
  stream: AsyncIterable<Buffer | string>,
  contentLength: string | string[] | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const rawLength = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  if (rawLength) {
    const declaredLength = Number.parseInt(rawLength, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Remote image exceeds the ${maxBytes}-byte limit`);
    }
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Remote image exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function requestOptions(url: URL, address: ResolvedRemoteAddress, headers: Record<string, string>): RequestOptions {
  return {
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    port: url.port || undefined,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: { ...headers, Host: url.host },
  };
}

export async function requestRemoteImageHop(
  url: URL,
  address: ResolvedRemoteAddress,
  headers: Record<string, string>,
  limits: { maxBytes: number; timeoutMs: number },
): Promise<RemoteImageHopResponse> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: RemoteImageHopResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (error) reject(error);
      else resolve(response!);
    };
    const options = requestOptions(url, address, headers);
    const onResponse = (response: http.IncomingMessage): void => {
      const statusCode = response.statusCode ?? 0;
      if (REDIRECT_STATUS_CODES.has(statusCode) || statusCode < 200 || statusCode >= 300) {
        response.destroy();
        finish(null, { statusCode, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      void collectBoundedBody(response, response.headers['content-length'], limits.maxBytes)
        .then(body => finish(null, { statusCode, headers: response.headers, body }))
        .catch(error => {
          response.destroy();
          finish(error as Error);
        });
    };
    const request = url.protocol === 'https:'
      ? https.request({ ...options, servername: normalizedHostname(url) }, onResponse)
      : http.request(options, onResponse);
    const timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`Remote image request timed out after ${limits.timeoutMs}ms`));
    }, limits.timeoutMs);
    request.once('error', error => finish(error));
    request.end();
  });
}

const defaultDependencies: RemoteImageFetchDependencies = {
  resolve: defaultResolve,
  request: requestRemoteImageHop,
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('Remote image request timed out');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Remote image request timed out')), remainingMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function requestHeaders(url: URL, authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/tiff,image/bmp',
    'User-Agent': 'ProPR-Bot/1.0 (https://github.com/integry/propr)',
  };
  if (authToken && isGitHubAssetHost(normalizedHostname(url))) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function validateImageResponse(response: RemoteImageHopResponse): Buffer {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Failed to fetch remote image: HTTP ${response.statusCode}`);
  }
  const rawContentType = response.headers['content-type'];
  const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType)
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!contentType || !ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Remote URL did not return a supported raster image (${contentType || 'missing content type'})`);
  }
  return response.body;
}

export async function fetchRemoteImage(
  initialUrl: string,
  options: RemoteImageFetchOptions = {},
  dependencies: RemoteImageFetchDependencies = defaultDependencies,
): Promise<Buffer> {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_REMOTE_IMAGE_MAX_BYTES);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_REMOTE_IMAGE_TIMEOUT_MS);
  const maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_REMOTE_IMAGE_MAX_REDIRECTS);
  const deadline = Date.now() + timeoutMs;
  let url = parseRemoteUrl(initialUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await beforeDeadline(resolvePublicAddresses(url, dependencies.resolve), deadline);
    options.logger?.debug?.({ url: redactRemoteUrl(url), addressCount: addresses.length }, 'Fetching remote image');
    let response: RemoteImageHopResponse | undefined;
    let lastError: Error | undefined;
    for (const address of addresses) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error('Remote image request timed out');
        response = await dependencies.request(
          url,
          address,
          requestHeaders(url, options.authToken),
          { maxBytes, timeoutMs: remainingMs },
        );
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (!response) throw lastError ?? new Error('Remote image request failed');

    if (!REDIRECT_STATUS_CODES.has(response.statusCode)) return validateImageResponse(response);
    if (redirectCount === maxRedirects) throw new Error('Remote image exceeded the redirect limit');
    const rawLocation = response.headers.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    if (!location) throw new Error('Remote image redirect did not include a location');
    url = parseRemoteUrl(new URL(location, url));
  }

  throw new Error('Remote image request failed');
}
