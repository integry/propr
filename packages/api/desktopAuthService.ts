/* eslint-disable max-lines -- pairing and token state transitions are kept together for transactional review */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { parseProprConnectEndpoint } from '@propr/shared';
import type { GitHubUser } from './authTypes.js';

const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const RETAIN_FINISHED_PAIRINGS_MS = 24 * 60 * 60_000;
export const INSTANCE_TOKEN_PREFIX = 'propr_it_';

type PairingStatus = 'pending' | 'approved' | 'consumed';

interface PairingRow {
  id: string;
  device_secret_hash: string;
  client_name: string;
  status: PairingStatus;
  approved_by_user_id: string | null;
  approved_by_username: string | null;
  approved_by_display_name: string | null;
  approved_by_email: string | null;
  approved_by_avatar_url: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  consumed_at: string | null;
}

interface TokenRow {
  id: string;
  token_hash: string;
  token_hint: string;
  name: string;
  owner_github_user_id: string;
  owner_github_username: string;
  owner_display_name: string;
  owner_email: string | null;
  owner_avatar_url: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
}

export interface DesktopPairingStart {
  pairingId: string;
  deviceSecret: string;
  approvalUrl: string;
  expiresAt: string;
  interval: number;
}

export interface DesktopPairingApproval {
  pairingId: string;
  clientName: string;
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
}

export type DesktopPairingPoll =
  | { status: 'pending'; interval: number }
  | { status: 'complete'; token: string; tokenType: 'Bearer'; expiresAt: string | null };

export interface DesktopTokenSummary {
  id: string;
  name: string;
  tokenHint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface InstanceTokenIdentity {
  tokenId: string;
  user: GitHubUser;
}

export class DesktopAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopAuthError';
  }
}

export interface DesktopAuthServiceOptions {
  database?: Knex;
  now?: () => Date;
  pairingTtlMs?: number;
  tokenTtlMs?: number | null;
  approvalBaseUrl?: string;
  publicApiUrl?: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function opaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function validClientName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DesktopAuthError('INVALID_CLIENT_NAME', 400, 'clientName must be a string');
  }
  if ([...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })) {
    throw new DesktopAuthError('INVALID_CLIENT_NAME', 400, 'clientName must contain 1 to 80 printable characters');
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 80) {
    throw new DesktopAuthError('INVALID_CLIENT_NAME', 400, 'clientName must contain 1 to 80 printable characters');
  }
  return normalized;
}

function validPairingId(value: string): void {
  if (!/^dpr_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
  }
}

function requireDeviceSecret(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
  }
  return value;
}

function frontendApprovalBase(configured?: string): URL {
  const raw = configured ?? process.env.FRONTEND_URL;
  if (!raw) throw new Error('FRONTEND_URL is required for desktop pairing');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))) {
    throw new Error('Desktop pairing approval requires HTTPS except on loopback hosts');
  }
  if (url.username || url.password) throw new Error('FRONTEND_URL must not contain credentials');
  return url;
}

function publicApiBase(configured?: string): URL | null {
  const raw = configured ?? process.env.API_PUBLIC_URL;
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))) {
    throw new Error('Desktop pairing browser entry requires HTTPS except on loopback hosts');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('API_PUBLIC_URL must be an origin without credentials, a path, query, or fragment');
  }
  return url;
}

function tokenSummary(row: TokenRow): DesktopTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenHint: row.token_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function configuredTokenTtlMs(): number | null {
  const configured = process.env.PROPR_DESKTOP_TOKEN_TTL_DAYS?.trim();
  if (!configured) return null;
  const days = Number(configured);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 3650) {
    throw new Error('PROPR_DESKTOP_TOKEN_TTL_DAYS must be an integer from 1 to 3650');
  }
  return days * 24 * 60 * 60_000;
}

export class DesktopAuthService {
  private readonly database: Knex;
  private readonly now: () => Date;
  private readonly pairingTtlMs: number;
  private readonly tokenTtlMs: number | null;
  private readonly approvalBaseUrl?: string;
  private readonly publicApiUrl?: string;

  constructor(options: DesktopAuthServiceOptions = {}) {
    this.database = options.database ?? db;
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs === undefined ? configuredTokenTtlMs() : options.tokenTtlMs;
    this.approvalBaseUrl = options.approvalBaseUrl;
    this.publicApiUrl = options.publicApiUrl;
  }

