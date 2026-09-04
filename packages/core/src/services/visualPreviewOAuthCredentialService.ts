/* eslint-disable max-lines -- storage, encryption, leasing, and provider refresh form one credential boundary */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db/connection.js';

const CREDENTIAL_ID = 1;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_TIMEOUT_MS = 20_000;
const REFRESH_LEASE_MS = TOKEN_REFRESH_TIMEOUT_MS + 5_000;
const REFRESH_LEASE_POLL_MS = 100;
const ENCRYPTION_CONTEXT = 'propr:visual-preview-oauth:v1';
// GitHub CLI's attachment uploader accepts OAuth App and personal-access
// tokens. It deliberately rejects both GitHub App user (`ghu_`) and
// installation (`ghs_`) tokens before making an upload request.
const SUPPORTED_TOKEN_PATTERN = /^(?:gho_|ghp_|github_pat_)/;

export const VISUAL_PREVIEW_UPLOAD_TOKEN_ENV = 'GITHUB_VISUAL_PREVIEW_TOKEN';
export const VISUAL_PREVIEW_CREDENTIAL_KEY_ENV = 'PROPR_CREDENTIAL_ENCRYPTION_KEY';

export type VisualPreviewOAuthSource = 'github' | 'connect' | 'static_token';
export type VisualPreviewOAuthStatus = 'active' | 'reauth_required';

