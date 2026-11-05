import type { Knex } from 'knex';
import { db, issueOAuthGrantRevision, type VisualPreviewOAuthCredentialGrant } from '@propr/core';
import type { GitHubUser } from './authTypes.js';
import { ConnectGrantRenewer, isRelayRenewable, type RenewableGrantRow } from './connectGrantRenewer.js';
import { decryptToken, encryptToken } from './githubUserGrantCrypto.js';
import { visualPreviewOAuthCredentialService } from './services/visualPreviewOAuth.js';

const REFRESH_BUFFER_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;
const USER_TOKEN_PATTERN = /^(?:gho_|ghu_|ghp_|github_pat_)/;

interface GrantRow extends RenewableGrantRow {
  github_user_id: string;
  github_username: string;
  source: 'github' | 'connect';
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at_ms: number | string | null;
  refresh_token_expires_at_ms: number | string | null;
  status: 'active' | 'reauth_required';
  last_error_code: string | null;
  grant_revision: number | string;
  login_revision: number | string;
  created_at: string;
  updated_at: string;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
}

export type GitHubUserGrantResolution =
  | {
      status: 'active';
      accessToken: string;
      refreshToken?: string;
      tokenExpiresAt?: number;
      refreshTokenExpiresAt?: number;
    }
  | { status: 'missing' }
  | { status: 'reauth_required'; reason?: string }
  | { status: 'temporarily_unavailable' };

interface SharedOAuthGrantService {
  getForOwner?(githubUserId: string): Promise<VisualPreviewOAuthCredentialGrant | null>;
  refreshAndGetForOwner(
    githubUserId: string,
    force?: boolean,
  ): Promise<VisualPreviewOAuthCredentialGrant | null>;
}

