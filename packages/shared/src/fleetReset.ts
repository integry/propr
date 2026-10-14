import { z } from 'zod';
import { canonicalFleetJson } from './fleetData.js';

/** This private contract never grants filesystem or command execution authority. */
export const FLEET_RESET_CONTRACT = 'propr.fleet-reset.v1' as const;
export const FLEET_RESET_AUDIENCE = 'fleet-reset-coordinator' as const;
export const FLEET_RESET_PATH = '/reset/v1/invoke' as const;
export const FLEET_RESET_CATEGORIES = [
  'database', 'configuration', 'repositories_worktrees_caches', 'active_tasks',
  'queued_tasks', 'unpublished_results', 'provider_sessions', 'tunnel_bootstrap', 'diagnostic_logs',
] as const;
export const FLEET_RESET_LIMITS = { requestBytes: 8192, responseBytes: 16384, grantSeconds: 30, entries: 16384 } as const;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
export const fleetResetIdentitySchema = z.strictObject({
  generation: integer, stateScope: scope, runtimeId: uuid, storageId: uuid,
});
export const fleetResetBindingSchema = z.strictObject({
  resetOperationId: uuid,
  resetRequestDigest: hash,
  resetAction: z.literal('instance.reset'),
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  predecessor: fleetResetIdentitySchema,
  successor: fleetResetIdentitySchema,
  runtimeBuildDigest: hash,
}).refine(b => b.successor.generation === b.predecessor.generation + 1
  && b.successor.stateScope === `reset:${b.resetOperationId}`
  && b.predecessor.stateScope !== b.successor.stateScope
  && b.predecessor.runtimeId !== b.successor.runtimeId
  && b.predecessor.storageId !== b.successor.storageId, 'invalid succession');
export const fleetResetAssertionSchema = z.strictObject({
  contract: z.literal(FLEET_RESET_CONTRACT), contractPin: hash,
  audience: z.literal(FLEET_RESET_AUDIENCE), binding: fleetResetBindingSchema,
  action: z.enum(['reset.prove', 'reset.receipt']), requestId: uuid, nonce: hash,
  issuedAt: integer, expiresAt: integer,
});
export const fleetResetEnvelopeSchema = z.strictObject({ assertion: fleetResetAssertionSchema, mac: hash });
export type FleetResetBinding = z.infer<typeof fleetResetBindingSchema>;
export type FleetResetAssertion = z.infer<typeof fleetResetAssertionSchema>;
export type FleetResetEnvelope = z.infer<typeof fleetResetEnvelopeSchema>;

/** Recovery and terminal variants cannot mix partial category proofs. */
const recoveryEvidenceSchema = z.strictObject({
  state: z.literal('recovery_required'),
  categories: z.strictObject(Object.fromEntries(FLEET_RESET_CATEGORIES.map(category =>
    [category, z.literal('unproven')])) as Record<typeof FLEET_RESET_CATEGORIES[number], z.ZodLiteral<'unproven'>>),
  predecessorFenced: z.literal(false), successorIsolated: z.literal(false), bootstrapAllowed: z.literal(false),
  reason: z.enum(['native_coverage_unavailable', 'interrupted_or_corrupt']),
});
const terminalEvidenceSchema = z.strictObject({
  state: z.literal('complete'),
  categories: z.strictObject(Object.fromEntries(FLEET_RESET_CATEGORIES.map(category =>
    [category, z.literal('erased')])) as Record<typeof FLEET_RESET_CATEGORIES[number], z.ZodLiteral<'erased'>>),
  predecessorFenced: z.literal(true), successorIsolated: z.literal(true), bootstrapAllowed: z.literal(true),
  reason: z.literal('stable_native_proof'), observationDigest: hash,
});
export const fleetResetEvidenceSchema = z.discriminatedUnion('state', [recoveryEvidenceSchema, terminalEvidenceSchema]);
export const fleetResetReceiptSchema = z.strictObject({
  contract: z.literal(FLEET_RESET_CONTRACT), contractPin: hash,
  audience: z.literal(FLEET_RESET_AUDIENCE), binding: fleetResetBindingSchema,
  action: z.enum(['reset.prove', 'reset.receipt']), requestId: uuid, requestDigest: hash,
  proofRequestId: uuid.nullable(), evidenceDigest: hash,
  observedAt: integer, expiresAt: integer, evidence: fleetResetEvidenceSchema,
});
export const fleetResetSignedReceiptSchema = z.strictObject({ receipt: fleetResetReceiptSchema, mac: hash });
export type FleetResetEvidence = z.infer<typeof fleetResetEvidenceSchema>;
export type FleetResetReceipt = z.infer<typeof fleetResetReceiptSchema>;
export const FLEET_RESET_SCHEMA = canonicalFleetJson({
  contract: FLEET_RESET_CONTRACT, audience: FLEET_RESET_AUDIENCE, path: FLEET_RESET_PATH,
  canonical: 'sorted-keys-utf8-json', algorithm: 'HMAC-SHA256',
  requestMacDomain: 'propr.fleet-reset.v1.request\n', receiptMacDomain: 'propr.fleet-reset.v1.receipt\n',
  limits: FLEET_RESET_LIMITS,
  request: z.toJSONSchema(fleetResetEnvelopeSchema),
  receipt: z.toJSONSchema(fleetResetSignedReceiptSchema),
  succession: 'successor.generation=predecessor.generation+1; successor.stateScope=reset:resetOperationId; distinct scopes, runtimeIds, storageIds',
  capabilities: { public: false, destructiveEffects: true, terminalProof: true, successorBootstrap: true },
});