export interface VisualPreviewOAuthCredentialInput {
  githubUserId: string;
  githubUsername: string;
  source: VisualPreviewOAuthSource;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

export interface VisualPreviewOAuthCredentialStatus {
  configured: boolean;
  source?: VisualPreviewOAuthSource | 'environment';
  status: VisualPreviewOAuthStatus | 'missing';
  githubUsername?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastErrorCode?: string;
  updatedAt?: string;
}

export interface VisualPreviewOAuthCredentialGrant {
  status: 'active' | 'reauth_required';
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

interface CredentialRow {
  id: number;
  github_user_id: string;
  github_username: string;
  source: VisualPreviewOAuthSource;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at_ms: number | string | null;
  refresh_token_expires_at_ms: number | string | null;
  status: VisualPreviewOAuthStatus;
  last_error_code: string | null;
  refresh_lease_until_ms: number | string | null;
  refresh_lease_owner: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export type VisualPreviewCredentialErrorCode =
  | 'VISUAL_PREVIEW_AUTH_MISSING'
  | 'VISUAL_PREVIEW_AUTH_UNSUPPORTED'
  | 'VISUAL_PREVIEW_AUTH_EXPIRED'
  | 'VISUAL_PREVIEW_AUTH_REAUTH_REQUIRED'
  | 'VISUAL_PREVIEW_AUTH_DECRYPTION_FAILED';

export class VisualPreviewCredentialError extends Error {
  constructor(
    public readonly code: VisualPreviewCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VisualPreviewCredentialError';
  }
}

export function isVisualPreviewCredentialError(error: unknown): error is VisualPreviewCredentialError {
  return error instanceof VisualPreviewCredentialError || (
    error instanceof Error
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('VISUAL_PREVIEW_AUTH_')
  );
}

export function isSupportedVisualPreviewUploadToken(token: string): boolean {
  return SUPPORTED_TOKEN_PATTERN.test(token.trim());
}

function optionalTimestamp(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function encryptionSecret(environment: NodeJS.ProcessEnv): string | undefined {
  return environment[VISUAL_PREVIEW_CREDENTIAL_KEY_ENV]?.trim()
    || environment.SYSTEM_TASK_SECRET?.trim()
    || environment.SESSION_SECRET?.trim();
}

function encryptionKey(environment: NodeJS.ProcessEnv): Buffer {
  const secret = encryptionSecret(environment);
  if (!secret) {
    throw new Error(
      `${VISUAL_PREVIEW_CREDENTIAL_KEY_ENV}, SYSTEM_TASK_SECRET, or SESSION_SECRET must be configured `
      + 'to store the visual-preview OAuth credential securely.',
    );
  }
  return createHash('sha256').update(ENCRYPTION_CONTEXT).update('\0').update(secret).digest();
}

function encryptToken(token: string, environment: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptToken(value: string, environment: NodeJS.ProcessEnv): string {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext] = value.split('.');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new VisualPreviewCredentialError(
      'VISUAL_PREVIEW_AUTH_DECRYPTION_FAILED',
      'The stored visual-preview OAuth credential could not be decrypted. Verify the shared credential encryption secret.',
    );
  }
}

function assertSupportedToken(token: string): string {
  const normalized = token.trim();
  if (!isSupportedVisualPreviewUploadToken(normalized)) {
    throw new VisualPreviewCredentialError(
      'VISUAL_PREVIEW_AUTH_UNSUPPORTED',
      'GitHub visual-preview uploads require an OAuth App token or personal access token; GitHub App user and installation tokens are not supported.',
    );
  }
  return normalized;
}

function resolveEnvironmentToken(environment: NodeJS.ProcessEnv): string | undefined {
  const token = environment[VISUAL_PREVIEW_UPLOAD_TOKEN_ENV]?.trim();
  return token ? assertSupportedToken(token) : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function statusFromRow(row: CredentialRow): VisualPreviewOAuthCredentialStatus {
  return {
    configured: true,
    source: row.source,
    status: row.status,
    githubUsername: row.github_username,
    accessTokenExpiresAt: optionalTimestamp(row.access_token_expires_at_ms),
    refreshTokenExpiresAt: optionalTimestamp(row.refresh_token_expires_at_ms),
    lastErrorCode: row.last_error_code || undefined,
    updatedAt: row.updated_at,
  };
}

function isUnrecoverableRefreshError(error?: string): boolean {
  return error === 'bad_refresh_token' || error === 'invalid_grant';
}

export class VisualPreviewOAuthCredentialService {
  constructor(
    private readonly database: Knex = db,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private credentialQuery() {
    return this.database<CredentialRow>('visual_preview_oauth_credentials').where({ id: CREDENTIAL_ID });
  }

  async getStatus(): Promise<VisualPreviewOAuthCredentialStatus> {
    const rawEnvironmentToken = this.environment[VISUAL_PREVIEW_UPLOAD_TOKEN_ENV]?.trim();
    if (rawEnvironmentToken) {
      return isSupportedVisualPreviewUploadToken(rawEnvironmentToken)
        ? { configured: true, source: 'environment', status: 'active' }
        : {
            configured: true,
            source: 'environment',
            status: 'reauth_required',
            lastErrorCode: 'unsupported_environment_token',
          };
    }
    const row = await this.credentialQuery().first();
    return row ? statusFromRow(row) : { configured: false, status: 'missing' };
  }

  async captureFromLogin(input: VisualPreviewOAuthCredentialInput): Promise<boolean> {
    assertSupportedToken(input.accessToken);
    const existing = await this.credentialQuery().first();
    if (existing && existing.github_user_id !== input.githubUserId && existing.status === 'active') return false;
    await this.store(input);
    return true;
  }

  async replace(input: VisualPreviewOAuthCredentialInput): Promise<void> {
    assertSupportedToken(input.accessToken);
    await this.store(input);
  }

  async updateIfOwner(input: VisualPreviewOAuthCredentialInput): Promise<boolean> {
    assertSupportedToken(input.accessToken);
    const existing = await this.credentialQuery().first();
    if (!existing || existing.github_user_id !== input.githubUserId) return false;
    await this.store(input);
    return true;
  }

  private async store(input: VisualPreviewOAuthCredentialInput): Promise<void> {
    const now = this.database.fn.now();
    const values = {
      id: CREDENTIAL_ID,
      github_user_id: input.githubUserId,
      github_username: input.githubUsername,
      source: input.source,
      access_token_encrypted: encryptToken(input.accessToken.trim(), this.environment),
      refresh_token_encrypted: input.refreshToken
        ? encryptToken(input.refreshToken.trim(), this.environment)
        : null,
      access_token_expires_at_ms: input.accessTokenExpiresAt ?? null,
      refresh_token_expires_at_ms: input.refreshTokenExpiresAt ?? null,
      status: 'active' as const,
      last_error_code: null,
      refresh_lease_until_ms: null,
      refresh_lease_owner: null,
      updated_at: now,
    };
    await this.database('visual_preview_oauth_credentials')
      .insert({ ...values, created_at: now })
      .onConflict('id')
      .merge(values);
  }

  async disconnect(): Promise<void> {
    await this.credentialQuery().delete();
  }

  async resolveUploadToken(): Promise<string> {
    const environmentToken = resolveEnvironmentToken(this.environment);
    if (environmentToken) return environmentToken;

    const row = await this.credentialQuery().first();
    if (!row) {
      throw new VisualPreviewCredentialError(
        'VISUAL_PREVIEW_AUTH_MISSING',
        'No GitHub user credential is configured for visual-preview uploads.',
      );
    }
    if (row.status !== 'active') {
      throw new VisualPreviewCredentialError(
        'VISUAL_PREVIEW_AUTH_REAUTH_REQUIRED',
        'The GitHub user credential for visual-preview uploads must be reconnected.',
      );
    }
    const expiresAt = optionalTimestamp(row.access_token_expires_at_ms);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      throw new VisualPreviewCredentialError(
        'VISUAL_PREVIEW_AUTH_EXPIRED',
        'The GitHub user credential for visual-preview uploads has expired.',
      );
    }
    return assertSupportedToken(decryptToken(row.access_token_encrypted, this.environment));
  }

  async markReauthRequired(errorCode: string): Promise<void> {
    if (this.environment[VISUAL_PREVIEW_UPLOAD_TOKEN_ENV]?.trim()) return;
    await this.credentialQuery().update({
      status: 'reauth_required',
      last_error_code: errorCode.slice(0, 64),
      refresh_lease_until_ms: null,
      refresh_lease_owner: null,
      updated_at: this.database.fn.now(),
    });
  }

  async refreshIfNeeded(force = false): Promise<'missing' | 'not-needed' | 'refreshed' | 'reauth-required'> {
    if (resolveEnvironmentToken(this.environment)) return 'not-needed';
    const row = await this.credentialQuery().first();
    if (!row) return 'missing';
    if (row.status !== 'active') return 'reauth-required';

    const expiresAt = optionalTimestamp(row.access_token_expires_at_ms);
    const needsRefresh = force || (expiresAt !== undefined && expiresAt - Date.now() < ACCESS_TOKEN_REFRESH_BUFFER_MS);
    if (!needsRefresh) return 'not-needed';
    if (!row.refresh_token_encrypted) {
      await this.markReauthRequired('missing_refresh_token');
      return 'reauth-required';
    }

    const leaseOwner = randomBytes(16).toString('hex');
    const leaseAcquired = await this.database<CredentialRow>('visual_preview_oauth_credentials')
      .where({ id: CREDENTIAL_ID, status: 'active' })
      .andWhere(builder => builder
        .whereNull('refresh_lease_until_ms')
        .orWhere('refresh_lease_until_ms', '<', Date.now()))
      .update({
        refresh_lease_owner: leaseOwner,
        refresh_lease_until_ms: Date.now() + REFRESH_LEASE_MS,
      });
    if (leaseAcquired === 0) {
      await this.waitForRefreshLease();
      const refreshedRow = await this.credentialQuery().first();
      if (!refreshedRow) return 'missing';
      if (refreshedRow.status !== 'active') return 'reauth-required';
      const refreshedExpiry = optionalTimestamp(refreshedRow.access_token_expires_at_ms);
      if (refreshedExpiry !== undefined && refreshedExpiry - Date.now() < ACCESS_TOKEN_REFRESH_BUFFER_MS) {
        throw new Error('Concurrent GitHub OAuth refresh did not produce a usable access token');
      }
      return 'not-needed';
    }

    try {
      const refreshToken = decryptToken(row.refresh_token_encrypted, this.environment);
      const response = await this.requestRefresh(row.source, refreshToken);
      if (response.error) {
        if (isUnrecoverableRefreshError(response.error)) {
          await this.markReauthRequired(response.error);
          return 'reauth-required';
        }
        throw new Error(`GitHub OAuth refresh was temporarily unavailable (${response.error})`);
      }
      if (!response.access_token) throw new Error('GitHub OAuth refresh response did not include an access token');

      const now = Date.now();
      await this.store({
        githubUserId: row.github_user_id,
        githubUsername: row.github_username,
        source: row.source,
        accessToken: response.access_token,
        refreshToken: response.refresh_token || refreshToken,
        accessTokenExpiresAt: response.expires_in ? now + response.expires_in * 1000 : undefined,
        refreshTokenExpiresAt: response.refresh_token_expires_in
          ? now + response.refresh_token_expires_in * 1000
          : optionalTimestamp(row.refresh_token_expires_at_ms),
      });
      await this.credentialQuery().update({ last_refreshed_at: this.database.fn.now() });
      return 'refreshed';
    } finally {
      await this.database<CredentialRow>('visual_preview_oauth_credentials')
        .where({ id: CREDENTIAL_ID, refresh_lease_owner: leaseOwner })
        .update({ refresh_lease_owner: null, refresh_lease_until_ms: null });
    }
  }

  async refreshAndGetForOwner(
    githubUserId: string,
    force = false,
  ): Promise<VisualPreviewOAuthCredentialGrant | null> {
    const current = await this.credentialQuery().first();
    if (!current || current.github_user_id !== githubUserId) return null;
    // A manually supplied or CLI-imported token is dedicated to background
    // preview uploads. Never copy it into the administrator's browser session
    // or try to refresh it as an OAuth grant.
    if (current.source === 'static_token') return null;
    const refreshStatus = await this.refreshIfNeeded(force);
    if (refreshStatus === 'reauth-required') return { status: 'reauth_required' };
    const row = await this.credentialQuery().first();
    if (!row || row.github_user_id !== githubUserId) return null;
    if (row.status !== 'active') return { status: 'reauth_required' };
    return {
      status: 'active',
      accessToken: decryptToken(row.access_token_encrypted, this.environment),
      refreshToken: row.refresh_token_encrypted
        ? decryptToken(row.refresh_token_encrypted, this.environment)
        : undefined,
      accessTokenExpiresAt: optionalTimestamp(row.access_token_expires_at_ms),
      refreshTokenExpiresAt: optionalTimestamp(row.refresh_token_expires_at_ms),
    };
  }

  private async waitForRefreshLease(): Promise<void> {
    const deadline = Date.now() + REFRESH_LEASE_MS;
    while (Date.now() < deadline) {
      const row = await this.credentialQuery().first();
      if (!row?.refresh_lease_owner || (optionalTimestamp(row.refresh_lease_until_ms) || 0) <= Date.now()) return;
      await delay(REFRESH_LEASE_POLL_MS);
    }
  }

  private async requestRefresh(source: VisualPreviewOAuthSource, refreshToken: string): Promise<TokenRefreshResponse> {
    if (source === 'connect') return this.requestConnectRefresh(refreshToken);
    const clientId = this.environment.GH_OAUTH_CLIENT_ID?.trim();
    const clientSecret = this.environment.GH_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('GitHub OAuth client credentials are unavailable for token refresh');
    return this.postRefresh('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async requestConnectRefresh(refreshToken: string): Promise<TokenRefreshResponse> {
    const relayUrl = this.environment.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
    const relayToken = this.environment.PROPR_GH_RELAY_TOKEN?.trim();
    if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for token refresh');
    const endpoint = new URL(`${relayUrl}/auth/instance-grants/refresh`);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
      throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
    }
    return this.postRefresh(endpoint, { refresh_token: refreshToken }, relayToken);
  }

  private async postRefresh(
    endpoint: string | URL,
    body: Record<string, string>,
    bearerToken?: string,
  ): Promise<TokenRefreshResponse> {
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub OAuth refresh failed with HTTP ${response.status}`);
    return response.json() as Promise<TokenRefreshResponse>;
  }
}

const defaultService = new VisualPreviewOAuthCredentialService();

export function resolveVisualPreviewUploadToken(): Promise<string> {
  return defaultService.resolveUploadToken();
}

export function refreshVisualPreviewOAuthCredential(force = false) {
  return defaultService.refreshIfNeeded(force);
}

export function markVisualPreviewOAuthCredentialReauthRequired(errorCode: string): Promise<void> {
  return defaultService.markReauthRequired(errorCode);
}
