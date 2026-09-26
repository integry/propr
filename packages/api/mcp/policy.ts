import { Octokit } from '@octokit/core';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload, type JWTHeaderParameters } from 'jose';
import { loadMonitoredReposRaw } from '@propr/core';
import type { GitHubUser } from '../authTypes.js';
import { resolveInstanceAuthorization, type InstanceAuthorization, type InstancePermission } from '../authorization.js';
import { isUserWhitelisted } from '../userWhitelist.js';
import { refreshStoredGitHubCredential } from '../authGithubTokens.js';
import { McpConnect, MCP_CONNECT_CONTRACT, instanceAudience } from './connect.js';
import { McpError, MCP_SCOPES, type McpConfig, type McpScope } from './config.js';
import { McpOAuthProvider, type McpGrant } from './oauth.js';
import { secret } from './store.js';

export interface McpPrincipal {
  user: GitHubUser;
  authorization: InstanceAuthorization;
  grant: McpGrant;
  scopes: McpScope[];
  github: Octokit;
}

export class McpPolicy {
  private readonly jwks;
  constructor(readonly oauth: McpOAuthProvider, readonly config: McpConfig) {
    this.jwks = config.connect ? createRemoteJWKSet(new URL(config.connect.jwks), { timeoutDuration: 5000, cooldownDuration: 30_000 }) : undefined;
  }

