import type { AuthorityIdentity, AuthorityReadonly, Purpose, Reservation } from './contracts.js';

export interface StoredAuthority { readonly revision: number; readonly bytes: string }
/** Permissioned control-root custody, outside erasable app/tenant state.
 * read is linearizable. compareAndSwap is atomic, crash-durable before returning,
 * create-only for expectedRevision=null, otherwise exact compare and revision+1.
 * A false return has no effect. A throw is ambiguous and MUST NOT be retried as a
 * new dispatch. No delete/TTL/rollback API is permitted, including for tombstones.
 * Adapters must never log bytes or underlying errors, and must validate storage
 * permissions, retention, backup and anti-rollback policy at composition time.
 */
export interface HostedAuthorityStore {
  readonly custody: 'durable-permissioned-control-root';
  read(key: string): Promise<StoredAuthority | null>;
  compareAndSwap(key: string, expectedRevision: number | null, bytes: string): Promise<boolean>;
}
export interface AuthorityClock { now(): number }
/** Dedicated versioned MAC key; never an unkeyed hash of tokens/env/provider IDs.
 * Bind domain AND exact canonical identity to the commitment. Keep keys private.
 */
export interface AuthorityKeys {
  commit(domain: 'provider-id' | 'credential-value', binding: string, value: string): { keyId: string; digest: string };
}
export interface IndependentAuthorityReader {
  readonly implementationRevision: string;
  /** Trusted adapter must independently prove both revocation and physical writer
   * quiescence. Absence/404/expiry/process exit alone must return unproven. */
  observe(request: AuthorityReadonly<{
    identity: AuthorityIdentity; binding: Reservation; recordId: string; incarnation: string; intentId: string;
  }>): Promise<unknown>;
}

declare const capabilityBrand: unique symbol;
/** Process-local, immutable, unforgeable by construction. Never serialize a grant.
 * The durable claim is authoritative; loss of a grant cannot release that claim. */
export type ProviderGrant = Readonly<{
  [capabilityBrand]: true; recordId: string; incarnation: string;
  identity: Readonly<AuthorityIdentity>; binding: AuthorityReadonly<Reservation>;
  purpose: Purpose | 'reset-effect'; expiresAt: number; effectIntentId: string | null;
}>;
export type LocalProviderCapability = { recordId: string; leaseId: string; purpose: Purpose | 'reset-effect'; consumed: boolean; effectAttempted: boolean; effectConsumed: boolean };
export interface HostedAuthorityPorts {
  store: HostedAuthorityStore;
  clock: AuthorityClock;
  keys: AuthorityKeys;
  reader: IndependentAuthorityReader;
}
