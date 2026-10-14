import { NativeResetRuntime } from './nativeReset.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  FLEET_RESET_CONTRACT, FLEET_RESET_AUDIENCE, FLEET_RESET_SCHEMA,
  FLEET_RESET_CATEGORIES, FLEET_RESET_LIMITS, fleetResetBindingSchema,
  fleetResetEnvelopeSchema, fleetResetEvidenceSchema, fleetResetSignedReceiptSchema,
  canonicalFleetJson,
  type FleetResetAssertion, type FleetResetBinding, type FleetResetEvidence, type FleetResetReceipt,
} from '@propr/shared';
import { FleetFiles } from './files.js';

export const resetHash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => resetHash(canonicalFleetJson(value));
export const resetContractPin = resetHash(FLEET_RESET_SCHEMA);
export class ResetRefusal extends Error { constructor() { super('fleet_reset_unavailable'); } }
const refuse = (): never => { throw new ResetRefusal(); };
const mac = (value: unknown, secret: string, domain: 'request' | 'receipt') =>
  createHmac('sha256', secret).update(`${FLEET_RESET_CONTRACT}.${domain}\n`).update(canonicalFleetJson(value)).digest('hex');
export function resetRequestMac(assertion: FleetResetAssertion, secret: string) { return mac(assertion, secret, 'request'); }
function sameSecretDigest(left: string, right: string) {
  return /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function validSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 4096 && secret.trim() === secret;
}
const authoritySchema = z.strictObject({
  contract: z.literal(FLEET_RESET_CONTRACT), contractPin: z.literal(resetContractPin),
  audience: z.literal(FLEET_RESET_AUDIENCE), binding: fleetResetBindingSchema,
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/), enabled: z.literal(true),
});
const proofSchema = z.strictObject({
  binding: fleetResetBindingSchema, proofRequestId: fleetResetEnvelopeSchema.shape.assertion.shape.requestId,
  evidence: fleetResetEvidenceSchema, evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const unavailable = (reason: 'native_coverage_unavailable' | 'interrupted_or_corrupt'): FleetResetEvidence => ({
  state: 'recovery_required',
  categories: Object.fromEntries(FLEET_RESET_CATEGORIES.map(category => [category, 'unproven'])) as Extract<FleetResetEvidence, { state: 'recovery_required' }>['categories'],
  predecessorFenced: false, successorIsolated: false, bootstrapAllowed: false, reason,
});

/** Dedicated private authority; deliberately independent of the export/extension key.
 * Only the native state machine can produce terminal evidence. Missing native
 * adapters preserve the original refusal-only behavior.
 */
export class FleetResetProofPlane {
  readonly files: FleetFiles;
  private authorityBytes = '';
  private binding?: FleetResetBinding;
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(root: string, private readonly secret: () => string | undefined = () => process.env.PROPR_FLEET_RESET_SECRET,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly native?: NativeResetRuntime, private readonly receiptOnly = false) {
    this.files = new FleetFiles(root);
  }
  async initialize() {
    await this.files.initialize();
    this.authorityBytes = await this.files.read('authority.json');
    const authority = authoritySchema.parse(JSON.parse(this.authorityBytes));
    this.binding = authority.binding;
    await this.authority();
    await this.native?.initialize();
  }
  shutdown() { this.stopped = true; }
  private async authority() {
    if (this.stopped || !this.binding) refuse();
    const bytes = await this.files.read('authority.json');
    // A process never switches identities (including A -> B -> A) in place.
    if (bytes !== this.authorityBytes) { this.stopped = true; refuse(); }
    const authority = authoritySchema.parse(JSON.parse(bytes));
    const secret = this.secret();
    if (!validSecret(secret) || !sameSecretDigest(resetHash(secret), authority.secretSha256)) refuse();
    return secret as string;
  }
  private async authenticate(raw: string) {
    if (Buffer.byteLength(raw) > FLEET_RESET_LIMITS.requestBytes) refuse();
    const envelope = fleetResetEnvelopeSchema.parse(JSON.parse(raw));
    if (canonicalFleetJson(envelope) !== raw) refuse(); // Also rejects duplicate keys.
    const a = envelope.assertion;
    const secret = await this.authority();
    const now = this.now();
    if (a.contractPin !== resetContractPin || digest(a.binding) !== digest(this.binding)
      || a.issuedAt > now || a.expiresAt <= now || a.expiresAt <= a.issuedAt
      || a.expiresAt - a.issuedAt > FLEET_RESET_LIMITS.grantSeconds
      || !sameSecretDigest(envelope.mac, resetRequestMac(a, secret))) refuse();
    return a;
  }
  private async claim(a: FleetResetAssertion) {
    if ((await fs.readdir(this.files.root)).length + 3 > FLEET_RESET_LIMITS.entries) refuse();
    // Durable exclusive tombstones precede all work. Lost acknowledgements burn
    // admission; a fresh reset.receipt request observes without redispatching.
    await this.files.create(`nonce-${a.nonce}.json`, { requestId: a.requestId });
    await this.files.create(`request-${a.requestId}.json`, { action: a.action });
  }
  private async evidence(a: FleetResetAssertion): Promise<{ proofRequestId: string | null; evidence: FleetResetEvidence }> {
    const name = `proof-${a.binding.resetOperationId}.json`;
    if (a.action === 'reset.prove') {
      const evidence = unavailable('native_coverage_unavailable');
      // This exclusive claim is also the permanent operation fence. Repeating
      // reset.prove with a new request ID cannot reinterpret an earlier outcome.
      await this.files.create(name, {
        binding: a.binding, proofRequestId: a.requestId, evidence, evidenceDigest: digest(evidence),
      });
      if (this.native) {
        try {
          const terminal = await this.native.execute(a.binding);
          await this.files.create(`terminal-${a.binding.resetOperationId}.json`, {
            binding: a.binding, proofRequestId: a.requestId, evidence: terminal, evidenceDigest: digest(terminal),
          });
        } catch { /* The permanent claim and generation fence survive uncertainty. */ }
      }
    }
    try {
      const record = proofSchema.parse(JSON.parse(await this.files.read(name)));
      if (digest(record.binding) !== digest(a.binding) || record.evidenceDigest !== digest(record.evidence)) refuse();
      if (this.native) {
        try {
          const evidence = await this.native.reconcile(a.binding);
          // Recovery reads never redispatch reset. Terminal observations must
          // still match the originally durable proof when one exists.
          try {
            const terminal = proofSchema.parse(JSON.parse(await this.files.read(`terminal-${a.binding.resetOperationId}.json`)));
            if (digest(terminal.binding) !== digest(a.binding) || terminal.proofRequestId !== record.proofRequestId ||
              terminal.evidenceDigest !== digest(evidence) || digest(terminal.evidence) !== digest(evidence)) refuse();
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          return { proofRequestId: record.proofRequestId, evidence };
        } catch { return { proofRequestId: record.proofRequestId, evidence: unavailable('interrupted_or_corrupt') }; }
      }
      return { proofRequestId: record.proofRequestId, evidence: record.evidence };
    } catch {
      // Missing/torn records are uncertainty, never absence proof. Do not repair,
      // reissue effects, or reflect storage/parser errors into logs or receipts.
      return { proofRequestId: null, evidence: unavailable('interrupted_or_corrupt') };
    }
  }
  async invoke(raw: string) {
    // Serialize reads and effects in-process; exclusive filesystem claims are
    // the cross-process admission boundary. No time-based lock stealing.
    const work = this.tail.then(async () => {
      try {
        const a = await this.authenticate(raw);
        if (this.receiptOnly && a.action !== 'reset.receipt') refuse();
        await this.claim(a);
        const result = await this.evidence(a);
        // Recheck credentials, binding and expiry after every awaited operation.
        await this.authenticate(raw);
        const secret = await this.authority();
        const observedAt = this.now();
        if (observedAt >= a.expiresAt) refuse();
        const receipt: FleetResetReceipt = {
          contract: FLEET_RESET_CONTRACT, contractPin: resetContractPin, audience: FLEET_RESET_AUDIENCE,
          binding: a.binding, action: a.action, requestId: a.requestId, requestDigest: resetHash(raw),
          proofRequestId: result.proofRequestId, evidenceDigest: digest(result.evidence),
          observedAt, expiresAt: a.expiresAt, evidence: result.evidence,
        };
        return fleetResetSignedReceiptSchema.parse({ receipt, mac: mac(receipt, secret, 'receipt') });
      } catch { throw new ResetRefusal(); }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

/** Consumer verifier. The expected fresh request is mandatory: authentic receipts
 * for a different reset, request, scope, runtime, or build are not transferable. */
export function verifyResetReceipt(value: unknown, rawRequest: string, secret: string, now = Math.floor(Date.now() / 1000)) {
  try {
    if (!validSecret(secret)) refuse();
    const envelope = fleetResetEnvelopeSchema.parse(JSON.parse(rawRequest));
    if (canonicalFleetJson(envelope) !== rawRequest || !sameSecretDigest(envelope.mac, resetRequestMac(envelope.assertion, secret))) refuse();
    const signed = fleetResetSignedReceiptSchema.parse(value);
    const { receipt } = signed; const a = envelope.assertion;
    if (a.contractPin !== resetContractPin || receipt.contractPin !== resetContractPin
      || receipt.action !== a.action || receipt.requestId !== a.requestId || receipt.requestDigest !== resetHash(rawRequest)
      || digest(receipt.binding) !== digest(a.binding) || receipt.evidenceDigest !== digest(receipt.evidence)
      || a.issuedAt > receipt.observedAt || receipt.observedAt > now || receipt.expiresAt <= now
      || receipt.expiresAt !== a.expiresAt || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > FLEET_RESET_LIMITS.grantSeconds
      || !sameSecretDigest(signed.mac, mac(receipt, secret, 'receipt'))) refuse();
    return receipt;
  } catch { throw new ResetRefusal(); }
}