  async authenticate(bearer: string, resourceHint?: string): Promise<McpPrincipal> {
    let grant: McpGrant;
    let scopes: McpScope[];
    if (bearer.startsWith('propr_mcp_')) {
      const info = await this.oauth.verifyAccessToken(bearer);
      grant = await this.oauth.grant(info.extra.grantId);
      scopes = info.scopes;
    } else {
      try { grant = await this.delegation(bearer, resourceHint); }
      catch (error) {
        if (error instanceof McpError) throw error;
        if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) throw new McpError('CONNECT_UNAVAILABLE', 'Connect grant validation is unavailable.', 503);
        throw new McpError('INVALID_DELEGATION', 'Connect signature or token claims are invalid.', 401);
      }
      scopes = grant.scopes;
    }
    let user = await this.oauth.store.get<GitHubUser>('credential', grant.ownerId);
    if (!user?.accessToken) throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'Sign in through the browser to authorize GitHub access.', 401);
    if (user.tokenExpiresAt && user.tokenExpiresAt < Date.now() + 30_000) {
      user = await this.refreshCredential(user);
    }
    let github = new Octokit({ auth: user.accessToken, request: { timeout: 10_000 } });
    let identity;
    try { identity = (await github.request('GET /user')).data; }
    catch (error) {
      if (grant.membershipSource !== 'connect' || (error as { status?: number }).status !== 401) {
        throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub authorization is unavailable; sign in again.', 401);
      }
      user = await this.renewConnectCredential(bearer, grant, user);
      github = new Octokit({ auth: user.accessToken, request: { timeout: 10_000 } });
      try { identity = (await github.request('GET /user')).data; }
      catch { throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub authorization is unavailable; reconnect the app.', 401); }
    }
    if (String(identity.id) !== grant.ownerId || !isUserWhitelisted(identity.login)) throw new McpError('ACCESS_REVOKED', 'Current instance access denied.', 403);
    user = { ...user, username: identity.login, login: identity.login };
    const authorization = await resolveInstanceAuthorization(user, this.oauth.store.db);
    if (authorization.source === 'demo' || (['local', 'managed', 'connect'].includes(grant.membershipSource) && authorization.source === 'implicit')) {
      throw new McpError('ACCESS_REVOKED', 'Instance membership was revoked.', 403);
    }
    return { user, authorization, grant, scopes, github };
  }

  private async renewConnectCredential(bearer: string, grant: McpGrant, user: GitHubUser): Promise<GitHubUser> {
    // Connect handoffs omit expiry/refresh metadata. A renewed browser consent
    // can replace an expired credential; never replace a concurrently refreshed one.
    const previous = user.accessToken;
    const renewed = await new McpConnect(this.config, this.oauth.store).credential(bearer, grant.ownerId);
    const candidate = new Octokit({ auth: renewed.accessToken, request: { timeout: 10_000 } });
    let verified;
    try { verified = (await candidate.request('GET /user')).data; }
    catch { throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'Reconnect the app in Connect to renew GitHub authorization.', 401); }
    if (String(verified.id) !== grant.ownerId) throw new McpError('ACCESS_REVOKED', 'Credential identity mismatch.', 403);
    return this.oauth.store.db.transaction(async tx => {
      const current = await this.oauth.store.get<GitHubUser>('credential', grant.ownerId, tx);
      if (current?.accessToken && current.accessToken !== previous) return current;
      await this.oauth.store.put('credential', renewed.id, renewed, { database: tx });
      return renewed;
    });
  }

  private async refreshCredential(user: GitHubUser): Promise<GitHubUser> {
    const store = this.oauth.store;
    const identity = { kind: 'credential_refresh', id: user.id };
    const value = store.seal({ nonce: secret() });
    const claim = await store.db('mcp_records').insert({ ...identity, value, expires_at: Date.now() + 90_000 })
      .onConflict(['kind', 'id']).merge().where('mcp_records.expires_at', '<', Date.now()).returning('id');
    if (!claim.length) throw new McpError('GITHUB_AUTH_REFRESHING', 'GitHub authorization is refreshing. Retry in three seconds.', 503);
    try {
      const current = await store.get<GitHubUser>('credential', user.id);
      if (!current?.accessToken) throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub credential unavailable.', 401);
      if (!current.tokenExpiresAt || current.tokenExpiresAt >= Date.now() + 30_000) return current;
      const originalToken = current.accessToken;
      const result = await refreshStoredGitHubCredential(current);
      if (result.status === 'temporarily-unavailable') throw new McpError('GITHUB_UNAVAILABLE', 'GitHub authorization refresh is temporarily unavailable.', 503);
      if (result.status !== 'refreshed') throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub authorization must be renewed in the browser.', 401);
      // Do not hold a SQLite transaction during the shared refresh coordinator
      // or overwrite a newer browser consent that completed in the meantime.
      return await store.db.transaction(async tx => {
        const latest = await store.get<GitHubUser>('credential', user.id, tx);
        if (latest?.accessToken !== originalToken) return latest || current;
        await store.put('credential', user.id, current, { database: tx });
        return current;
      });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('GITHUB_UNAVAILABLE', 'GitHub authorization refresh is temporarily unavailable.', 503);
    } finally { await store.db('mcp_records').where({ ...identity, value }).delete(); }
  }

  private async delegation(token: string, resourceHint?: string): Promise<McpGrant> {
    const connect = this.config.connect;
    if (!connect || !this.jwks) throw new McpError('INVALID_TOKEN', 'Connect trust is disabled.', 401);
    const proof = new McpConnect(this.config, this.oauth.store);
    const thumbprint = await proof.registeredThumbprint();
    const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
      algorithms: ['ES256'], issuer: connect.issuer, audience: instanceAudience(this.config.instanceId),
      clockTolerance: 5, maxTokenAge: '65s', requiredClaims: ['sub', 'iat', 'exp', 'jti', 'grant_id', 'instance_id', 'installation_id', 'scopes', 'repositories', 'contract_version', 'resource', 'instance_key_thumbprint'],
    });
    if (payload.contract_version !== MCP_CONNECT_CONTRACT) throw new McpError('INSTANCE_VERSION_MISMATCH', 'This instance does not support the signed Connect contract version.', 409);
    this.validateDelegationBinding(payload, protectedHeader, { thumbprint, resourceHint });
    validateDelegationClaims(payload);
    const { scopes, repositories } = payload;
    // Validate every invocation, even when the same JWT reaches the instance directly.
    const state = await proof.online('/v1/mcp/delegations/validate', token);
    if (state.active !== true || Object.keys(payload).some(key => JSON.stringify(state[key]) !== JSON.stringify(payload[key]))) {
      throw new McpError('ACCESS_REVOKED', 'Connect validation binding changed or access was revoked.', 403);
    }
    if (!await this.oauth.store.get('credential', payload.sub)) {
      const user = await proof.credential(token, payload.sub);
      // Never overwrite a newer browser credential or a concurrent refresh.
      await this.oauth.store.db.transaction(async tx => {
        if (!await this.oauth.store.get('credential', payload.sub!, tx)) await this.oauth.store.put('credential', user.id, user, { database: tx });
      });
    }
    return { id: payload.grant_id, ownerId: payload.sub, clientId: 'connect', clientName: 'ProPR Connect',
      instanceId: this.config.instanceId, resource: connect.resource, scopes: scopes as McpScope[], repositories: repositories as string[],
      createdAt: payload.iat! * 1000, expiresAt: payload.exp! * 1000, revoked: false, membershipSource: 'connect' };
  }

  private validateDelegationBinding(payload: JWTPayload, header: JWTHeaderParameters, binding: { thumbprint: string; resourceHint?: string }): void {
    const connect = this.config.connect!;
    if (header.typ !== 'propr-mcp-delegation+jwt' || typeof header.kid !== 'string' || !header.kid
      || payload.aud !== instanceAudience(this.config.instanceId) || payload.instance_id !== this.config.instanceId
      || payload.installation_id !== connect.installationId || payload.instance_key_thumbprint !== binding.thumbprint
      || payload.resource !== connect.resource || (binding.resourceHint !== undefined && binding.resourceHint !== payload.resource)) {
      throw new McpError('INVALID_DELEGATION', 'Invalid Connect delegation binding.', 401);
    }
  }

  requireScope(principal: McpPrincipal, scope: McpScope): void {
    if (!principal.scopes.includes(scope)) throw new McpError('INSUFFICIENT_SCOPE', `This operation requires ${scope}.`, 403);
  }

  requirePermission(principal: McpPrincipal, permission: InstancePermission): void {
    if (!principal.authorization.permissions.includes(permission)) throw new McpError('INSUFFICIENT_INSTANCE_PERMISSION', `This operation requires ${permission}.`, 403);
  }

  async repository(principal: McpPrincipal, repository: string, write = false, options: boolean | { includeDisabled?: boolean; allowUnconfigured?: boolean } = false): Promise<void> {
    const { includeDisabled, allowUnconfigured } = typeof options === 'boolean' ? { includeDisabled: options, allowUnconfigured: false } : options;
    const configured = (await loadMonitoredReposRaw()).some(repo => (repo.enabled || includeDisabled) && repo.name.toLowerCase() === repository.toLowerCase());
    if ((!configured && !allowUnconfigured) || !principal.grant.repositories.some(repo => repo.toLowerCase() === repository.toLowerCase())) throw new McpError('REPOSITORY_FORBIDDEN', 'Repository is outside this grant or current instance configuration.', 403);
    const [owner, repo] = repository.split('/');
    let data;
    try { data = (await principal.github.request('GET /repos/{owner}/{repo}', { owner, repo })).data; }
    catch { throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub repository access denied.', 403); }
    if (write && data.permissions?.push !== true && data.permissions?.admin !== true) throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub write permission required.', 403);
  }
}

