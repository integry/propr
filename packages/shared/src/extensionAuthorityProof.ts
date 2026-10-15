import { z } from 'zod';
import { canonicalFleetJson } from './fleetData.js';
import { fleetExtensionAssertionSchema } from './fleetExtensions.js';

export const EXTENSION_AUTHORITY_CONTRACT = 'propr.extension-authority.v1' as const;
export const EXTENSION_AUTHORITY_PATH = '/extensions/authority/v1/prove' as const;
export const QUALIFIED_EXTENSION_PIN = 'd4987a10399fbbaf9b8c9483daaf26316d82a5ae5b2961d3ebdeb69c2d24e1c0' as const;
export const EXTENSION_AUTHORITY_LIMITS = { requestBytes: 8192, responseBytes: 8192, seconds: 30, challenges: 16384, operations: 4096 } as const;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const epoch = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const extensionAuthorityRequestSchema = z.strictObject({
  contract: z.literal(EXTENSION_AUTHORITY_CONTRACT), contractPin: hash,
  extension: fleetExtensionAssertionSchema.omit({ nonce: true, issuedAt: true, expiresAt: true }).extend({ contractPin: z.literal(QUALIFIED_EXTENSION_PIN) }),
  extensionInstanceId: z.uuid(), workDigest: hash, acquisitionOperationId: z.uuid().nullable(),
  phase: z.enum(['request', 'dispatch', 'status', 'completion']), challenge: hash,
  authorityEpoch: epoch.nullable(), issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const extensionAuthorityEnvelopeSchema = z.strictObject({ request: extensionAuthorityRequestSchema, mac: hash });
export const extensionAuthorityStatementSchema = z.strictObject({
  contract: z.literal(EXTENSION_AUTHORITY_CONTRACT), contractPin: hash,
  request: extensionAuthorityRequestSchema, requestCommitment: hash,
  authorityEpoch: epoch, role: z.literal('admin'), source: z.literal('local'), permission: z.literal('instance.manage_settings'),
  observedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  connectAuthorityVerified: z.literal(false),
});
export const extensionAuthorityResponseSchema = z.strictObject({ statement: extensionAuthorityStatementSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type ExtensionAuthorityRequest = z.infer<typeof extensionAuthorityRequestSchema>;
export type ExtensionAuthorityResponse = z.infer<typeof extensionAuthorityResponseSchema>;
export const EXTENSION_AUTHORITY_SCHEMA = canonicalFleetJson({
  contract: EXTENSION_AUTHORITY_CONTRACT, path: EXTENSION_AUTHORITY_PATH,
  envelope: z.toJSONSchema(extensionAuthorityEnvelopeSchema), response: z.toJSONSchema(extensionAuthorityResponseSchema),
  limits: EXTENSION_AUTHORITY_LIMITS, canonical: 'sorted-keys-utf8-json',
  requestAuthentication: 'HMAC-SHA256-canonical-request', responseAuthentication: 'Ed25519-canonical-statement-independent-native-SPKI-pin',
  clockSkewSeconds: 0, expiryExclusive: true, error: 'extension_authority_unavailable',
  downstreamReady: false, publicReady: false,
});
