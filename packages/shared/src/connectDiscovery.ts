import type { ProprCompatibilityMetadata } from './proprCompatibility.js';
import { canonicalProprProxyUrl } from './proprServiceUrls.js';

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

const DISCOVERY_KEYS = [
  'schemaVersion',
  'product',
  'version',
  'apiCompatibility',
  'uiCompatibility',
  'desktopAuthentication',
  'canonicalEndpoint',
  'publicInstanceIdentity',
] as const;
const DESKTOP_AUTHENTICATION_KEYS = [
  'protocolVersion',
  'browserPairing',
  'instanceBearerTokens',
  'socketIoBearerAuthentication',
] as const;
const MAX_DISCOVERY_SCALAR_LENGTH = 64;
const CANONICAL_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANONICAL_COMPATIBILITY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isCanonicalCompatibility(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_DISCOVERY_SCALAR_LENGTH
    || !CANONICAL_COMPATIBILITY.test(value)
  ) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Strictly parse the schema-v1 discovery document with desktop-auth protocol v2. */
export function parseProprDesktopDiscovery(value: unknown): ProprDesktopDiscovery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!hasExactKeys(candidate, DISCOVERY_KEYS)) return null;

  const authentication = candidate.desktopAuthentication;
  if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) return null;
  const capabilities = authentication as Record<string, unknown>;
  if (!hasExactKeys(capabilities, DESKTOP_AUTHENTICATION_KEYS)) return null;

  const endpoint = candidate.canonicalEndpoint;
  if (
    candidate.schemaVersion !== PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION
    || candidate.product !== 'ProPR'
    || typeof candidate.version !== 'string'
    || candidate.version.length === 0
    || candidate.version.length > MAX_DISCOVERY_SCALAR_LENGTH
    || !CANONICAL_SEMVER.test(candidate.version)
    || !isCanonicalCompatibility(candidate.apiCompatibility)
    || !isCanonicalCompatibility(candidate.uiCompatibility)
    || !isPublicInstanceIdentity(candidate.publicInstanceIdentity)
    || (endpoint !== null && (
      typeof endpoint !== 'string'
      || canonicalProprProxyUrl(endpoint) !== endpoint
    ))
    || capabilities.protocolVersion !== 2
    || typeof capabilities.browserPairing !== 'boolean'
    || typeof capabilities.instanceBearerTokens !== 'boolean'
    || typeof capabilities.socketIoBearerAuthentication !== 'boolean'
  ) return null;

  return {
    schemaVersion: PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
    product: 'ProPR',
    version: candidate.version,
    apiCompatibility: candidate.apiCompatibility,
    uiCompatibility: candidate.uiCompatibility,
    canonicalEndpoint: endpoint as string | null,
    publicInstanceIdentity: candidate.publicInstanceIdentity,
    desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: capabilities.browserPairing,
      instanceBearerTokens: capabilities.instanceBearerTokens,
      socketIoBearerAuthentication: capabilities.socketIoBearerAuthentication,
    },
  };
}

/**
 * Parse discovery from its bounded wire representation.  JSON.parse silently
 * accepts duplicate object members, so discovery uses this small structural
 * pass before the schema parser.  Keeping it here makes CLI, client and desktop
 * consumers agree on duplicate, size and schema rejection.
 */
export function parseProprDesktopDiscoveryJson(contents: string): ProprDesktopDiscovery | null {
  if (typeof contents !== 'string'
    || new TextEncoder().encode(contents).byteLength > PROPR_CONNECT_DISCOVERY_MAX_BYTES) return null;

  let offset = 0;
  const whitespace = (): void => {
    while (offset < contents.length && /[\x20\t\r\n]/.test(contents[offset])) offset += 1;
  };
  const stringToken = (): string | null => {
    if (contents[offset] !== '"') return null;
    const start = offset;
    offset += 1;
    while (offset < contents.length) {
      const character = contents[offset++];
      if (character === '"') {
        try { return JSON.parse(contents.slice(start, offset)) as string; } catch { return null; }
      }
      if (character === '\\') {
        const escape = contents[offset++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(contents.slice(offset, offset + 4))) return null;
          offset += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) return null;
      } else if (character.charCodeAt(0) < 0x20) return null;
    }
    return null;
  };
  const value = (): boolean => {
    whitespace();
    if (contents[offset] === '{') {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (contents[offset] === '}') { offset += 1; return true; }
      while (offset < contents.length) {
        const key = stringToken();
        if (key === null || keys.has(key)) return false;
        keys.add(key);
        whitespace();
        if (contents[offset++] !== ':') return false;
        if (!value()) return false;
        whitespace();
        const separator = contents[offset++];
        if (separator === '}') return true;
        if (separator !== ',') return false;
        whitespace();
      }
      return false;
    }
    if (contents[offset] === '[') {
      offset += 1;
      whitespace();
      if (contents[offset] === ']') { offset += 1; return true; }
      while (offset < contents.length) {
        if (!value()) return false;
        whitespace();
        const separator = contents[offset++];
        if (separator === ']') return true;
        if (separator !== ',') return false;
      }
      return false;
    }
    if (contents[offset] === '"') return stringToken() !== null;
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/
      .exec(contents.slice(offset))?.[0];
    if (!primitive) return false;
    offset += primitive.length;
    return true;
  };

  if (!value()) return null;
  whitespace();
  if (offset !== contents.length) return null;
  try {
    return parseProprDesktopDiscovery(JSON.parse(contents) as unknown);
  } catch {
    return null;
  }
}
