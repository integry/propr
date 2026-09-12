import { randomUUID, createHash } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidRequestError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Response, RequestHandler } from 'express';
import type { Knex } from 'knex';
import type { GitHubUser } from '../authTypes.js';
import { MCP_SCOPES, type McpConfig, type McpScope } from './config.js';
import { McpStore, digest, secret } from './store.js';
import { createClientsStore } from './clients.js';

export interface McpGrant {
  id: string; ownerId: string; clientId: string; clientName: string;
  instanceId: string; resource: string; scopes: McpScope[]; repositories: string[];
  createdAt: number; expiresAt: number; revoked: boolean; membershipSource: string;
}
interface Code { grantId: string; clientId: string; challenge: string; redirect: string; resource: string }
interface Token { grantId: string; clientId: string; expiresAt: number; used?: boolean }
export interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: Omit<AuthorizationParams, 'resource'> & { resource: string };
}

export class McpOAuthProvider implements OAuthServerProvider {
  // Validate PKCE inside the same transaction that consumes the code. The SDK
  // passes the verifier through when this flag is set; validation is never skipped.
  readonly skipLocalPkceValidation = true;
  readonly clientsStore;
  // The ceiling is read through a callback so an admin change applies to live
  // grants and refreshes without restarting the process.
  constructor(readonly store: McpStore, readonly config: McpConfig,
    private readonly scopeCeiling: () => McpScope[] | undefined = () => config.scopeCeiling) { this.clientsStore = createClientsStore(store); }