function validDelegationScopes(scopes: unknown): scopes is McpScope[] {
  return Array.isArray(scopes) && scopes.includes('read') && scopes.length <= MCP_SCOPES.length
    && !scopes.some(scope => typeof scope !== 'string' || !MCP_SCOPES.includes(scope as McpScope));
}

function validDelegationRepositories(repositories: unknown): repositories is string[] {
  return Array.isArray(repositories) && repositories.length > 0 && repositories.length <= 100
    && JSON.stringify(repositories).length <= 4096
    && !repositories.some(repo => typeof repo !== 'string' || repo.length > 200 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
    && JSON.stringify(repositories) === JSON.stringify([...new Set(repositories)].sort());
}

function validateDelegationClaims(payload: JWTPayload): asserts payload is JWTPayload & { sub: string; grant_id: string; scopes: McpScope[]; repositories: string[] } {
  if (typeof payload.sub !== 'string' || !/^[1-9][0-9]*$/.test(payload.sub)
    || typeof payload.grant_id !== 'string' || !payload.grant_id || typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 128
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp! <= payload.iat!
    || payload.exp! - payload.iat! > 60 || payload.iat! > Date.now() / 1000 + 5
    || !validDelegationScopes(payload.scopes) || !validDelegationRepositories(payload.repositories)) {
    throw new McpError('INVALID_DELEGATION', 'Invalid Connect delegation binding.', 401);
  }
}
