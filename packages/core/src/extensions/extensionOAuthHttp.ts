import https from 'node:https';
import { isIP } from 'node:net';
import { EXTENSION_LIMITS } from '@propr/shared';
import { extensionEndpoint, resolveExtensionEndpoint, type ExtensionLookup } from './endpointPolicy.js';

/**
 * Outbound HTTPS for OAuth discovery, registration, token and revocation
 * requests. Every request passes the extension endpoint policy: HTTPS on port
 * 443 without credentials, query or fragment, never a private, loopback,
 * link-local or metadata address, DNS checked and the vetted address pinned for
 * the connection. Responses are bounded in size and time; redirects, cookies
 * and proxies are never followed.
 */
export interface OAuthHttpRequest { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string }
export interface OAuthHttpResponse { status: number; headers: { 'www-authenticate'?: string; 'content-type'?: string }; body: string }
export type OAuthTransport = (request: OAuthHttpRequest) => Promise<OAuthHttpResponse>;
export const OAUTH_RESPONSE_LIMIT = 256 * 1024;
const REQUEST_LIMIT = 64 * 1024;
/** Sent on every request: ProPR identifies itself truthfully. */
export const OAUTH_USER_AGENT = 'ProPR';

/** The request could not be completed (policy refusal, DNS, TLS, timeout, size). Messages are fixed and carry no response content. */
export class OAuthNetworkError extends Error {}

/** The policy-enforcing transport used in production. `lookup` is injectable for tests. */
export function createOAuthHttpsTransport(options: { lookup?: ExtensionLookup } = {}): OAuthTransport {
  return async request => {
    // One deadline for the whole request, name resolution included: a request is never sent once it has passed,
    // so a refresh never outlives the lease it was started under.
    const deadline = Date.now() + EXTENSION_LIMITS.timeoutMs;
    const { url, address, family } = await resolveExtensionEndpoint(request.url, options.lookup);
    if (Date.now() >= deadline) throw new OAuthNetworkError('OAuth request failed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const destination = new URL(`https://${family === 6 ? `[${address}]` : address}`);
    destination.pathname = url.pathname;
    return new Promise<OAuthHttpResponse>((resolve, reject) => {
      const unavailable = () => reject(new OAuthNetworkError('OAuth request failed'));
      const outgoing = https.request(destination, {
        method: request.method, agent: false, servername: isIP(host) ? undefined : host,
        lookup: (_host, _options, callback) => callback(null, address, family),
        headers: { ...request.headers, Host: url.host, 'User-Agent': OAUTH_USER_AGENT, ...(request.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(request.body)) }) },
      }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > OAUTH_RESPONSE_LIMIT) { response.destroy(); unavailable(); } else chunks.push(chunk); });
        response.on('error', unavailable);
        response.on('end', () => {
          const header = (name: string) => { const value = response.headers[name]; return Array.isArray(value) ? value.join(', ') : value; };
          resolve({ status: response.statusCode ?? 0, headers: { 'www-authenticate': header('www-authenticate'), 'content-type': header('content-type') }, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      const timer = setTimeout(() => { outgoing.destroy(); unavailable(); }, Math.max(deadline - Date.now(), 0));
      outgoing.on('close', () => clearTimeout(timer)); outgoing.on('error', unavailable);
      outgoing.end(request.body);
    });
  };
}

/**
 * Send one OAuth request. The URL is checked against the endpoint policy
 * before any transport sees it, so an injected transport cannot widen it.
 */
export async function oauthRequest(transport: OAuthTransport, request: OAuthHttpRequest): Promise<OAuthHttpResponse> {
  try { extensionEndpoint(request.url); } catch { throw new OAuthNetworkError('OAuth endpoint refused by the endpoint policy'); }
  if (request.body !== undefined && Buffer.byteLength(request.body) > REQUEST_LIMIT) throw new OAuthNetworkError('OAuth request too large');
  let response: OAuthHttpResponse;
  try { response = await transport(request); } catch (error) { throw error instanceof OAuthNetworkError ? error : new OAuthNetworkError('OAuth request failed'); }
  if (Buffer.byteLength(response.body) > OAUTH_RESPONSE_LIMIT) throw new OAuthNetworkError('OAuth response too large');
  return response;
}

/** Parse a JSON object body; anything else is null. */
export function jsonObject(response: OAuthHttpResponse): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(response.body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export const formBody = (fields: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
