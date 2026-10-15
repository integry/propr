import { z } from 'zod';
import { canonicalFleetJson } from './fleetData.js';
import { fleetExtensionAssertionSchema, fleetExtensionRequestSchema } from './fleetExtensions.js';
import { QUALIFIED_EXTENSION_PIN } from './extensionAuthorityProof.js';

export const EXTENSION_AUTHORITY_V2 = 'propr.extension-authority.v2' as const;
export const EXTENSION_AUTHORITY_V2_PATH = '/extensions/authority/v2/invoke' as const;
export const EXTENSION_AUTHORITY_V2_LIMITS = { metadataBytes: 16384, requestBytes: 278528, responseBytes: 16384, seconds: 30, challenges: 16384, operations: 4096 } as const;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const epoch = z.string().regex(/^[1-9][0-9]{0,15}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const routingTrustSchema = z.strictObject({
  contract: z.literal(EXTENSION_AUTHORITY_V2), keyId: id, keyEpoch: epoch, authorityEpoch: epoch,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{59}$/), producerRevision: hash, producerEpoch: epoch,
});
export const managedExtensionWorkSchema = z.strictObject({
  extension: fleetExtensionAssertionSchema.extend({ contractPin: z.literal(QUALIFIED_EXTENSION_PIN) }),
  extensionInstanceId: z.uuid(), workDigest: hash, acquisitionOperationId: z.uuid().nullable(),
  coreAuthorityEpoch: epoch,
  scope: z.strictObject({
    accountId: id, installationId: id, tenantId: id, targetId: id,
    actorEpoch: epoch, membershipEpoch: epoch, securityEpoch: epoch, passkeyEpoch: epoch,
    accountEpoch: epoch, installationEpoch: epoch, tenantEpoch: epoch, targetEpoch: epoch,
    placementEpoch: epoch, runtimeEpoch: epoch, storageEpoch: epoch, extensionEpoch: epoch,
  }),
});
export const authorityV2RequestSchema = z.strictObject({
  contract: z.literal(EXTENSION_AUTHORITY_V2), contractPin: hash, work: managedExtensionWorkSchema,
  phase: z.enum(['request', 'dispatch', 'completion', 'status']), challenge: hash,
  issuedAt: time, expiresAt: time,
});
export const routingStatementSchema = z.strictObject({
  contract: z.literal('propr.routing-extension-authorization.v2'), request: authorityV2RequestSchema,
  decision: z.literal('allow'), keyId: id, keyEpoch: epoch, authorityEpoch: epoch,
  producerRevision: hash, producerEpoch: epoch, checkedAt: time, expiresAt: time,
});
export const routingAuthorizationSchema = z.strictObject({ statement: routingStatementSchema, signature });
// native is present only for dispatch. Its fourteen-action vocabulary is unchanged.
// It is never copied into a proof or an authority ledger.
export const authorityV2EnvelopeSchema = z.strictObject({
  request: authorityV2RequestSchema, routing: routingAuthorizationSchema, mac: hash,
  native: fleetExtensionRequestSchema.optional(),
});
export const coreV2DecisionSchema = z.strictObject({
  requestDigest: hash, workDigest: hash, authorityEpoch: epoch, actorId: z.number().int().positive(),
  role: z.literal('admin'), source: z.literal('local'), permission: z.literal('instance.manage_settings'),
  checkedAt: time,
});
export const authorityV2ResultSchema = z.strictObject({
  state: z.enum(['admitted', 'completed', 'incomplete']), nativeResultDigest: hash.nullable(),
  dispatchDecisionDigest: hash.nullable(),
  recipientCommitment: z.strictObject({ operationId: z.uuid(), intentDigest: hash }).nullable(),
});
export const authorityV2ResponseSchema = z.strictObject({
  statement: z.strictObject({
    contract: z.literal(EXTENSION_AUTHORITY_V2), contractPin: hash, request: authorityV2RequestSchema,
    coreDecision: coreV2DecisionSchema, routingDigest: hash, trustDigest: hash,
    combinedDecisionDigest: hash, result: authorityV2ResultSchema, resultDigest: hash,
    committedAt: time, expiresAt: time,
  }), signature,
});
export type AuthorityV2Request = z.infer<typeof authorityV2RequestSchema>;
export type AuthorityV2Envelope = z.infer<typeof authorityV2EnvelopeSchema>;
export type AuthorityV2Response = z.infer<typeof authorityV2ResponseSchema>;
export const EXTENSION_AUTHORITY_V2_SCHEMA = canonicalFleetJson({
  contract: EXTENSION_AUTHORITY_V2, path: EXTENSION_AUTHORITY_V2_PATH,
  envelope: z.toJSONSchema(authorityV2EnvelopeSchema), response: z.toJSONSchema(authorityV2ResponseSchema),
  trust: z.toJSONSchema(routingTrustSchema), limits: EXTENSION_AUTHORITY_V2_LIMITS,
  canonical: 'sorted-keys-utf8-json', requestAuthentication: 'HMAC-SHA256-canonical-request-and-routing',
  routingAuthentication: 'Ed25519-canonical-statement-independent-operator-SPKI',
  responseAuthentication: 'Ed25519-canonical-statement-independent-native-SPKI-pin',
  expiryExclusive: true, clockSkewSeconds: 0, exactRetry: 'retained-receipt-only-except-status',
  dispatch: 'one-native-invocation-in-admission-transaction-commitments-only-response',
  publicReady: false, downstreamReady: false,
});
