import { createHash, randomBytes } from 'node:crypto';
import type { ExtensionOAuthRegistration } from '@propr/shared';
import { OAuthNetworkError, formBody, jsonObject, oauthRequest, type OAuthHttpResponse, type OAuthTransport } from './extensionOAuthHttp.js';

/**
 * The OAuth client protocol of ProPR for library MCP servers, following the MCP
 * authorization specification: protected resource metadata (RFC 9728) from the
 * server's 401 challenge or its well-known location, authorization server
 * metadata (RFC 8414, then OpenID Connect discovery), client registration by
 * Client ID Metadata Document, Dynamic Client Registration (RFC 7591) or a
 * pre-registered client, authorization code with PKCE S256 and the `resource`
 * indicator (RFC 8707), refresh and revocation (RFC 7009). ProPR always
 * presents its own identity; it never uses another product's client.
 */
export interface AuthorizationServerMetadata {
  issuer: string; authorization_endpoint: string; token_endpoint: string;
  registration_endpoint?: string; revocation_endpoint?: string;
  scopes_supported?: string[]; token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean; authorization_response_iss_parameter_supported?: boolean;
}
export interface OAuthDiscovery {
  discoveredFrom: 'challenge' | 'well_known'; resource: string; issuer: string;
  metadata: AuthorizationServerMetadata; scopes: string[];
}
/** The client ProPR uses with one authorization server. The secret stays sealed in Core. */
export interface OAuthClient { registration: ExtensionOAuthRegistration; clientId: string; clientSecret?: string; authMethod: 'none' | 'client_secret_basic' | 'client_secret_post' }
export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: number | null; scopes: string[] }

/**
 * The authorization server or MCP server refused, or answered outside the
 * protocol. `authorization` marks a refused grant or client: the connection
 * needs a new sign-in. Messages are fixed and never contain response content.
 */
export class OAuthProtocolError extends Error { constructor(message: string, readonly authorization = false) { super(message); } }

const MCP_PROTOCOL_VERSION = '2025-06-18';
const tokenPattern = /^[\x21-\x7e]{1,8192}$/;
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined);
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
};
/** Drops trailing slashes in linear time (a `/\/+$/` replace backtracks on long slash runs). */
const trimSlashes = (value: string) => { let end = value.length; while (end > 0 && value.charCodeAt(end - 1) === 47) end--; return value.slice(0, end); };
const sameResource = (a: string, b: string) => trimSlashes(a) === trimSlashes(b);

/** `resource_metadata` and `scope` of a Bearer challenge. */
export function parseBearerChallenge(header: string | undefined): { resourceMetadata?: string; scope?: string } {
  if (!header || !/^\s*bearer\b/i.test(header)) return {};
  const param = (name: string) => new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, 'i').exec(header.replace(/^\s*bearer/i, ''));
  const metadata = param('resource_metadata'); const scope = param('scope');
  return { ...(metadata ? { resourceMetadata: metadata[1] ?? metadata[2] } : {}), ...(scope ? { scope: scope[1] ?? scope[2] } : {}) };
}

