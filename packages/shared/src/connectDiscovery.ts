import type { ProprCompatibilityMetadata } from './proprCompatibility.js';

export const PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const PUBLIC_INSTANCE_IDENTITY_FILENAME = 'public-instance-identity.json';
export const PROPR_CONNECT_DISCOVERY_MAX_BYTES = 8 * 1024;

export interface PublicInstanceIdentityDocument {
  schemaVersion: typeof PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION;
  publicInstanceIdentity: string;
}

export interface ProprDesktopDiscovery extends ProprCompatibilityMetadata {
  schemaVersion: typeof PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION;
  product: 'ProPR';
  canonicalEndpoint: string | null;
  publicInstanceIdentity: string;
}

/** UUIDv4 is random, non-secret, bounded, and contains no installation data. */
export function isPublicInstanceIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function parsePublicInstanceIdentityDocument(value: unknown): PublicInstanceIdentityDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION
    || !isPublicInstanceIdentity(candidate.publicInstanceIdentity)
  ) return null;
  return {
    schemaVersion: PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
    publicInstanceIdentity: candidate.publicInstanceIdentity,
  };
}
