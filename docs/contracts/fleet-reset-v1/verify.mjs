// Dependency-free consumer reference. No IO, logging, execution, or credentials in errors.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const contract = 'propr.fleet-reset.v1';
const audience = 'fleet-reset-coordinator';
const categories = ['database', 'configuration', 'repositories_worktrees_caches', 'active_tasks', 'queued_tasks', 'unpublished_results', 'provider_sessions', 'tunnel_bootstrap', 'diagnostic_logs'];
const check = ok => { if (!ok) throw new Error('fleet_reset_unavailable'); };
const exact = (value, keys) => check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys.sort().join());
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => sha256(canonical(value));
function identity(value) {
  exact(value, ['generation', 'stateScope', 'runtimeId', 'storageId']);
  check(integer(value.generation) && typeof value.stateScope === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value.stateScope) && uuid(value.runtimeId) && uuid(value.storageId));
}
function binding(value) {
  exact(value, ['resetOperationId', 'resetRequestDigest', 'resetAction', 'instanceId', 'predecessor', 'successor', 'runtimeBuildDigest']);
  check(uuid(value.resetOperationId) && hash(value.resetRequestDigest) && value.resetAction === 'instance.reset' && hash(value.runtimeBuildDigest)
    && typeof value.instanceId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.instanceId));
  identity(value.predecessor); identity(value.successor);
  check(value.successor.generation === value.predecessor.generation + 1 && value.successor.stateScope === `reset:${value.resetOperationId}`
    && ['stateScope', 'runtimeId', 'storageId'].every(k => value.predecessor[k] !== value.successor[k]));
}
function verifyMac(value, supplied, secret, domain) {
  check(typeof secret === 'string' && Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 4096 && secret.trim() === secret && hash(supplied));
  const expected = createHmac('sha256', secret).update(`${contract}.${domain}\n`).update(canonical(value)).digest();
  check(timingSafeEqual(expected, Buffer.from(supplied, 'hex')));
}
export function verifyRequest(raw, secret, contractPin, expectedBinding, now) {
  try {
    check(typeof raw === 'string' && Buffer.byteLength(raw) <= 8192 && hash(contractPin) && integer(now));
    const envelope = JSON.parse(raw); exact(envelope, ['assertion', 'mac']); check(canonical(envelope) === raw);
    const a = envelope.assertion;
    exact(a, ['contract', 'contractPin', 'audience', 'binding', 'action', 'requestId', 'nonce', 'issuedAt', 'expiresAt']);
    binding(a.binding);
    check(a.contract === contract && a.contractPin === contractPin && a.audience === audience
      && ['reset.prove', 'reset.receipt'].includes(a.action) && uuid(a.requestId) && hash(a.nonce)
      && integer(a.issuedAt) && integer(a.expiresAt) && a.issuedAt <= now && a.expiresAt > now
      && a.expiresAt > a.issuedAt && a.expiresAt - a.issuedAt <= 30 && digest(a.binding) === digest(expectedBinding));
    verifyMac(a, envelope.mac, secret, 'request'); return a;
  } catch { throw new Error('fleet_reset_unavailable'); }
}
export function verifyReceipt(value, rawRequest, secret, contractPin, expectedBinding, now) {
  try {
    const a = verifyRequest(rawRequest, secret, contractPin, expectedBinding, now);
    exact(value, ['receipt', 'mac']); const r = value.receipt;
    exact(r, ['contract', 'contractPin', 'audience', 'binding', 'action', 'requestId', 'requestDigest', 'proofRequestId', 'evidenceDigest', 'observedAt', 'expiresAt', 'evidence']);
    binding(r.binding);
    check(r.contract === contract && r.contractPin === contractPin && r.audience === audience
      && r.action === a.action && r.requestId === a.requestId && r.requestDigest === sha256(rawRequest)
      && (r.proofRequestId === null || uuid(r.proofRequestId)) && r.evidenceDigest === digest(r.evidence)
      && digest(r.binding) === digest(expectedBinding) && integer(r.observedAt) && r.observedAt <= now
      && r.observedAt >= a.issuedAt && r.expiresAt === a.expiresAt);
    exact(r.evidence, ['state', 'categories', 'predecessorFenced', 'successorIsolated', 'bootstrapAllowed', 'reason', ...(r.evidence.state === 'complete' ? ['observationDigest'] : [])]);
    exact(r.evidence.categories, [...categories]);
    check((r.evidence.state === 'recovery_required' && categories.every(k => r.evidence.categories[k] === 'unproven')
      && r.evidence.predecessorFenced === false && r.evidence.successorIsolated === false && r.evidence.bootstrapAllowed === false
      && ['native_coverage_unavailable', 'interrupted_or_corrupt'].includes(r.evidence.reason))
      || (r.evidence.state === 'complete' && categories.every(k => r.evidence.categories[k] === 'erased')
        && r.evidence.predecessorFenced === true && r.evidence.successorIsolated === true && r.evidence.bootstrapAllowed === true
        && r.evidence.reason === 'stable_native_proof' && hash(r.evidence.observationDigest)));
    verifyMac(r, value.mac, secret, 'receipt'); return r;
  } catch { throw new Error('fleet_reset_unavailable'); }
}