async function getJson(transport: OAuthTransport, url: string): Promise<Record<string, unknown> | null> {
  const response = await oauthRequest(transport, { method: 'GET', url, headers: { Accept: 'application/json' } });
  return response.status === 200 ? jsonObject(response) : null;
}
/** The well-known locations of a resource's metadata, path-specific first. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl); const path = trimSlashes(url.pathname);
  return [...new Set([...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []), `${url.origin}/.well-known/oauth-protected-resource`])];
}
/** RFC 8414 and OpenID Connect discovery locations for an issuer, in the MCP specification's order. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer); const path = trimSlashes(url.pathname);
  return path
    ? [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`]
    : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
}

function parseAuthorizationServerMetadata(document: Record<string, unknown> | null, issuer: string): AuthorizationServerMetadata | null {
  if (!document || document.issuer !== issuer || !httpsUrl(document.authorization_endpoint) || !httpsUrl(document.token_endpoint)) return null;
  for (const optional of ['registration_endpoint', 'revocation_endpoint'] as const) if (document[optional] !== undefined && !httpsUrl(document[optional])) return null;
  // MCP clients must refuse to proceed without PKCE S256 support.
  if (!strings(document.code_challenge_methods_supported)?.includes('S256')) throw new OAuthProtocolError('The authorization server does not support PKCE with S256');
  return {
    issuer, authorization_endpoint: document.authorization_endpoint as string, token_endpoint: document.token_endpoint as string,
    ...(document.registration_endpoint ? { registration_endpoint: document.registration_endpoint as string } : {}),
    ...(document.revocation_endpoint ? { revocation_endpoint: document.revocation_endpoint as string } : {}),
    ...(strings(document.scopes_supported) ? { scopes_supported: strings(document.scopes_supported)!.filter(s => scopePattern.test(s)).slice(0, 64) } : {}),
    ...(strings(document.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: strings(document.token_endpoint_auth_methods_supported)!.slice(0, 16) } : {}),
    client_id_metadata_document_supported: document.client_id_metadata_document_supported === true,
    authorization_response_iss_parameter_supported: document.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * Discover how to sign in to an MCP server. Returns null when the server
 * answers an unauthenticated request without requiring authorization.
 */
// eslint-disable-next-line complexity -- the specification's discovery order and fallbacks are kept in one place
export async function discoverOAuth(transport: OAuthTransport, serverUrl: string, configuredScopes?: string[]): Promise<OAuthDiscovery | null> {
  let probe: OAuthHttpResponse;
  try {
    probe = await oauthRequest(transport, {
      method: 'POST', url: serverUrl,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ProPR', version: '1' } } }),
    });
  } catch (error) { if (error instanceof OAuthNetworkError) throw new OAuthNetworkError('The MCP server could not be reached'); throw error; }
  if (probe.status >= 200 && probe.status < 300) return null;
  const challenge = probe.status === 401 ? parseBearerChallenge(probe.headers['www-authenticate']) : {};
  let resourceDocument: Record<string, unknown> | null = null; let discoveredFrom: OAuthDiscovery['discoveredFrom'] = 'challenge';
  if (challenge.resourceMetadata) {
    if (!httpsUrl(challenge.resourceMetadata)) throw new OAuthProtocolError('The protected resource metadata location is not an HTTPS URL');
    resourceDocument = await getJson(transport, challenge.resourceMetadata);
  }
  if (!resourceDocument) {
    discoveredFrom = 'well_known';
    for (const url of protectedResourceMetadataUrls(serverUrl)) if ((resourceDocument = await getJson(transport, url))) break;
  }
  if (!resourceDocument) throw new OAuthProtocolError('The MCP server published no protected resource metadata');
  const resource = resourceDocument.resource; const servers = strings(resourceDocument.authorization_servers);
  // RFC 9728: the metadata must name this resource (the server URL or a path prefix of it on the same origin).
  if (typeof resource !== 'string' || !httpsUrl(resource) || !(sameResource(resource, serverUrl) || (new URL(resource).origin === new URL(serverUrl).origin && serverUrl.startsWith(trimSlashes(resource) + '/')))) throw new OAuthProtocolError('The protected resource metadata names another resource');
  const issuer = servers?.find(httpsUrl);
  if (!issuer || new URL(issuer).search) throw new OAuthProtocolError('The protected resource metadata names no authorization server');
  let metadata: AuthorizationServerMetadata | null = null;
  for (const url of authorizationServerMetadataUrls(issuer)) if ((metadata = parseAuthorizationServerMetadata(await getJson(transport, url), issuer))) break;
  if (!metadata) throw new OAuthProtocolError('The authorization server published no usable metadata');
  const scopes = configuredScopes?.length ? configuredScopes
    : challenge.scope ? challenge.scope.split(/\s+/).filter(s => scopePattern.test(s))
      : (strings(resourceDocument.scopes_supported) ?? []).filter(s => scopePattern.test(s));
  // The resource indicator (RFC 8707) is the identifier the metadata declares, which may be a parent of the endpoint.
  return { discoveredFrom, resource, issuer, metadata, scopes: scopes.slice(0, 32) };
}

