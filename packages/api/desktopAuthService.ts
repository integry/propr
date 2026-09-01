/* eslint-disable max-lines -- pairing and token state transitions are kept together for transactional review */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import {
  canonicalProprHttpUrlOrigin,
  canonicalProprProxyUrl,
  isProprConnectReservedHostAttempt,
  MAX_PROPR_API_BASE_URL_LENGTH,
  normalizeProprApiOrigin,
  parseProprConnectEndpoint,
} from '@propr/shared';
import type { GitHubUser } from './authTypes.js';

const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_PROVISIONAL_TTL_MS = 2 * 60_000;
const RETAIN_FINISHED_PAIRINGS_MS = 24 * 60 * 60_000;
export const INSTANCE_TOKEN_PREFIX = 'propr_it_';
export const DESKTOP_INSTANCE_SCOPE = 'desktop-instance';

type PairingStatus = 'pending' | 'approved' | 'consumed' | 'cancelled';

interface PairingRow {
  id: string;
  device_secret_hash: string;
  client_name: string;
  status: PairingStatus;
  requested_instance_id: string;
  requested_origin: string;
  requested_scope: string;
  credential_generation: string;
  provisional_token_id: string | null;
  activation_ticket_hash: string | null;
  activation_receipt: string | null;
  activation_expires_at: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
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
  activation_state: 'provisional' | 'active';
  pairing_id: string;
  bound_instance_id: string;
  bound_origin: string;
  bound_scope: string;
  credential_generation: string;
}

export interface DesktopPairingBinding {
  instanceId: string;
  origin: string;
  scope: typeof DESKTOP_INSTANCE_SCOPE;
  credentialGeneration: string;
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
  | ({
    status: 'provisional';
    token: string;
    tokenType: 'Bearer';
    activationTicket: string;
    activationExpiresAt: string;
  } & DesktopPairingBinding);

export interface DesktopPairingActivation extends DesktopPairingBinding {
  deviceSecret: string;
  activationTicket: string;
}

export interface DesktopPairingActivationReceipt {
  status: 'active';
  receipt: string;
  activatedAt: string;
  expiresAt: string | null;
}

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

export type PresentedTokenRevocation =
  | { revoked: true }
  | { revoked: false; code: 'TOKEN_NOT_FOUND' | 'INSTANCE_TOKEN_REVOKED' | 'INSTANCE_TOKEN_EXPIRED' };

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
  provisionalTtlMs?: number;
  approvalBaseUrl?: string;
  publicApiUrl?: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function opaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function derivePairingValue(secret: string, purpose: string, row: PairingRow): string {
  return createHmac('sha256', secret).update(JSON.stringify({
    purpose,
    pairingId: row.id,
    instanceId: row.requested_instance_id,
    origin: row.requested_origin,
    scope: row.requested_scope,
    credentialGeneration: row.credential_generation,
  })).digest('base64url');
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

function validBinding(value: unknown): DesktopPairingBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesktopAuthError('INVALID_PAIRING_BINDING', 400, 'Desktop pairing binding is invalid');
  }
  const input = value as Record<string, unknown>;
  const origin = typeof input.origin === 'string' ? normalizeProprApiOrigin(input.origin) : null;
  if (typeof input.instanceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.instanceId)
    || origin === null || origin !== input.origin
    || input.scope !== DESKTOP_INSTANCE_SCOPE
    || typeof input.credentialGeneration !== 'string'
    || !/^[A-Za-z0-9_-]{22}$/.test(input.credentialGeneration)) {
    throw new DesktopAuthError('INVALID_PAIRING_BINDING', 400, 'Desktop pairing binding is invalid');
  }
  return {
    instanceId: input.instanceId,
    origin,
    scope: DESKTOP_INSTANCE_SCOPE,
    credentialGeneration: input.credentialGeneration,
  };
}

function rowBinding(row: PairingRow): DesktopPairingBinding {
  return {
    instanceId: row.requested_instance_id,
    origin: row.requested_origin,
    scope: DESKTOP_INSTANCE_SCOPE,
    credentialGeneration: row.credential_generation,
  };
}