  /** Scopes this instance permits. 'read' is always grantable; no ceiling means every scope. */
  private allowedScopes(): Set<string> {
    const ceiling = this.scopeCeiling();
    return new Set<string>(ceiling ? [...ceiling, 'read'] : MCP_SCOPES);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) throw new InvalidRequestError('Exact registered redirect_uri required');
    if (params.resource?.href !== this.config.resource) throw new InvalidRequestError('resource must match this MCP endpoint');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('A valid S256 PKCE challenge is required');
    const scopes = params.scopes?.length ? params.scopes : ['read'];
    if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.length > MCP_SCOPES.length || scopes.some(scope => typeof scope !== 'string' || !MCP_SCOPES.includes(scope as McpScope))) throw new InvalidScopeError('Unknown scope');
    // Requests above the ceiling are narrowed rather than rejected, so a client
    // asking for more than this instance permits still gets a usable grant.
    const allowed = this.allowedScopes();
    const permitted = scopes.filter(scope => allowed.has(scope));
    const id = secret();
    await this.store.put('pending', digest(id), { client, params: { ...params, scopes: permitted, resource: this.config.resource } }, { expiresAt: Date.now() + 600_000 });
    res.redirect(`${this.config.origin}/mcp/consent?request=${encodeURIComponent(id)}`);
  }

  async approve(pendingId: string, user: GitHubUser, repositories: string[], { membershipSource, selectedScopes }: { membershipSource: string; selectedScopes?: unknown }): Promise<string> {
    return this.store.db.transaction(async tx => {
      const pending = await this.store.take<PendingAuthorization>('pending', digest(pendingId), tx);
      if (!pending || !user.accessToken || !/^\d+$/.test(user.id)) throw new InvalidGrantError('Authorization expired or GitHub credential unavailable');
      const scopes = selectedScopes === undefined ? pending.params.scopes : selectedScopes;
      const allowed = this.allowedScopes();
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > MCP_SCOPES.length || !scopes.includes('read')
        || scopes.some(scope => typeof scope !== 'string' || !pending.params.scopes?.includes(scope) || !allowed.has(scope))) {
        throw new InvalidScopeError('Select read and only permissions originally requested by the app and permitted by this instance');
      }
      const grant: McpGrant = {
        id: randomUUID(), ownerId: user.id, clientId: pending.client.client_id,
        clientName: pending.client.client_name || pending.client.client_id,
        instanceId: this.config.instanceId, resource: this.config.resource,
        scopes: [...new Set(scopes)] as McpScope[], repositories,
        createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000, revoked: false, membershipSource,
      };
      const code = secret();
      await this.store.put('grant', grant.id, grant, { database: tx });
      await this.store.put('credential', user.id, user, { database: tx });
      await this.store.put('code', digest(code), {
        grantId: grant.id, clientId: grant.clientId, challenge: pending.params.codeChallenge,
        redirect: pending.params.redirectUri, resource: grant.resource,
      }, { expiresAt: Date.now() + 60_000, database: tx });
      const redirect = new URL(pending.params.redirectUri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('iss', `${this.config.origin}/`);
      if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
      return redirect.href;
    });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.store.get<Code>('code', digest(code));
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return record.challenge;
  }

  // The OAuth SDK requires this positional provider signature.
  // eslint-disable-next-line max-params
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirect?: string, resource?: URL): Promise<OAuthTokens> {
    return this.store.db.transaction(async tx => {
      const record = await this.store.get<Code>('code', digest(code), tx);
      if (!record || record.clientId !== client.client_id || record.redirect !== redirect || resource?.href !== record.resource
        || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || createHash('sha256').update(verifier).digest('base64url') !== record.challenge) throw new InvalidGrantError('Invalid code, PKCE, redirect or resource');
      if (!await this.store.take('code', digest(code), tx)) throw new InvalidGrantError('Code already consumed');
      return this.issue(await this.grant(record.grantId, tx), tx);
    });
  }

  async grant(id: string, tx: Knex = this.store.db): Promise<McpGrant> {
    const grant = await this.store.get<McpGrant>('grant', id, tx);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now() || grant.instanceId !== this.config.instanceId || grant.resource !== this.config.resource) throw new InvalidTokenError('Grant expired or revoked');
    return grant;
  }

  private async issue(grant: McpGrant, tx: Knex, scopes = grant.scopes): Promise<OAuthTokens> {
    const access = `propr_mcp_${secret()}`;
    const refresh = secret();
    await this.store.put('access', digest(access), { grantId: grant.id, clientId: grant.clientId, scopes, expiresAt: Date.now() + 300_000 }, { expiresAt: Date.now() + 300_000, database: tx });
    // Retain spent refresh tokens until the grant expires, to detect reuse.
    await this.store.put('refresh', digest(refresh), { grantId: grant.id, clientId: grant.clientId, scopes, expiresAt: grant.expiresAt, used: false }, { expiresAt: grant.expiresAt, database: tx });
    return { access_token: access, token_type: 'Bearer', expires_in: 300, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const result = await this.store.db.transaction(async tx => {
      const token = await this.store.get<Token & { scopes: McpScope[] }>('refresh', digest(refresh), tx);
      if (!token || token.clientId !== client.client_id || resource?.href !== this.config.resource) throw new InvalidGrantError('Invalid refresh token or resource');
      const grant = await this.grant(token.grantId, tx);
      if (token.used) {
        await this.store.put('grant', grant.id, { ...grant, revoked: true }, { database: tx });
        return null; // Commit revocation before reporting the error.
      }
      if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.length || !scopes.includes('read') || scopes.length > MCP_SCOPES.length || scopes.some(scope => typeof scope !== 'string' || !token.scopes.includes(scope as McpScope)))) throw new InvalidScopeError('Scope escalation is forbidden');
      await this.store.put('refresh', digest(refresh), { ...token, used: true }, { expiresAt: token.expiresAt, database: tx });
      const allowed = this.allowedScopes();
      return this.issue(grant, tx, (scopes?.length ? scopes as McpScope[] : token.scopes).filter(scope => allowed.has(scope)));
    });
    if (!result) throw new InvalidGrantError('Refresh reuse detected; grant revoked');
    return result;
  }

  async verifyAccessToken(token: string) {
    const record = await this.store.get<Token & { scopes: McpScope[] }>('access', digest(token));
    if (!record || record.expiresAt <= Date.now()) throw new InvalidTokenError('Invalid access token');
    const grant = await this.grant(record.grantId);
    const allowed = this.allowedScopes();
    return { token, clientId: grant.clientId, scopes: record.scopes.filter(scope => grant.scopes.includes(scope) && allowed.has(scope)), expiresAt: Math.floor(record.expiresAt / 1000), resource: new URL(grant.resource), extra: { grantId: grant.id } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const record = await this.store.get<Token>('refresh', digest(request.token)) || await this.store.get<Token>('access', digest(request.token));
    if (record?.clientId === client.client_id) await this.revokeGrant(record.grantId);
  }

  async revokeGrant(id: string, ownerId?: string): Promise<void> {
    await this.store.db.transaction(async tx => {
      const grant = await this.store.get<McpGrant>('grant', id, tx);
      if (grant && (!ownerId || grant.ownerId === ownerId)) await this.store.put('grant', id, { ...grant, revoked: true }, { database: tx });
    });
  }
}


/** The SDK ignores extra client-assertion and code-scope fields. Reject them
 * before code consumption so public PKCE negotiation cannot hide an escalation. */
export const validatePublicTokenRequest: RequestHandler = (req, res, next) => {
  const body = req.body ?? {};
  if (Object.values(body).some(value => typeof value !== 'string')) {
    res.status(400).json({ error: 'invalid_request' }); return;
  }
  if (Object.hasOwn(body, 'client_assertion') || Object.hasOwn(body, 'client_assertion_type') || body.client_secret) {
    res.status(400).json({ error: 'invalid_client', error_description: 'Public clients use client_id and S256 PKCE without client assertions or secrets.' }); return;
  }
  if (body.grant_type === 'authorization_code' && Object.hasOwn(body, 'scope')) {
    res.status(400).json({ error: 'invalid_scope', error_description: 'Authorization-code scopes are fixed by consent.' }); return;
  }
  next();
};
