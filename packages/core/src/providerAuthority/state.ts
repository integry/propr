import { z } from 'zod';
import { createHash } from 'node:crypto';
import { authorityIdentitySchema, enrollmentSchema, issuerSchema, purposeSchema, reservationSchema, resetIntentSchema, PROVIDER_CATALOG, canonicalAuthority as canonical, refuseAuthority as refuse } from './contracts.js';

const uint = z.number().int().nonnegative().safe();
const commitment = z.strictObject({ keyId: z.string().min(1).max(160), digest: z.string().regex(/^[0-9a-f]{64}$/) });
export const recordSchema = z.strictObject({
  id: z.string().uuid(), incarnation: z.string().uuid(), sequence: uint,
  binding: reservationSchema, purpose: purposeSchema,
  phase: z.enum(['reserved', 'dispatched', 'issued', 'finished', 'unknown-after-crash']),
  lease: z.strictObject({ id: z.string().uuid(), expiresAt: uint, status: z.enum(['open', 'closed']) }),
  providerIdCommitment: commitment.nullable(), valueCommitment: commitment.nullable(),
  // This field belongs only to the permissioned authority store. It is never projected.
  privateCustody: z.strictObject({ locator: z.string().min(1).max(8192) }).nullable(),
  resetEffect: z.strictObject({
    kind: z.enum(['reset', 'resource-retirement']), operationId: z.string(),
    intentId: z.string().regex(/^[0-9a-f]{64}$/),
    dispatch: z.enum(['unclaimed', 'claimed']),
    readback: z.enum(['unproven', 'revoked-and-quiescent']),
    evidenceCommitment: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    observerRevision: z.string().nullable(),
  }).nullable(),
});
export type AuthorityRecord = z.infer<typeof recordSchema>;
export const authorityStateSchema = z.strictObject({
  contract: z.literal('propr.hosted-provider-authority.v1'), schemaPin: z.string(),
  enrollment: enrollmentSchema, highWater: uint, lastNow: uint,
  records: z.array(recordSchema),
  closures: z.array(z.strictObject({ issuer: issuerSchema, highWater: uint })),
  reset: z.strictObject({ intent: resetIntentSchema, intentId: z.string(), retired: z.boolean() }).nullable(),
  // Append-only. Transfer changes enrollment, never these predecessor tombstones.
  tombstones: z.array(z.strictObject({ identity: authorityIdentitySchema, intentId: z.string() })),
  transfers: z.array(resetIntentSchema),
});
export type AuthorityState = z.infer<typeof authorityStateSchema>;

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const sealed = (state: AuthorityState) => state.enrollment.issuers.every(i => state.closures.some(c => same(c.issuer, i)));
export function validateAuthorityState(state: AuthorityState) {
  if (state.highWater !== state.records.length
    || new Set(state.records.map(r => r.id)).size !== state.records.length
    || new Set(state.records.map(r => r.incarnation)).size !== state.records.length
    || new Set(state.closures.map(c => c.issuer.issuerId)).size !== state.closures.length
    || new Set(state.tombstones.map(t => canonical(t.identity))).size !== state.tombstones.length) return refuse();
  state.records.forEach((record, index) => validateRecord(state, record, index));
  for (const closure of state.closures) {
    if (closure.highWater > state.highWater || !state.enrollment.issuers.some(i => same(i, closure.issuer))
      || state.records.some(r => same(r.binding.identity, state.enrollment.identity)
        && r.binding.issuer.issuerId === closure.issuer.issuerId && r.sequence > closure.highWater)) return refuse();
  }
  if (state.reset && (!same(state.reset.intent.predecessor, state.enrollment.identity)
    || hash(state.reset.intent) !== state.reset.intentId
    || !state.tombstones.some(t => same(t.identity, state.enrollment.identity) && t.intentId === state.reset!.intentId))) return refuse();
  validateHistory(state);
}
function validateHistory(state: AuthorityState) {
  if (state.tombstones.length !== state.transfers.length + (state.reset ? 1 : 0)) return refuse();
  for (const [index, transfer] of state.transfers.entries()) {
    if (!state.tombstones.some(t => same(t.identity, transfer.predecessor) && t.intentId === hash(transfer))) return refuse();
    const next = state.transfers[index + 1]?.predecessor ?? state.enrollment.identity;
    if (!same(transfer.successor, next)) return refuse();
    if (state.records.some(r => same(r.binding.identity, transfer.predecessor)
      && (r.resetEffect?.readback !== 'revoked-and-quiescent' || r.lease.status !== 'closed'))) return refuse();
  }
  if (state.reset?.retired && (!sealed(state) || state.records.some(r => same(r.binding.identity, state.enrollment.identity)
    && (r.resetEffect?.readback !== 'revoked-and-quiescent' || r.lease.status !== 'closed')))) return refuse();
}
function validateRecord(state: AuthorityState, record: AuthorityRecord, index: number) {
  if (record.sequence !== index + 1 || !PROVIDER_CATALOG.some(r => r.key === record.binding.resourceKey
    && r.category === record.binding.category && r.provider === record.binding.issuer.provider)
    || !record.binding.issuer.resources.includes(record.binding.resourceKey)) return refuse();
  const active = same(record.binding.identity, state.enrollment.identity);
  if (!active && !state.tombstones.some(t => same(t.identity, record.binding.identity))) return refuse();
  if (active && !state.enrollment.issuers.some(i => same(i, record.binding.issuer))) return refuse();
  if (record.resetEffect?.readback === 'revoked-and-quiescent'
    && (!record.resetEffect.evidenceCommitment || !record.resetEffect.observerRevision || record.lease.status !== 'closed')) return refuse();
  const effect = record.resetEffect;
  if (effect?.kind === 'resource-retirement') {
    const expected = hash({ kind: 'resource-retirement', identity: record.binding.identity,
      recordId: record.id, incarnation: record.incarnation, operationId: effect.operationId });
    if (effect.intentId !== expected) return refuse();
  } else {
    const tombstone = state.tombstones.find(t => same(t.identity, record.binding.identity));
    if (tombstone) {
      const expected = hash({ intentId: tombstone.intentId, recordId: record.id, incarnation: record.incarnation });
      if (!effect || effect.intentId !== expected) return refuse();
    } else if (effect) return refuse();
  }
}
