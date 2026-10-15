import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(new URL('./schema.json', import.meta.url), 'utf8');
const schema = JSON.parse(bytes);
export const contractPin = hash(bytes);
// Validator for the fixed JSON Schema vocabulary in this pinned bundle.
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
/** expected is constructed from independently held original work, actor and native pins.
 * consumed must be persisted by the consumer across retries/restarts before acting. */
export function verifyProof(response, expected, publicKeyPin, nowMs, consumed) {
  try {
    if (!publicKeyPin || !(consumed instanceof Set) || !Number.isSafeInteger(nowMs) || !valid(schema.response, response)
      || !valid(schema.envelope.properties.request, expected)) throw Error();
    const s = response.statement;
    if (s.contractPin !== contractPin || expected.contractPin !== contractPin || canonical(s.request) !== canonical(expected)
      || s.requestCommitment !== hash(canonical(expected)) || s.expiresAt !== expected.expiresAt
      || expected.issuedAt * 1000 > nowMs || nowMs >= expected.expiresAt * 1000
      || expected.expiresAt <= expected.issuedAt || expected.expiresAt - expected.issuedAt > schema.limits.seconds
      || s.observedAt < expected.issuedAt || s.observedAt * 1000 > nowMs || s.observedAt >= s.expiresAt
      || (expected.authorityEpoch !== null && expected.authorityEpoch !== s.authorityEpoch)
      || consumed.has(expected.challenge)) throw Error();
    const key = createPublicKey({ key: Buffer.from(publicKeyPin, 'base64url'), type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(s)), key, Buffer.from(response.signature, 'base64url'))) throw Error();
    consumed.add(expected.challenge);
    return s;
  } catch { throw Error('extension_authority_unavailable'); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [response, expected, pin, now] = process.argv.slice(2);
    verifyProof(JSON.parse(readFileSync(response, 'utf8')), JSON.parse(readFileSync(expected, 'utf8')),
      readFileSync(pin, 'utf8').trim(), Number(now), new Set());
    process.stdout.write('verified\n');
  } catch { process.stderr.write('extension_authority_unavailable\n'); process.exitCode = 1; }
}
