import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { issueOAuthGrantRevision } from '@propr/core';
import type { GitHubUser } from './authTypes.js';
import {
  RELAY_RENEWAL,
  RENEWAL_LEASE_MS,
  logRenewalOutcome,
  renewalBackoffMs,
  renewalDueAt,
  requestRelayRenewal,
  type RelayRenewalResult,
} from './connectGrantRenewal.js';

const RENEWAL_LEASE_POLL_MS = 100;
const USER_TOKEN_PATTERN = /^(?:gho_|ghu_|ghp_|github_pat_)/;

/** The `github_user_grants` columns relay renewal reads. */
export interface RenewableGrantRow {
  github_user_id: string;
  source: 'github' | 'connect';
  access_token_encrypted: string;
  access_token_expires_at_ms: number | string | null;
  status: 'active' | 'reauth_required';
  last_error_code: string | null;
  grant_revision: number | string;
  // Added by 20261029180000_add_github_user_grant_relay_renewal.
  renewal?: string | null;
  renewal_lease_owner?: string | null;
  renewal_lease_until_ms?: number | string | null;
  renewal_retry_after_ms?: number | string | null;
  renewal_failures?: number | string | null;
}

export function isRelayRenewable(row: RenewableGrantRow): boolean {
  return row.source === 'connect' && row.renewal === RELAY_RENEWAL;
}