function sameBinding(row: PairingRow, binding: DesktopPairingBinding): boolean {
  return row.requested_instance_id === binding.instanceId
    && row.requested_origin === binding.origin
    && row.requested_scope === binding.scope
    && row.credential_generation === binding.credentialGeneration;
}

function frontendApprovalBase(configured?: string): URL {
  const raw = configured ?? process.env.FRONTEND_URL;
  if (!raw) throw new Error('FRONTEND_URL is required for desktop pairing');
  const url = new URL(raw);
  if (canonicalProprHttpUrlOrigin(raw) !== url.origin) {
    throw new Error('Desktop pairing approval requires HTTPS except on loopback hosts');
  }
  if (url.username || url.password) throw new Error('FRONTEND_URL must not contain credentials');
  return url;
}

interface PublicApiBase {
  url: URL;
  managedSelector: string | null;
}

// The validation branches below intentionally keep every reserved-namespace
// rejection at this single trust boundary.
// eslint-disable-next-line complexity
function publicApiBase(configured?: string): PublicApiBase | null {
  const raw = configured ?? process.env.API_PUBLIC_URL;
  if (!raw) return null;
  if (raw.length > MAX_PROPR_API_BASE_URL_LENGTH) {
    throw new DesktopAuthError(
      'PAIRING_CONFIGURATION_INVALID',
      503,
      'Desktop pairing is unavailable because the public API URL is invalid',
    );
  }
  const canonicalConnectEndpoint = parseProprConnectEndpoint(raw);
  if (isProprConnectReservedHostAttempt(raw) && !canonicalConnectEndpoint) {
    throw new DesktopAuthError(
      'PAIRING_CONFIGURATION_INVALID',
      503,
      'Desktop pairing is unavailable because the public API URL is invalid',
    );
  }
  const url = new URL(raw);
  if (normalizeProprApiOrigin(raw) !== url.origin) {
    throw new Error('Desktop pairing browser entry requires HTTPS except on loopback hosts');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('API_PUBLIC_URL must be an origin without credentials, a path, query, or fragment');
  }
  const canonicalManagedUrl = canonicalProprProxyUrl(raw);
  const normalizedHostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const managedLabelInProprNamespace = normalizedHostname.endsWith('.propr.dev')
    && normalizedHostname.split('.').slice(0, -2).some(label => label.startsWith('t-'));
  const rawAuthority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0]?.split('@').pop()?.toLowerCase() ?? '';
  const rawHostname = rawAuthority.replace(/:\d+$/, '').replace(/\.$/, '');
  const rawHostnameLabels = rawHostname.split('.');
  const rawManagedLabelInProprNamespace = rawHostnameLabels[0]?.startsWith('t-') === true
    && rawHostnameLabels.at(-2) === 'propr'
    && rawHostnameLabels.at(-1) === 'dev';
  const claimsManagedNamespace = (
    managedLabelInProprNamespace
  ) || (
    rawManagedLabelInProprNamespace
  );
  if (claimsManagedNamespace && !canonicalManagedUrl) {
    throw new Error('API_PUBLIC_URL uses a noncanonical reserved ProPR tunnel host');
  }
  return {
    url,
    managedSelector: canonicalManagedUrl ? canonicalManagedUrl.slice('https://'.length) : null,
  };
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
  private readonly provisionalTtlMs: number;
  private readonly approvalBaseUrl?: string;
  private readonly publicApiUrl?: string;

  constructor(options: DesktopAuthServiceOptions = {}) {
    this.database = options.database ?? db;
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs === undefined ? configuredTokenTtlMs() : options.tokenTtlMs;
    this.provisionalTtlMs = options.provisionalTtlMs ?? DEFAULT_PROVISIONAL_TTL_MS;
    if (!Number.isSafeInteger(this.provisionalTtlMs) || this.provisionalTtlMs < 1_000
      || this.provisionalTtlMs > DEFAULT_PROVISIONAL_TTL_MS) {
      throw new Error('Desktop provisional TTL must be from 1000 to 120000 milliseconds');
    }
    this.approvalBaseUrl = options.approvalBaseUrl;
    this.publicApiUrl = options.publicApiUrl;
  }

  async startPairing(clientNameInput: unknown, bindingInput: unknown): Promise<DesktopPairingStart> {
    const clientName = validClientName(clientNameInput);
    const binding = validBinding(bindingInput);
    const pairingId = `dpr_${opaqueValue(16)}`;
    const deviceSecret = opaqueValue();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.pairingTtlMs);
    const apiApprovalBase = publicApiBase(this.publicApiUrl);
    const approvalUrl = apiApprovalBase?.url ?? this.getFrontendApprovalUrl(pairingId);
    if (apiApprovalBase) {
      approvalUrl.pathname = `${approvalUrl.pathname.replace(/\/$/, '')}/api/desktop/pairings/${pairingId}/browser`;
      approvalUrl.search = '';
      approvalUrl.hash = '';
    }

    await this.database<PairingRow>('desktop_pairing_requests').insert({
      id: pairingId,
      device_secret_hash: digest(deviceSecret),
      client_name: clientName,
      status: 'pending',
      requested_instance_id: binding.instanceId,
      requested_origin: binding.origin,
      requested_scope: binding.scope,
      credential_generation: binding.credentialGeneration,
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
    const apiBase = publicApiBase(this.publicApiUrl);
    if (approvalUrl.origin === 'https://app.propr.dev' && apiBase?.managedSelector) {
      approvalUrl.searchParams.set('tunnel', apiBase.managedSelector);
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
        .forUpdate()
        .first();
      if (!row) throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
      if (row.expires_at <= nowIso) throw new DesktopAuthError('PAIRING_EXPIRED', 410, 'Pairing request has expired');
      if (row.status === 'pending') return { status: 'pending', interval: DEFAULT_POLL_INTERVAL_SECONDS };
      if (row.status === 'consumed') {
        if (row.cancelled_at) throw new DesktopAuthError('PAIRING_CANCELLED', 410, 'Pairing request was cancelled');
        throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
      }
      if (row.status === 'cancelled') {
        throw new DesktopAuthError('PAIRING_CANCELLED', 410, 'Pairing request was cancelled');
      }
      if (!row.approved_by_user_id || !row.approved_by_username) {
        throw new DesktopAuthError('PAIRING_INVALID_STATE', 409, 'Pairing request cannot be completed');
      }

      const token = `${INSTANCE_TOKEN_PREFIX}${derivePairingValue(deviceSecret, 'credential', row)}`;
      const activationTicket = derivePairingValue(deviceSecret, 'activation-ticket', row);
      let activationExpiresAt = row.activation_expires_at;
      let tokenId = row.provisional_token_id;
      if (!tokenId) {
        tokenId = randomUUID();
        activationExpiresAt = new Date(Math.min(
          Date.parse(row.expires_at),
          now.getTime() + this.provisionalTtlMs,
        )).toISOString();
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
          expires_at: activationExpiresAt,
          activation_state: 'provisional',
          pairing_id: row.id,
          bound_instance_id: row.requested_instance_id,
          bound_origin: row.requested_origin,
          bound_scope: row.requested_scope,
          credential_generation: row.credential_generation,
        });
        await transaction<PairingRow>('desktop_pairing_requests').where({ id: row.id, status: 'approved' }).update({
          provisional_token_id: tokenId,
          activation_ticket_hash: digest(activationTicket),
          activation_expires_at: activationExpiresAt,
        });
        await this.audit('token_provisioned', {
          pairingId,
          tokenId,
          clientName: row.client_name,
          actor: { id: row.approved_by_user_id, username: row.approved_by_username },
        }, transaction);
      } else {
        const existing = await transaction<TokenRow>('instance_api_tokens').where({ id: tokenId }).first();
        if (!existing || existing.token_hash !== digest(token)
          || row.activation_ticket_hash !== digest(activationTicket)
          || !activationExpiresAt || activationExpiresAt <= nowIso) {
          throw new DesktopAuthError('PAIRING_EXPIRED', 410, 'Pairing activation has expired');
        }
      }
      return {
        status: 'provisional',
        token,
        tokenType: 'Bearer',
        activationTicket,
        activationExpiresAt: activationExpiresAt!,
        ...rowBinding(row),
      };
    });
  }

  async cancelPairing(pairingId: string, input: unknown): Promise<{ status: 'cancelled'; cancelledAt: string }> {
    validPairingId(pairingId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
    }
    const request = input as Record<string, unknown>;
    const deviceSecret = requireDeviceSecret(request.deviceSecret);
    const binding = validBinding(request);
    const activationTicket = typeof request.activationTicket === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(request.activationTicket)
      ? request.activationTicket
      : null;
    if (!activationTicket) throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
    const nowIso = this.now().toISOString();
    return this.database.transaction(async transaction => {
      const row = await transaction<PairingRow>('desktop_pairing_requests')
        .where({ id: pairingId, device_secret_hash: digest(deviceSecret) })
        .forUpdate()
        .first();
      if (!row || !sameBinding(row, binding) || row.activation_ticket_hash !== digest(activationTicket)) {
        throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
      }
      if (row.cancelled_at) return { status: 'cancelled', cancelledAt: row.cancelled_at };
      if (!row.provisional_token_id) {
        throw new DesktopAuthError('PAIRING_INVALID_STATE', 409, 'Pairing credential was not provisioned');
      }
      await transaction<TokenRow>('instance_api_tokens')
        .where({ id: row.provisional_token_id })
        .whereNull('revoked_at')
        .update({ revoked_at: nowIso, revoked_by_user_id: row.approved_by_user_id });
      await transaction<PairingRow>('desktop_pairing_requests').where({ id: row.id }).update({
        status: 'consumed',
        consumed_at: nowIso,
        cancelled_at: nowIso,
      });
      await this.audit('pairing_cancelled', {
        pairingId,
        tokenId: row.provisional_token_id,
        clientName: row.client_name,
        actor: row.approved_by_user_id && row.approved_by_username
          ? { id: row.approved_by_user_id, username: row.approved_by_username }
          : undefined,
      }, transaction);
      return { status: 'cancelled', cancelledAt: nowIso };
    });
  }

  async activatePairing(pairingId: string, input: unknown): Promise<DesktopPairingActivationReceipt> {
    validPairingId(pairingId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
    }
    const request = input as Record<string, unknown>;
    const deviceSecret = requireDeviceSecret(request.deviceSecret);
    const binding = validBinding(request);
    const activationTicket = typeof request.activationTicket === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(request.activationTicket)
      ? request.activationTicket
      : null;
    if (!activationTicket) throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
    const now = this.now();
    const nowIso = now.toISOString();
    return this.database.transaction(async transaction => {
      const row = await transaction<PairingRow>('desktop_pairing_requests')
        .where({ id: pairingId, device_secret_hash: digest(deviceSecret) })
        .forUpdate()
        .first();
      if (!row || !sameBinding(row, binding) || row.activation_ticket_hash !== digest(activationTicket)) {
        throw new DesktopAuthError('PAIRING_NOT_FOUND', 404, 'Pairing request was not found');
      }
      const tokenId = row.provisional_token_id;
      if (!tokenId) throw new DesktopAuthError('PAIRING_INVALID_STATE', 409, 'Pairing credential was not provisioned');
      if (row.status === 'consumed') {
        if (row.cancelled_at) throw new DesktopAuthError('PAIRING_CANCELLED', 410, 'Pairing request was cancelled');
        if (!row.activation_receipt || !row.activated_at) {
          throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
        }
        const token = await transaction<TokenRow>('instance_api_tokens').where({ id: tokenId }).first();
        if (!token || token.activation_state !== 'active') {
          throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
        }
        return {
          status: 'active', receipt: row.activation_receipt, activatedAt: row.activated_at, expiresAt: token.expires_at,
        };
      }
      if (row.status === 'cancelled') throw new DesktopAuthError('PAIRING_CANCELLED', 410, 'Pairing request was cancelled');
      if (row.status !== 'approved' || row.expires_at <= nowIso
        || !row.activation_expires_at || row.activation_expires_at <= nowIso) {
        throw new DesktopAuthError('PAIRING_EXPIRED', 410, 'Pairing activation has expired');
      }
      const finalExpiresAt = this.tokenTtlMs === null
        ? null
        : new Date(now.getTime() + this.tokenTtlMs).toISOString();
      const activated = await transaction<TokenRow>('instance_api_tokens')
        .where({ id: tokenId, activation_state: 'provisional' })
        .whereNull('revoked_at')
        .andWhere('expires_at', '>', nowIso)
        .update({ activation_state: 'active', expires_at: finalExpiresAt });
      if (activated !== 1) throw new DesktopAuthError('PAIRING_EXPIRED', 410, 'Pairing activation has expired');
      const receipt = opaqueValue(16);
      const consumed = await transaction<PairingRow>('desktop_pairing_requests')
        .where({ id: row.id, status: 'approved' })
        .update({ status: 'consumed', consumed_at: nowIso, activated_at: nowIso, activation_receipt: receipt });
      if (consumed !== 1) throw new DesktopAuthError('PAIRING_ALREADY_CONSUMED', 409, 'Pairing request was already used');
      await this.audit('token_activated', {
        pairingId, tokenId, clientName: row.client_name,
        actor: { id: row.approved_by_user_id!, username: row.approved_by_username! },
      }, transaction);
      return { status: 'active', receipt, activatedAt: nowIso, expiresAt: finalExpiresAt };
    });
  }

  async validateToken(token: string): Promise<InstanceTokenIdentity | null> {
    if (!token.startsWith(INSTANCE_TOKEN_PREFIX) || token.length !== INSTANCE_TOKEN_PREFIX.length + 43) return null;
    const nowIso = this.now().toISOString();
    const row = await this.database<TokenRow>('instance_api_tokens')
      .where({ token_hash: digest(token) })
      .andWhere({ activation_state: 'active' })
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
      .andWhere({ activation_state: 'active' })
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

  async revokePresentedToken(token: string): Promise<PresentedTokenRevocation> {
    if (!token.startsWith(INSTANCE_TOKEN_PREFIX)
      || token.length !== INSTANCE_TOKEN_PREFIX.length + 43) {
      return { revoked: false, code: 'TOKEN_NOT_FOUND' };
    }
    return this.database.transaction(async transaction => {
      const row = await transaction<TokenRow>('instance_api_tokens')
        .where({ token_hash: digest(token) })
        .first();
      if (!row) return { revoked: false, code: 'TOKEN_NOT_FOUND' };
      if (row.revoked_at) return { revoked: false, code: 'INSTANCE_TOKEN_REVOKED' };
      const now = this.now();
      if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
        return { revoked: false, code: 'INSTANCE_TOKEN_EXPIRED' };
      }
      const actor: GitHubUser = {
        id: row.owner_github_user_id,
        login: row.owner_github_username,
        username: row.owner_github_username,
        displayName: row.owner_display_name,
        email: row.owner_email,
        avatarUrl: row.owner_avatar_url,
      };
      const updated = await transaction<TokenRow>('instance_api_tokens')
        .where({ id: row.id })
        .whereNull('revoked_at')
        .update({ revoked_at: now.toISOString(), revoked_by_user_id: actor.id });
      if (updated !== 1) return { revoked: false, code: 'INSTANCE_TOKEN_REVOKED' };
      await this.audit('token_revoked', { tokenId: row.id, actor }, transaction);
      return { revoked: true };
    });
  }

  async cleanupPairings(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - RETAIN_FINISHED_PAIRINGS_MS).toISOString();
    const nowIso = this.now().toISOString();
    return this.database.transaction<number>(async transaction => {
      await transaction<TokenRow>('instance_api_tokens')
        .where({ activation_state: 'provisional' })
        .andWhere('expires_at', '<=', nowIso)
        .delete();
      const deleted = await transaction<PairingRow>('desktop_pairing_requests')
        .where('expires_at', '<', cutoff)
        .delete();
      return typeof deleted === 'number' ? deleted : 0;
    });
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