/**
 * The registration method a sign-in uses. A client id the administrator
 * entered is explicit configuration and is used as given; otherwise a Client
 * ID Metadata Document when the server supports it and this instance has a
 * public URL, then Dynamic Client Registration. With `allowed` (a plugin
 * connection's permitted methods) only those are considered, in that order,
 * except that a configured client id always selects pre-registration (or
 * nothing when pre-registration is not permitted). Null when none is possible.
 */
export function chooseRegistration(metadata: AuthorizationServerMetadata, options: { clientId?: string; clientMetadataUrl: string | null; allowed?: readonly ExtensionOAuthRegistration[] }): ExtensionOAuthRegistration | null {
  // A configured client id binds the server's connection to that client (see connectionBelongsTo), so no automatic
  // registration can produce a usable connection for it: pre-registration is the only method, whatever the order.
  if (options.clientId) return !options.allowed || options.allowed.includes('preregistered') ? 'preregistered' : null;
  const available: Record<ExtensionOAuthRegistration, boolean> = {
    preregistered: false,
    metadata_document: Boolean(metadata.client_id_metadata_document_supported && options.clientMetadataUrl),
    dynamic: Boolean(metadata.registration_endpoint),
  };
  const order: readonly ExtensionOAuthRegistration[] = options.allowed ?? ['preregistered', 'metadata_document', 'dynamic'];
  return order.find(method => available[method]) ?? null;
}

/** ProPR's own client metadata, served at `clientMetadataUrl`, which is also the client id. */
export function clientMetadataDocument(clientMetadataUrl: string, redirectUri: string) {
  return {
    client_id: clientMetadataUrl, client_name: 'ProPR', client_uri: new URL(clientMetadataUrl).origin, redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  };
}

const secretAuthMethod = (metadata: AuthorizationServerMetadata): OAuthClient['authMethod'] => {
  const supported = metadata.token_endpoint_auth_methods_supported;
  // RFC 8414: client_secret_basic is the default when the server lists none.
  return !supported || supported.includes('client_secret_basic') || !supported.includes('client_secret_post') ? 'client_secret_basic' : 'client_secret_post';
};
export function preregisteredClient(metadata: AuthorizationServerMetadata, clientId: string, clientSecret?: string): OAuthClient {
  return { registration: 'preregistered', clientId, ...(clientSecret ? { clientSecret, authMethod: secretAuthMethod(metadata) } : { authMethod: 'none' }) };
}

/** RFC 7591 registration of ProPR as a public client with exactly the instance's redirect URI. */
export async function registerDynamicClient(transport: OAuthTransport, metadata: AuthorizationServerMetadata, redirectUri: string): Promise<OAuthClient> {
  if (!metadata.registration_endpoint) throw new OAuthProtocolError('The authorization server offers no client registration');
  const response = await oauthRequest(transport, {
    method: 'POST', url: metadata.registration_endpoint, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'ProPR', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const document = jsonObject(response);
  if (![200, 201].includes(response.status) || typeof document?.client_id !== 'string' || !tokenPattern.test(document.client_id) || document.client_id.length > 512) throw new OAuthProtocolError('Client registration was refused');
  const secret = typeof document.client_secret === 'string' && tokenPattern.test(document.client_secret) ? document.client_secret : undefined;
  const method = document.token_endpoint_auth_method;
  const authMethod: OAuthClient['authMethod'] = !secret ? 'none' : method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic';
  return { registration: 'dynamic', clientId: document.client_id, ...(secret ? { clientSecret: secret } : {}), authMethod };
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizationUrl(metadata: AuthorizationServerMetadata, request: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scopes: string[] }): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri); url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256'); url.searchParams.set('state', request.state);
  url.searchParams.set('resource', request.resource);
  if (request.scopes.length) url.searchParams.set('scope', request.scopes.join(' '));
  return url.toString();
}