function timestamp(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Renews relay-renewable Connect grants with one in-flight renewal per grant.
 * Concurrent callers in this process share a promise; other processes sharing
 * the database (API, daemon, workers) are excluded by a row lease, wait for
 * it, and then read the renewed credential. Every write is conditional on
 * the credential that was renewed, so a newer sign-in always wins.
 */
export class ConnectGrantRenewer {
  private readonly renewals = new Map<string, Promise<void>>();
  private renewalColumns?: Promise<boolean>;

  constructor(
    private readonly database: Knex,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
    private readonly encryptToken: (token: string) => string,
  ) {}

  /** Renewal columns for a new sign-in, which replaces the renewal mode. Older relays send none. */
  async captureColumns(user: Pick<GitHubUser, 'oauthSource' | 'connectRenewal'>): Promise<Record<string, unknown>> {
    this.renewalColumns ??= this.database.schema.hasColumn('github_user_grants', 'renewal').catch(() => false);
    if (!await this.renewalColumns) return {};
    return {
      renewal: user.oauthSource === 'connect' && user.connectRenewal === RELAY_RENEWAL ? RELAY_RENEWAL : null,
      renewal_lease_owner: null,
      renewal_lease_until_ms: null,
      renewal_retry_after_ms: null,
      renewal_failures: 0,
    };
  }

  /**
   * The row to resolve a relay-renewable grant from, renewing it first when
   * due: about ten minutes before expiry, or once after GitHub rejected the
   * token (`forced`). While renewal backs off after transient failures the
   * current token stays usable until it actually expires.
   */
  async renewIfDue<T extends RenewableGrantRow>(row: T, forced: boolean): Promise<T | 'missing' | 'temporarily_unavailable'> {
    const now = Date.now();
    const expiresAt = timestamp(row.access_token_expires_at_ms);
    const due = forced
      || (expiresAt !== undefined && now >= renewalDueAt(`${row.github_user_id}:${row.access_token_encrypted}`, expiresAt));
    if (!due) return row;
    const retryAfter = timestamp(row.renewal_retry_after_ms ?? null);
    if (retryAfter === undefined || retryAfter <= now) await this.renew(row, forced);
    const current = await this.grants().where({ github_user_id: row.github_user_id }).first() as T | undefined;
    if (!current) return 'missing';
    // Renewed here or in another process, replaced by a new sign-in, or now requiring one.
    if (current.status !== 'active' || current.access_token_encrypted !== row.access_token_encrypted) return current;
    const currentExpiry = timestamp(current.access_token_expires_at_ms);
    if (!forced && (currentExpiry === undefined || currentExpiry > Date.now())) return current;
    return 'temporarily_unavailable';
  }

  /** Settles once this grant was renewed, failed, or another holder released the lease. */
  renew(row: RenewableGrantRow, forced: boolean): Promise<void> {
    const existing = this.renewals.get(row.github_user_id);
    if (existing) return existing;
    const pending = this.renewWithLease(row, forced).finally(() => this.renewals.delete(row.github_user_id));
    this.renewals.set(row.github_user_id, pending);
    return pending;
  }

  private grants() {
    return this.database('github_user_grants');
  }

  private async renewWithLease(row: RenewableGrantRow, forced: boolean): Promise<void> {
    const leaseOwner = randomBytes(16).toString('hex');
    const now = Date.now();
    // The caller's row may predate a backoff another process persisted, so
    // the retry deadline is part of the atomic acquisition. A denied caller
    // rereads the grant and honours whatever backoff is now stored.
    const acquired = Number(await this.grants()
      .where({ github_user_id: row.github_user_id, access_token_encrypted: row.access_token_encrypted, status: 'active' })
      .andWhere(builder => builder
        .whereNull('renewal_lease_until_ms')
        .orWhere('renewal_lease_until_ms', '<', now))
      .andWhere(builder => builder
        .whereNull('renewal_retry_after_ms')
        .orWhere('renewal_retry_after_ms', '<=', now))
      .update({ renewal_lease_owner: leaseOwner, renewal_lease_until_ms: now + RENEWAL_LEASE_MS })) === 1;
    if (!acquired) {
      await this.waitForLease(row.github_user_id);
      return;
    }
    try {
      // Count failures from the leased row, not the caller's possibly stale read.
      const leased = await this.grants()
        .where({ github_user_id: row.github_user_id, renewal_lease_owner: leaseOwner })
        .first('renewal_failures') as Pick<RenewableGrantRow, 'renewal_failures'> | undefined;
      const result = await requestRelayRenewal(this.environment, this.fetchImpl, row.github_user_id);
      await this.apply({ ...row, renewal_failures: leased?.renewal_failures ?? row.renewal_failures }, leaseOwner, result, forced);
    } catch (error) {
      console.warn('Connect grant renewal could not be stored:', (error as Error).message);
    } finally {
      await this.grants()
        .where({ github_user_id: row.github_user_id, renewal_lease_owner: leaseOwner })
        .update({ renewal_lease_owner: null, renewal_lease_until_ms: null });
    }
  }

  private async apply(row: RenewableGrantRow, leaseOwner: string, result: RelayRenewalResult, forced: boolean): Promise<void> {
    const leased = () => this.grants().where({
      github_user_id: row.github_user_id,
      access_token_encrypted: row.access_token_encrypted,
      renewal_lease_owner: leaseOwner,
    });
    const githubUserId = row.github_user_id;
    const expiresAt = timestamp(row.access_token_expires_at_ms);
    const now = this.database.fn.now();
    if (result.kind === 'renewed' && USER_TOKEN_PATTERN.test(result.accessToken)) {
      await leased().update({
        access_token_encrypted: this.encryptToken(result.accessToken),
        access_token_expires_at_ms: result.expiresAt,
        status: 'active',
        last_error_code: null,
        grant_revision: issueOAuthGrantRevision(row.grant_revision),
        renewal_retry_after_ms: null,
        renewal_failures: 0,
        updated_at: now,
      });
      logRenewalOutcome({ githubUserId, outcome: 'renewed', expiresAt: result.expiresAt });
      return;
    }
    if (result.kind === 'reauth') {
      await leased().update({ status: 'reauth_required', last_error_code: result.code, updated_at: now });
      logRenewalOutcome({ githubUserId, outcome: 'reauth_required', expiresAt, errorCode: result.code });
      return;
    }
    if (result.kind === 'unavailable') {
      // A grant issued before relay renewal existed. Fall back to today's
      // behaviour: keep a still-valid token until it nears expiry, then ask
      // for one more sign-in, which yields a renewable grant.
      const unusable = forced || (expiresAt !== undefined && expiresAt <= Date.now());
      await leased().update(unusable
        ? { renewal: null, status: 'reauth_required', last_error_code: 'missing_refresh_token', updated_at: now }
        : { renewal: null, updated_at: now });
      logRenewalOutcome({ githubUserId, outcome: 'renewal_unavailable', expiresAt, errorCode: 'renewal_unavailable' });
      return;
    }
    // Network, 5xx, 429 or a malformed response: back off, keep the grant active.
    const errorCode = result.kind === 'transient' ? result.code : 'invalid_token';
    const failures = Number(row.renewal_failures ?? 0) + 1;
    const retryAt = Date.now() + renewalBackoffMs(failures, result.kind === 'transient' ? result.retryAfterMs : undefined);
    await leased().update({ renewal_failures: failures, renewal_retry_after_ms: retryAt });
    logRenewalOutcome({ githubUserId, outcome: 'transient_failure', expiresAt, errorCode, retryAt });
  }

  private async waitForLease(githubUserId: string): Promise<void> {
    const deadline = Date.now() + RENEWAL_LEASE_MS;
    while (Date.now() < deadline) {
      const current = await this.database('github_user_grants')
        .where({ github_user_id: githubUserId })
        .first('renewal_lease_owner', 'renewal_lease_until_ms');
      if (!current?.renewal_lease_owner || (timestamp(current.renewal_lease_until_ms ?? null) ?? 0) <= Date.now()) return;
      await delay(RENEWAL_LEASE_POLL_MS);
    }
  }
}
