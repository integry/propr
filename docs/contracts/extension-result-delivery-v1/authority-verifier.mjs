import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(new URL('./authority-schema.json', import.meta.url), 'utf8');
export const contractPin = hash(bytes);
const schema = JSON.parse(bytes);
export function valid(s, v) {
  if (s.not && valid(s.not, v)) return false;
  if (s.anyOf && !s.anyOf.some(x => valid(x, v))) return false;
  if (s.const !== undefined && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === 'null' && v !== null) return false;
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties, k))) return false;
    if (Object.entries(s.properties ?? {}).some(([k, t]) => Object.hasOwn(v, k) && !valid(t, v[k]))) return false;
  }
  if (s.type === 'string') {
    if (typeof v !== 'string' || (s.pattern && !new RegExp(s.pattern).test(v)) || (s.minLength !== undefined && v.length < s.minLength)
      || (s.maxLength !== undefined && v.length > s.maxLength)) return false;
    // UUID vocabulary is fully specified by the pinned pattern, including nil/max.
    // Do not narrow it with a second interpretation of the format annotation.
  }
  if ((s.type === 'integer' || s.type === 'number') && (typeof v !== 'number' || !Number.isSafeInteger(v)
    || (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) || (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum)
    || (s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return false;
  if (s.type === 'boolean' && typeof v !== 'boolean') return false;
  return true;
}

function key(pin) {
  const k = createPublicKey({ key: Buffer.from(pin, 'base64url'), type: 'spki', format: 'der' });
  if (k.asymmetricKeyType !== 'ed25519' || k.export({ type: 'spki', format: 'der' }).toString('base64url') !== pin) throw Error();
  return k;
}
function signature(statement, sig, pin) {
  const b = Buffer.from(sig, 'base64url');
  if (b.toString('base64url') !== sig || !verify(null, Buffer.from(canonical(statement)), key(pin), b)) throw Error();
}
/** All expected values and both public trust boundaries come from the caller's
 * independently retained work/configuration, NEVER from the received response.
 * raw must be the actual UTF-8 wire string (not reserialized parsed JSON).
 * A receipt verifies history, not permission to redispatch. Persist consumed
 * challenges before acting; an exact retry may only reconcile the same receipt. */
export function verifyProof(raw, expected, routing, trust, coreSPKI, nowMs, consumed) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > schema.limits.responseBytes
      || !Number.isSafeInteger(nowMs) || !(consumed instanceof Set)) throw Error();
    const response = JSON.parse(raw), s = response.statement;
    if (canonical(response) !== raw || !valid(schema.response, response)
      || !valid(schema.envelope.properties.request, expected) || !valid(schema.trust, trust)
      || !valid(schema.envelope.properties.routing, routing)) throw Error();
    if (s.contractPin !== contractPin || expected.contractPin !== contractPin
      || canonical(s.request) !== canonical(expected) || canonical(routing.statement.request) !== canonical(expected)
      || s.routingDigest !== hash(canonical(routing)) || s.trustDigest !== hash(canonical(trust))
      || s.coreDecision.requestDigest !== hash(canonical(expected)) || s.coreDecision.workDigest !== hash(canonical(expected.work))
      || s.coreDecision.authorityEpoch !== expected.work.coreAuthorityEpoch || s.coreDecision.actorId !== expected.work.extension.githubActorId
      || s.combinedDecisionDigest !== hash(canonical({ coreDecision: s.coreDecision, routingDigest: s.routingDigest, trustDigest: s.trustDigest }))
      || s.resultDigest !== hash(canonical(s.result)) || s.expiresAt !== expected.expiresAt
      || routing.statement.expiresAt !== expected.expiresAt || expected.issuedAt * 1000 > nowMs || nowMs >= expected.expiresAt * 1000
      || expected.expiresAt <= expected.issuedAt || expected.expiresAt - expected.issuedAt > schema.limits.seconds
      || consumed.has(expected.challenge)) throw Error();
    for (const f of ['keyId', 'keyEpoch', 'authorityEpoch', 'producerRevision', 'producerEpoch']) if (routing.statement[f] !== trust[f]) throw Error();
    for (const t of [routing.statement.checkedAt, s.coreDecision.checkedAt, s.committedAt]) {
      if (t < expected.issuedAt || t * 1000 > nowMs || t >= expected.expiresAt) throw Error();
    }
    if (s.coreDecision.checkedAt > s.committedAt) throw Error();
    if (expected.phase === 'request' && (s.result.state !== 'admitted' || s.result.nativeResultDigest !== null || s.result.dispatchDecisionDigest !== null || s.result.recipientCommitment !== null)) throw Error();
    if (['dispatch', 'completion'].includes(expected.phase) && (s.result.state !== 'completed' || !s.result.nativeResultDigest || !s.result.dispatchDecisionDigest)) throw Error();
    if (expected.phase === 'dispatch' && s.result.dispatchDecisionDigest !== s.combinedDecisionDigest) throw Error();
    if (s.result.recipientCommitment !== null && expected.work.extension.action !== 'recipient.issue') throw Error();
    if (expected.phase === 'dispatch' && expected.work.extension.action === 'recipient.issue' && s.result.recipientCommitment === null) throw Error();
    signature(routing.statement, routing.signature, trust.publicKey);
    signature(s, response.signature, coreSPKI);
    consumed.add(expected.challenge);
    return s;
  } catch { throw Error('extension_authority_unavailable'); }
}