const encodeCredential = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
function clientAuthentication(client: OAuthClient): { headers: Record<string, string>; fields: Record<string, string | undefined> } {
  if (client.clientSecret && client.authMethod === 'client_secret_basic') {
    return { headers: { Authorization: `Basic ${Buffer.from(`${encodeCredential(client.clientId)}:${encodeCredential(client.clientSecret)}`).toString('base64')}` }, fields: {} };
  }
  return { headers: {}, fields: { client_id: client.clientId, ...(client.clientSecret && client.authMethod === 'client_secret_post' ? { client_secret: client.clientSecret } : {}) } };
}

/**
 * One token endpoint request. A refused grant or client (400/401) is an
 * authorization error; any other failure is transient and leaves the
 * connection unchanged.
 */
// eslint-disable-next-line max-params -- transport, server, client, grant fields and the clock of one token request
export async function requestTokens(transport: OAuthTransport, metadata: AuthorizationServerMetadata, client: OAuthClient, fields: Record<string, string | undefined>, now = Date.now()): Promise<OAuthTokens> {
  const auth = clientAuthentication(client);
  const response = await oauthRequest(transport, {
    method: 'POST', url: metadata.token_endpoint, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...auth.headers },
    body: formBody({ ...fields, ...auth.fields }),
  });
  if (response.status === 400 || response.status === 401) throw new OAuthProtocolError('The authorization server refused the grant', true);
  if (response.status !== 200) throw new OAuthNetworkError('The authorization server is unavailable');
  const document = jsonObject(response);
  if (!document || typeof document.access_token !== 'string' || !tokenPattern.test(document.access_token) || typeof document.token_type !== 'string' || document.token_type.toLowerCase() !== 'bearer') throw new OAuthProtocolError('The token response is invalid');
  const refresh = typeof document.refresh_token === 'string' && tokenPattern.test(document.refresh_token) ? document.refresh_token : undefined;
  const expiresIn = typeof document.expires_in === 'number' && Number.isFinite(document.expires_in) && document.expires_in > 0 ? Math.min(document.expires_in, 10 * 365 * 86_400) : null;
  const scopes = typeof document.scope === 'string' ? document.scope.split(/\s+/).filter(s => scopePattern.test(s)).slice(0, 64) : undefined;
  return { accessToken: document.access_token, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: expiresIn === null ? null : now + expiresIn * 1000, scopes: scopes ?? [] };
}

// eslint-disable-next-line max-params -- the protocol inputs of one grant
export const exchangeAuthorizationCode = (transport: OAuthTransport, metadata: AuthorizationServerMetadata, client: OAuthClient, request: { code: string; verifier: string; redirectUri: string; resource: string }, now = Date.now()) =>
  requestTokens(transport, metadata, client, { grant_type: 'authorization_code', code: request.code, code_verifier: request.verifier, redirect_uri: request.redirectUri, resource: request.resource }, now);

// eslint-disable-next-line max-params -- the protocol inputs of one grant
export const refreshTokens = (transport: OAuthTransport, metadata: AuthorizationServerMetadata, client: OAuthClient, request: { refreshToken: string; resource: string }, now = Date.now()) =>
  requestTokens(transport, metadata, client, { grant_type: 'refresh_token', refresh_token: request.refreshToken, resource: request.resource }, now);

/** RFC 7009 revocation when the server advertises it. Failures are reported, never thrown. */
export async function revokeToken(transport: OAuthTransport, metadata: AuthorizationServerMetadata, client: OAuthClient, revoke: { token: string; hint: 'refresh_token' | 'access_token' }): Promise<boolean> {
  const { token, hint } = revoke;
  if (!metadata.revocation_endpoint) return false;
  const auth = clientAuthentication(client);
  try {
    const response = await oauthRequest(transport, {
      method: 'POST', url: metadata.revocation_endpoint, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...auth.headers },
      body: formBody({ token, token_type_hint: hint, ...auth.fields }),
    });
    return response.status === 200;
  } catch { return false; }
}