  async startPairing(clientNameInput: unknown): Promise<DesktopPairingStart> {
    const clientName = validClientName(clientNameInput);
    const pairingId = `dpr_${opaqueValue(16)}`;
    const deviceSecret = opaqueValue();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.pairingTtlMs);
    const apiApprovalUrl = publicApiBase(this.publicApiUrl);
    const approvalUrl = apiApprovalUrl ?? this.getFrontendApprovalUrl(pairingId);
    if (apiApprovalUrl) {
      approvalUrl.pathname = `${approvalUrl.pathname.replace(/\/$/, '')}/api/desktop/pairings/${pairingId}/browser`;
      approvalUrl.search = '';
      approvalUrl.hash = '';
    }

    await this.database<PairingRow>('desktop_pairing_requests').insert({
      id: pairingId,
      device_secret_hash: digest(deviceSecret),
      client_name: clientName,
      status: 'pending',
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    await this.audit('pairing_started', { pairingId, clientName });

    return {
      pairingId,
      deviceSecret,
      approvalUrl: approvalUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      interval: DEFAULT_POLL_INTERVAL_SECONDS,
    };
  }

  getFrontendApprovalUrl(pairingId: string): URL {
    validPairingId(pairingId);
    const approvalUrl = frontendApprovalBase(this.approvalBaseUrl);
    approvalUrl.pathname = `${approvalUrl.pathname.replace(/\/$/, '')}/desktop/pairing`;
    approvalUrl.search = '';
    approvalUrl.hash = '';
    approvalUrl.searchParams.set('pairing_id', pairingId);
    const connectEndpoint = parseProprConnectEndpoint(
      this.publicApiUrl ?? process.env.API_PUBLIC_URL,
    );
    if (approvalUrl.origin === 'https://app.propr.dev' && connectEndpoint) {
      approvalUrl.searchParams.set('tunnel', connectEndpoint.hostname);
    }
    return approvalUrl;
  }

  async getPairingForApproval(pairingId: string): Promise<DesktopPairingApproval> {
    const row = await this.activePairing(pairingId);
    return {
      pairingId: row.id,
      clientName: row.client_name,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async approvePairing(pairingId: string, user: GitHubUser): Promise<DesktopPairingApproval> {
    validPairingId(pairingId);
    const approvedAt = this.now().toISOString();
    const updated = await this.database<PairingRow>('desktop_pairing_requests')
      .where({ id: pairingId, status: 'pending' })
      .andWhere('expires_at', '>', approvedAt)
      .update({
        status: 'approved',
        approved_by_user_id: user.id,
        approved_by_username: user.username,
        approved_by_display_name: user.displayName || user.username,
        approved_by_email: user.email,
        approved_by_avatar_url: user.avatarUrl,
        approved_at: approvedAt,
      });
    if (updated !== 1) {
      const current = await this.database<PairingRow>('desktop_pairing_requests').where({ id: pairingId }).first();
      if (current?.status === 'approved' && current.approved_by_user_id === user.id && current.expires_at > approvedAt) {
        return this.getPairingForApproval(pairingId);
      }
      if (current?.status === 'consumed') {
        throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
      }
      throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found or has expired');
    }
    const result = await this.getPairingForApproval(pairingId);
    await this.audit('pairing_approved', {
      pairingId,
      clientName: result.clientName,
      actor: user,
    });
    return result;
  }

  async pollPairing(pairingId: string, secretInput: unknown): Promise<DesktopPairingPoll> {
    validPairingId(pairingId);
    const deviceSecret = requireDeviceSecret(secretInput);
    const now = this.now();
    const nowIso = now.toISOString();

    return this.database.transaction(async transaction => {
      const row = await transaction<PairingRow>('desktop_pairing_requests')
        .where({ id: pairingId, device_secret_hash: digest(deviceSecret) })
        .first();
      if (!row) throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
      if (row.expires_at <= nowIso) throw new DesktopAuthError('PAIRING_EXPIRED', 410, 'Pairing request has expired');
      if (row.status === 'pending') return { status: 'pending', interval: DEFAULT_POLL_INTERVAL_SECONDS };
      if (row.status === 'consumed') {
        throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
      }
      if (!row.approved_by_user_id || !row.approved_by_username) {
        throw new DesktopAuthError('PAIRING_INVALID_STATE', 409, 'Pairing request cannot be completed');
      }

      const token = `${INSTANCE_TOKEN_PREFIX}${opaqueValue()}`;
      const tokenId = randomUUID();
      const tokenExpiresAt = this.tokenTtlMs === null
        ? null
        : new Date(now.getTime() + this.tokenTtlMs).toISOString();
      await transaction<TokenRow>('instance_api_tokens').insert({
        id: tokenId,
        token_hash: digest(token),
        token_hint: token.slice(-8),
        name: row.client_name,
        owner_github_user_id: row.approved_by_user_id,
        owner_github_username: row.approved_by_username,
        owner_display_name: row.approved_by_display_name || row.approved_by_username,
        owner_email: row.approved_by_email,
        owner_avatar_url: row.approved_by_avatar_url,
        created_at: nowIso,
        expires_at: tokenExpiresAt,
      });
      const consumed = await transaction<PairingRow>('desktop_pairing_requests')
        .where({ id: pairingId, status: 'approved', device_secret_hash: digest(deviceSecret) })
        .update({ status: 'consumed', consumed_at: nowIso });
      if (consumed !== 1) {
        throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
      }
      await this.audit('token_issued', {
        pairingId,
        tokenId,
        clientName: row.client_name,
        actor: { id: row.approved_by_user_id, username: row.approved_by_username },
      }, transaction);
      return { status: 'complete', token, tokenType: 'Bearer', expiresAt: tokenExpiresAt };
    });
  }

  async validateToken(token: string): Promise<InstanceTokenIdentity | null> {
    if (!token.startsWith(INSTANCE_TOKEN_PREFIX) || token.length !== INSTANCE_TOKEN_PREFIX.length + 43) return null;
    const nowIso = this.now().toISOString();
    const row = await this.database<TokenRow>('instance_api_tokens')
      .where({ token_hash: digest(token) })
      .whereNull('revoked_at')
      .andWhere(builder => builder.whereNull('expires_at').orWhere('expires_at', '>', nowIso))
      .first();
    if (!row) return null;

    await this.database<TokenRow>('instance_api_tokens')
      .where({ id: row.id })
      .whereNull('revoked_at')
      .update({ last_used_at: nowIso });
    return {
      tokenId: row.id,
      user: {
        id: row.owner_github_user_id,
        login: row.owner_github_username,
        username: row.owner_github_username,
        displayName: row.owner_display_name,
        email: row.owner_email,
        avatarUrl: row.owner_avatar_url,
      },
    };
  }

  async listTokens(ownerUserId: string): Promise<DesktopTokenSummary[]> {
    const rows = await this.database<TokenRow>('instance_api_tokens')
      .where({ owner_github_user_id: ownerUserId })
      .orderBy('created_at', 'desc');
    return rows.map(tokenSummary);
  }

  async revokeToken(tokenId: string, actor: GitHubUser): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(tokenId)) {
      throw new DesktopAuthError('TOKEN_NOT_FOUND', 404, 'Token was not found');
    }
    const revokedAt = this.now().toISOString();
    const updated = await this.database<TokenRow>('instance_api_tokens')
      .where({ id: tokenId, owner_github_user_id: actor.id })
      .whereNull('revoked_at')
      .update({ revoked_at: revokedAt, revoked_by_user_id: actor.id });
    if (updated !== 1) throw new DesktopAuthError('TOKEN_NOT_FOUND', 404, 'Active token was not found');
    await this.audit('token_revoked', { tokenId, actor });
  }

  async cleanupPairings(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - RETAIN_FINISHED_PAIRINGS_MS).toISOString();
    return this.database<PairingRow>('desktop_pairing_requests')
      .where('expires_at', '<', cutoff)
      .delete();
  }

  private async activePairing(pairingId: string): Promise<PairingRow> {
    validPairingId(pairingId);
    const nowIso = this.now().toISOString();
    const row = await this.database<PairingRow>('desktop_pairing_requests')
      .where({ id: pairingId })
      .andWhere('expires_at', '>', nowIso)
      .first();
    if (!row) throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found or has expired');
    return row;
  }

  private async audit(
    action: string,
    details: {
      actor?: Pick<GitHubUser, 'id' | 'username'>;
      pairingId?: string;
      tokenId?: string;
      clientName?: string;
    },
    database: Knex | Knex.Transaction = this.database,
  ): Promise<void> {
    await database('desktop_auth_audit').insert({
      action,
      actor_github_user_id: details.actor?.id ?? null,
      actor_github_username: details.actor?.username ?? null,
      pairing_id: details.pairingId ?? null,
      token_id: details.tokenId ?? null,
      client_name: details.clientName ?? null,
      created_at: this.now().toISOString(),
    });
    console.info('[desktop-auth]', {
      action,
      actorUserId: details.actor?.id,
      pairingId: details.pairingId,
      tokenId: details.tokenId,
      clientName: details.clientName,
    });
  }
}

export const desktopAuthService = new DesktopAuthService();
