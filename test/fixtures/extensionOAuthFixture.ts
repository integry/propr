import { createHash, randomBytes } from 'node:crypto';
import { ExtensionUpstreamUnauthorizedError } from '../../packages/core/src/extensions/endpointPolicy.js';
import type { OAuthHttpRequest, OAuthHttpResponse } from '../../packages/core/src/extensions/extensionOAuthHttp.js';

/**
 * A synthetic OAuth authorization server and OAuth-protected MCP server, as an
 * injected HTTPS transport and gateway `send`. It enforces what a strict
 * provider does: exact redirect URI, PKCE S256 verifier, single-use codes, the
 * resource indicator, client authentication, refresh token rotation and
 * revocation. Public IP literals keep the endpoint policy's DNS checks offline.
 */
export const OAUTH_MCP_URL = 'https://8.8.8.8/mcp';
export const OAUTH_ISSUER = 'https://8.8.4.4';
export const OAUTH_REDIRECT_URI = 'https://propr.example.com/api/instance/extensions/v1/oauth/callback';
export const OAUTH_CLIENT_METADATA_URL = 'https://propr.example.com/api/instance/extensions/v1/oauth/client-metadata.json';
export const OAUTH_URLS = { redirectUri: OAUTH_REDIRECT_URI, clientMetadataUrl: OAUTH_CLIENT_METADATA_URL };
export const PREREGISTERED_CLIENT = { id: 'preregistered-propr-client', secret: 'PREREGISTERED_CLIENT_SECRET_SENTINEL_0001' };

export interface SyntheticOAuthOptions {
  /** Where the protected resource metadata is found: named by the 401 challenge, or only at the well-known location. */
  discovery?: 'challenge' | 'well_known';
  /** Which registration methods the authorization server advertises. */
  advertise?: { metadataDocument?: boolean; dynamic?: boolean };
  /** Seconds until an access token expires. */
  accessTtl?: number;
  /** Issue a new refresh token on every refresh and invalidate the old one. */
  rotate?: boolean;
  /** Promise and send `iss` in authorization responses (RFC 9207). */
  issParameter?: boolean;
  revocation?: boolean;
  now?: () => number;
}

interface IssuedCode { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string; used: boolean }
const json = (status: number, body: unknown, headers: OAuthHttpResponse['headers'] = {}): OAuthHttpResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const random = (prefix: string) => `${prefix}_${randomBytes(18).toString('base64url')}`;