function timestamp(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUnrecoverableRefreshError(error?: string): boolean {
  return error === 'bad_refresh_token' || error === 'invalid_grant';
}

function assertUserToken(token: string): string {
  const normalized = token.trim();
  if (!USER_TOKEN_PATTERN.test(normalized)) throw new Error('GitHub user grant did not contain a supported user token');
  return normalized;
}

function reauthRequired(row: Pick<GrantRow, 'last_error_code'>): GitHubUserGrantResolution {
  return row.last_error_code ? { status: 'reauth_required', reason: row.last_error_code } : { status: 'reauth_required' };
}

export class GitHubUserGrantService {
  private readonly refreshes = new Map<string, Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'>>();
  private readonly renewer: ConnectGrantRenewer;

  constructor(
    private readonly database: Knex = db,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sharedOAuthGrant?: SharedOAuthGrantService,
  ) {
    this.renewer = new ConnectGrantRenewer(database, environment, fetchImpl, token => encryptToken(token, environment));
  }

  async capture(user: GitHubUser, grantRevision = issueOAuthGrantRevision()): Promise<boolean> {
    if (!user.accessToken || !user.oauthSource) return false;
    if (!await this.database.schema.hasTable('github_user_grants')) return false;
    const accessToken = assertUserToken(user.accessToken);
    const values = {
      github_user_id: user.id,
      github_username: user.username,
      source: user.oauthSource,
      access_token_encrypted: encryptToken(accessToken, this.environment),
      refresh_token_encrypted: user.refreshToken
        ? encryptToken(user.refreshToken.trim(), this.environment)
        : null,
      access_token_expires_at_ms: user.tokenExpiresAt ?? null,
      refresh_token_expires_at_ms: user.refreshTokenExpiresAt ?? null,
      status: 'active' as const,
      last_error_code: null,
      grant_revision: grantRevision,
      login_revision: grantRevision,
      updated_at: this.database.fn.now(),
      ...await this.renewer.captureColumns(user),
    };
    await this.database('github_user_grants')
      .insert({ ...values, created_at: this.database.fn.now() })
      .onConflict('github_user_id')
      .merge(values);
    return true;
  }

  async updateIfOwner(
    user: GitHubUser,
    expected?: { accessToken?: string; refreshToken?: string },
  ): Promise<boolean> {
    if (!await this.database.schema.hasTable('github_user_grants')) return false;
    const existing = await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: user.id })
      .first();
    if (!existing) return false;
    if (expected) {
      try {
        const currentAccessToken = decryptToken(existing.access_token_encrypted, this.environment);
        const currentRefreshToken = existing.refresh_token_encrypted
          ? decryptToken(existing.refresh_token_encrypted, this.environment)
          : undefined;
        if (
          currentAccessToken !== expected.accessToken
          || currentRefreshToken !== expected.refreshToken
        ) return false;
      } catch {
        return false;
      }
    }
    return this.storeIfCurrent(existing, user);
  }

  async resolve(githubUserId: string, forceRefresh = false): Promise<GitHubUserGrantResolution> {
    if (!await this.database.schema.hasTable('github_user_grants')) return { status: 'missing' };
    let row = await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: githubUserId })
      .first();
    if (!row) return { status: 'missing' };

    const sharedResolution = await this.resolveSharedGrant(row, forceRefresh);
    if (sharedResolution) return sharedResolution;
    if (row.status !== 'active') return reauthRequired(row);
    if (isRelayRenewable(row)) {
      const current = await this.renewer.renewIfDue(row, forceRefresh);
      if (typeof current === 'string') return { status: current };
      return current.status === 'active' ? this.resolutionFromRow(current) : reauthRequired(current);
    }

    const expiresAt = timestamp(row.access_token_expires_at_ms);
    const needsRefresh = forceRefresh || (expiresAt !== undefined && expiresAt - Date.now() < REFRESH_BUFFER_MS);
    if (needsRefresh) {
      if (!row.refresh_token_encrypted) {
        const marked = await this.markReauthRequiredIfCurrent(row, 'missing_refresh_token');
        if (marked) return { status: 'reauth_required', reason: 'missing_refresh_token' };
        return this.resolveCurrentRow(githubUserId);
      }
      const refreshed = await this.refreshOnce(row);
      if (refreshed !== 'refreshed') return { status: refreshed };
      row = await this.database<GrantRow>('github_user_grants')
        .where({ github_user_id: githubUserId })
        .first();
      if (!row) return { status: 'reauth_required' };
      if (row.status !== 'active') return reauthRequired(row);
    }

    return this.resolutionFromRow(row);
  }


  private async refreshOnce(row: GrantRow): Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'> {
    const existing = this.refreshes.get(row.github_user_id);
    if (existing) return existing;
    const pending = this.refresh(row).finally(() => this.refreshes.delete(row.github_user_id));
    this.refreshes.set(row.github_user_id, pending);
    return pending;
  }

  private async refresh(row: GrantRow): Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'> {
    try {
      const refreshToken = decryptToken(row.refresh_token_encrypted!, this.environment);
      const response = await this.requestRefresh(row.source, refreshToken);
      if (response.error) {
        if (isUnrecoverableRefreshError(response.error)) {
          const marked = await this.markReauthRequiredIfCurrent(row, response.error);
          return marked ? 'reauth_required' : 'refreshed';
        }
        return 'temporarily_unavailable';
      }
      if (!response.access_token) return 'temporarily_unavailable';
      const now = Date.now();
      await this.storeIfCurrent(row, {
        id: row.github_user_id,
        login: row.github_username,
        username: row.github_username,
        displayName: row.github_username,
        email: null,
        avatarUrl: null,
        oauthSource: row.source,
        accessToken: response.access_token,
        refreshToken: response.refresh_token || refreshToken,
        tokenExpiresAt: response.expires_in ? now + response.expires_in * 1000 : undefined,
        refreshTokenExpiresAt: response.refresh_token_expires_in
          ? now + response.refresh_token_expires_in * 1000
          : timestamp(row.refresh_token_expires_at_ms),
      });
      return 'refreshed';
    } catch (error) {
      console.warn('GitHub user grant refresh failed:', (error as Error).message);
      return 'temporarily_unavailable';
    }
  }

  private currentRowQuery(row: GrantRow) {
    let query = this.database<GrantRow>('github_user_grants')
      .where({
        github_user_id: row.github_user_id,
        access_token_encrypted: row.access_token_encrypted,
        status: row.status,
      });
    query = row.refresh_token_encrypted === null
      ? query.whereNull('refresh_token_encrypted')
      : query.andWhere({ refresh_token_encrypted: row.refresh_token_encrypted });
    return query;
  }

  private async storeIfCurrent(
    row: GrantRow,
    user: GitHubUser,
    grantRevision = issueOAuthGrantRevision(row.grant_revision),
    loginRevision = Number(row.login_revision),
  ): Promise<boolean> {
    const accessToken = assertUserToken(user.accessToken || '');
    const values = {
      github_username: user.username,
      source: user.oauthSource || row.source,
      access_token_encrypted: encryptToken(accessToken, this.environment),
      refresh_token_encrypted: user.refreshToken
        ? encryptToken(user.refreshToken.trim(), this.environment)
        : null,
      access_token_expires_at_ms: user.tokenExpiresAt ?? null,
      refresh_token_expires_at_ms: user.refreshTokenExpiresAt ?? null,
      status: 'active' as const,
      last_error_code: null,
      grant_revision: grantRevision,
      login_revision: loginRevision,
      updated_at: this.database.fn.now(),
    };
    return Number(await this.currentRowQuery(row).update(values)) === 1;
  }

  private async markReauthRequiredIfCurrent(row: GrantRow, errorCode: string): Promise<boolean> {
    return Number(await this.currentRowQuery(row)
      .update({
        status: 'reauth_required',
        last_error_code: errorCode.slice(0, 64),
        updated_at: this.database.fn.now(),
      })) === 1;
  }

  private async resolveCurrentRow(githubUserId: string): Promise<GitHubUserGrantResolution> {
    const current = await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: githubUserId })
      .first();
    if (!current) return { status: 'reauth_required' };
    if (current.status !== 'active') return reauthRequired(current);
    return this.resolutionFromRow(current);
  }

  private async resolutionFromRow(row: GrantRow): Promise<GitHubUserGrantResolution> {
    try {
      return {
        status: 'active',
        accessToken: assertUserToken(decryptToken(row.access_token_encrypted, this.environment)),
        refreshToken: row.refresh_token_encrypted
          ? decryptToken(row.refresh_token_encrypted, this.environment)
          : undefined,
        tokenExpiresAt: timestamp(row.access_token_expires_at_ms),
        refreshTokenExpiresAt: timestamp(row.refresh_token_expires_at_ms),
      };
    } catch (error) {
      await this.markReauthRequiredIfCurrent(row, 'decryption_failed');
      console.error('Could not decrypt GitHub user grant:', error);
      return { status: 'reauth_required' };
    }
  }

  private async resolveSharedGrant(
    row: GrantRow,
    forceRefresh: boolean,
  ): Promise<GitHubUserGrantResolution | null> {
    if (!this.sharedOAuthGrant) return null;
    try {
      const currentResolution = await this.resolutionFromRow(row);
      if (this.sharedOAuthGrant.getForOwner) {
        const currentShared = await this.sharedOAuthGrant.getForOwner(row.github_user_id);
        if (this.shouldIgnoreSharedGrant(row, currentResolution, currentShared)) return null;
      }
      const shared = await this.sharedOAuthGrant.refreshAndGetForOwner(row.github_user_id, forceRefresh);
      if (!shared) return null;
      if (shared.status === 'reauth_required') {
        // Preview persistence is optional during login. A stale invalid row
        // must not invalidate a newer per-user grant.
        return null;
      }
      if (!shared.accessToken) return { status: 'temporarily_unavailable' };
      if (
        row.status === 'active'
        && currentResolution.status === 'active'
        && this.grantsMatch(currentResolution, shared)
      ) {
        return currentResolution;
      }
      const sharedRevision = Number(shared.grantRevision);
      if (!this.isSharedGrantNewer(row, shared)) return null;
      const stored = await this.storeIfCurrent(row, {
        id: row.github_user_id,
        login: row.github_username,
        username: row.github_username,
        displayName: row.github_username,
        email: null,
        avatarUrl: null,
        oauthSource: row.source,
        accessToken: shared.accessToken,
        refreshToken: shared.refreshToken,
        tokenExpiresAt: shared.accessTokenExpiresAt,
        refreshTokenExpiresAt: shared.refreshTokenExpiresAt,
      }, sharedRevision, Number(shared.loginRevision));
      return stored
        ? {
            status: 'active',
            accessToken: assertUserToken(shared.accessToken),
            refreshToken: shared.refreshToken,
            tokenExpiresAt: shared.accessTokenExpiresAt,
            refreshTokenExpiresAt: shared.refreshTokenExpiresAt,
          }
        : this.resolveCurrentRow(row.github_user_id);
    } catch (error) {
      console.warn('Shared GitHub OAuth grant refresh failed:', (error as Error).message);
      const expiresAt = timestamp(row.access_token_expires_at_ms);
      return !forceRefresh && expiresAt !== undefined && expiresAt > Date.now()
        ? null
        : { status: 'temporarily_unavailable' };
    }
  }

  private grantsMatch(
    durable: Extract<GitHubUserGrantResolution, { status: 'active' }>,
    shared: VisualPreviewOAuthCredentialGrant,
  ): boolean {
    return durable.accessToken === shared.accessToken
      && durable.refreshToken === shared.refreshToken
      && durable.tokenExpiresAt === shared.accessTokenExpiresAt
      && durable.refreshTokenExpiresAt === shared.refreshTokenExpiresAt;
  }

  private shouldIgnoreSharedGrant(
    row: GrantRow,
    durable: GitHubUserGrantResolution,
    shared: VisualPreviewOAuthCredentialGrant | null,
  ): boolean {
    if (durable.status !== 'active' || shared?.status !== 'active' || !shared.accessToken) return false;
    return !this.grantsMatch(durable, shared) && !this.isSharedGrantNewer(row, shared);
  }

  private isSharedGrantNewer(row: GrantRow, shared: VisualPreviewOAuthCredentialGrant): boolean {
    const durableRevision = Number(row.grant_revision);
    const sharedRevision = Number(shared.grantRevision);
    const durableLoginRevision = Number(row.login_revision);
    const sharedLoginRevision = Number(shared.loginRevision);
    if (![
      durableRevision, sharedRevision, durableLoginRevision, sharedLoginRevision,
    ].every(Number.isSafeInteger)) return false;
    return sharedLoginRevision === durableLoginRevision
      ? sharedRevision > durableRevision
      : sharedLoginRevision > durableLoginRevision;
  }

  private async requestRefresh(source: GrantRow['source'], refreshToken: string): Promise<RefreshResponse> {
    let endpoint: string;
    let headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    let body: Record<string, string>;
    if (source === 'connect') {
      const relayUrl = this.environment.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
      const relayToken = this.environment.PROPR_GH_RELAY_TOKEN?.trim();
      if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for GitHub reauthorization');
      const refreshUrl = new URL(`${relayUrl}/auth/instance-grants/refresh`);
      if (refreshUrl.protocol !== 'https:' && refreshUrl.hostname !== 'localhost' && refreshUrl.hostname !== '127.0.0.1') {
        throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
      }
      endpoint = refreshUrl.toString();
      headers = { ...headers, authorization: `Bearer ${relayToken}` };
      body = { refresh_token: refreshToken };
    } else {
      const clientId = this.environment.GH_OAUTH_CLIENT_ID?.trim();
      const clientSecret = this.environment.GH_OAUTH_CLIENT_SECRET?.trim();
      if (!clientId || !clientSecret) throw new Error('GitHub OAuth client credentials are unavailable for token refresh');
      endpoint = 'https://github.com/login/oauth/access_token';
      body = { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken };
    }
    const response = await this.fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub user grant refresh failed with HTTP ${response.status}`);
    return response.json() as Promise<RefreshResponse>;
  }
}

export const githubUserGrantService = new GitHubUserGrantService(
  db,
  process.env,
  fetch,
  visualPreviewOAuthCredentialService,
);