export function syntheticOAuthProvider(options: SyntheticOAuthOptions = {}) {
  const now = options.now ?? Date.now;
  const discovery = options.discovery ?? 'challenge';
  const clients = new Map<string, { secret?: string; redirectUris: string[] }>([[PREREGISTERED_CLIENT.id, { secret: PREREGISTERED_CLIENT.secret, redirectUris: [OAUTH_REDIRECT_URI] }]]);
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, { expiresAt: number; clientId: string }>();
  const refreshTokens = new Map<string, { clientId: string; scope: string }>();
  const state = {
    requests: [] as OAuthHttpRequest[],
    tokenRequests: { authorization_code: 0, refresh_token: 0 },
    registrations: 0, revoked: [] as string[],
    /** Make the next refresh fail: `authorization` is invalid_grant, `network` a 503. */
    refreshFailure: null as null | 'authorization' | 'network',
    /** Hold refresh responses until released, to make callers overlap. */
    holdRefresh: null as null | Promise<void>,
    /** Every access token and refresh token ever issued, for sentinel checks. */
    issued: [] as string[],
    upstreamCalls: [] as { token?: string; method: string }[],
  };
  const issueTokens = (clientId: string, scope: string) => {
    const access = random('SYNTHETIC_ACCESS_TOKEN'); const refresh = random('SYNTHETIC_REFRESH_TOKEN');
    accessTokens.set(access, { expiresAt: now() + (options.accessTtl ?? 3600) * 1000, clientId });
    refreshTokens.set(refresh, { clientId, scope });
    state.issued.push(access, refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: options.accessTtl ?? 3600, refresh_token: refresh, scope };
  };
  const authenticate = (request: OAuthHttpRequest, form: URLSearchParams): string | null => {
    const basic = /^Basic (.+)$/.exec(request.headers?.Authorization ?? '');
    const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':').map(v => decodeURIComponent(v.replace(/\+/g, ' '))) : [form.get('client_id'), form.get('client_secret') ?? undefined];
    const client = id ? clients.get(id) : undefined;
    if (!id || !client || (client.secret !== undefined && client.secret !== secret)) return null;
    return id;
  };
  const metadata = {
    issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/authorize`, token_endpoint: `${OAUTH_ISSUER}/token`,
    ...(options.advertise?.dynamic ? { registration_endpoint: `${OAUTH_ISSUER}/register` } : {}),
    ...(options.revocation !== false ? { revocation_endpoint: `${OAUTH_ISSUER}/revoke` } : {}),
    code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], scopes_supported: ['docs.read', 'docs.write'],
    client_id_metadata_document_supported: options.advertise?.metadataDocument === true,
    authorization_response_iss_parameter_supported: options.issParameter === true,
  };
  const resourceMetadata = { resource: OAUTH_MCP_URL, authorization_servers: [OAUTH_ISSUER], scopes_supported: ['docs.read'] };

  // eslint-disable-next-line complexity -- one synthetic provider routes every endpoint
  const transport = async (request: OAuthHttpRequest): Promise<OAuthHttpResponse> => {
    state.requests.push(request);
    const url = new URL(request.url);
    if (request.url === OAUTH_MCP_URL && request.method === 'POST') {
      return json(401, { error: 'unauthorized' }, { 'www-authenticate': discovery === 'challenge' ? `Bearer resource_metadata="https://8.8.8.8/.well-known/oauth-protected-resource/mcp", scope="docs.read"` : 'Bearer realm="mcp"' });
    }
    if (request.method === 'GET' && url.origin === 'https://8.8.8.8') {
      if (discovery === 'challenge' && url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, resourceMetadata);
      if (discovery === 'well_known' && url.pathname === '/.well-known/oauth-protected-resource') return json(200, resourceMetadata);
      return json(404, {});
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(200, metadata);
    if (request.method === 'GET') return json(404, {});
    if (url.pathname === '/register' && options.advertise?.dynamic) {
      const body = JSON.parse(request.body ?? '{}') as { redirect_uris?: string[]; client_name?: string };
      if (body.client_name !== 'ProPR' || !Array.isArray(body.redirect_uris)) return json(400, { error: 'invalid_client_metadata' });
      const id = random('dynamic_client'); const secret = random('DYNAMIC_CLIENT_SECRET');
      clients.set(id, { secret, redirectUris: body.redirect_uris }); state.registrations++; state.issued.push(secret);
      return json(201, { client_id: id, client_secret: secret, token_endpoint_auth_method: 'client_secret_post', redirect_uris: body.redirect_uris });
    }
    const form = new URLSearchParams(request.body ?? '');
    if (url.pathname === '/revoke') { const token = form.get('token'); if (token) { state.revoked.push(token); accessTokens.delete(token); refreshTokens.delete(token); } return json(200, {}); }
    if (url.pathname !== '/token') return json(404, {});
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      state.tokenRequests.authorization_code++;
      const clientId = authenticate(request, form); const code = codes.get(form.get('code') ?? '');
      if (!clientId || !code || code.used || code.clientId !== clientId || code.redirectUri !== form.get('redirect_uri') || code.resource !== form.get('resource')) return json(400, { error: 'invalid_grant' });
      code.used = true;
      if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return json(200, issueTokens(clientId, code.scope));
    }
    if (grant === 'refresh_token') {
      state.tokenRequests.refresh_token++;
      if (state.holdRefresh) await state.holdRefresh;
      if (state.refreshFailure === 'network') return json(503, { error: 'temporarily_unavailable' });
      const clientId = authenticate(request, form); const refresh = refreshTokens.get(form.get('refresh_token') ?? '');
      if (state.refreshFailure === 'authorization' || !clientId || !refresh || refresh.clientId !== clientId || form.get('resource') !== OAUTH_MCP_URL) return json(400, { error: 'invalid_grant' });
      const issued = issueTokens(clientId, refresh.scope);
      if (options.rotate !== false) refreshTokens.delete(form.get('refresh_token')!);
      else { refreshTokens.delete(issued.refresh_token); delete (issued as Partial<typeof issued>).refresh_token; }
      return json(200, issued);
    }
    return json(400, { error: 'unsupported_grant_type' });
  };

  /**
   * The administrator consenting on the provider's authorization page: checks
   * the request as a strict provider does and returns the redirect parameters.
   * `verifierChallenge` replaces the PKCE challenge, as a tampered request would.
   */
  const authorize = (authorizationUrl: string, override: { challenge?: string; iss?: string | null } = {}) => {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    const clientId = params.get('client_id')!;
    if (url.origin + url.pathname !== metadata.authorization_endpoint || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || params.get('resource') !== OAUTH_MCP_URL) throw new Error('Invalid authorization request');
    // A Client ID Metadata Document client id is ProPR's own URL; registered clients must know the redirect URI.
    if (clientId === OAUTH_CLIENT_METADATA_URL) { if (!metadata.client_id_metadata_document_supported) throw new Error('Unknown client'); clients.set(clientId, { redirectUris: [OAUTH_REDIRECT_URI] }); }
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(params.get('redirect_uri')!)) throw new Error('Unregistered redirect URI');
    const code = random('code');
    codes.set(code, { clientId, redirectUri: params.get('redirect_uri')!, challenge: override.challenge ?? params.get('code_challenge')!, resource: params.get('resource')!, scope: params.get('scope') ?? '', used: false });
    const iss = override.iss === null ? undefined : override.iss ?? (options.issParameter ? OAUTH_ISSUER : undefined);
    return { code, state: params.get('state')!, ...(iss ? { iss } : {}) };
  };

  /** The OAuth-protected MCP server behind the gateway. Its tool output echoes the token, which the gateway must redact. */
  const send = async (_endpoint: string, body: unknown, token?: string) => {
    const rpc = body as { id?: number; method: string };
    state.upstreamCalls.push({ token, method: rpc.method });
    const access = token ? accessTokens.get(token) : undefined;
    if (!access || access.expiresAt <= now()) throw new ExtensionUpstreamUnauthorizedError();
    if (rpc.method === 'tools/list') return { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'lookup' }] } };
    return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `Found the document. Authorization: Bearer ${token}` }] } };
  };
  /** Invalidate every access token, as a provider revoking sessions does, while refresh tokens stay valid. */
  const expireAccessTokens = () => accessTokens.clear();
  return { transport, authorize, send, state, metadata, expireAccessTokens };
}
