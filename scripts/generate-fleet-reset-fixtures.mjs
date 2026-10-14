// Public synthetic fixtures. Never use this key or these historic grants live.
import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { FLEET_RESET_SCHEMA, FLEET_RESET_CONTRACT as contract, FLEET_RESET_AUDIENCE as audience, FLEET_RESET_CATEGORIES } from '../packages/shared/dist/fleetReset.js';
import { canonicalFleetJson as canonical } from '../packages/shared/dist/fleetData.js';
const root = new URL('../docs/contracts/fleet-reset-v1/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const contractPin = hash(FLEET_RESET_SCHEMA);
const testSecret = 'PUBLIC-RESET-FIXTURE-KEY-NOT-FOR-PRODUCTION';
const sign = (value, domain) => createHmac('sha256', testSecret).update(`${contract}.${domain}\n`).update(canonical(value)).digest('hex');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = {
  resetOperationId: id(1), resetRequestDigest: 'a'.repeat(64), resetAction: 'instance.reset', instanceId: 'fixture-instance',
  predecessor: { generation: 1, stateScope: 'initial', runtimeId: id(2), storageId: id(3) },
  successor: { generation: 2, stateScope: `reset:${id(1)}`, runtimeId: id(4), storageId: id(5) }, runtimeBuildDigest: 'b'.repeat(64),
};
const evidence = { state: 'recovery_required', categories: Object.fromEntries(FLEET_RESET_CATEGORIES.map(k => [k, 'unproven'])),
  predecessorFenced: false, successorIsolated: false, bootstrapAllowed: false, reason: 'native_coverage_unavailable' };
const fixtures = ['reset.prove', 'reset.receipt', 'reset.prove', 'reset.receipt'].map((action, index) => {
  const observed = index < 2 ? evidence : { state: 'complete', categories: Object.fromEntries(FLEET_RESET_CATEGORIES.map(k => [k, 'erased'])), predecessorFenced: true, successorIsolated: true, bootstrapAllowed: true, reason: 'stable_native_proof', observationDigest: 'c'.repeat(64) };
  const assertion = { contract, contractPin, audience, binding, action, requestId: id(10 + index), nonce: String(index + 1).padStart(64, '0'), issuedAt: 1791892800, expiresAt: 1791892830 };
  const request = canonical({ assertion, mac: sign(assertion, 'request') });
  const receipt = { contract, contractPin, audience, binding, action, requestId: assertion.requestId, requestDigest: hash(request),
    proofRequestId: id(10), evidenceDigest: hash(canonical(observed)), observedAt: assertion.issuedAt, expiresAt: assertion.expiresAt, evidence: observed };
  const response = canonical({ receipt, mac: sign(receipt, 'receipt') });
  return { action, request, requestSha256: hash(request), response, responseSha256: hash(response) };
});
const artifacts = {
  'schema.json': FLEET_RESET_SCHEMA,
  'fixtures.json': JSON.stringify({ contractPin, testSecret, now: 1791892800, binding, fixtures }, null, 2) + '\n',
  'capabilities.json': JSON.stringify({ contract, public: false, destructiveEffects: false, terminalProof: false, successorBootstrap: false,
    nativeCoverage: 'opt-in-native-adapters', qualification: 'disposable-local-integration', reason: 'Hosted enablement remains off. Terminal proof requires provisioned native ownership, closed Core resources and stable external generation refusal; unavailable proof remains recovery_required.' }, null, 2) + '\n',
  'verify.mjs': await readFile(new URL('verify.mjs', root), 'utf8'),
};
const pin = JSON.stringify({ contract, contractPin, files: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, hash(bytes)])) }, null, 2) + '\n';
artifacts['pin.json'] = pin;
for (const [name, bytes] of Object.entries(artifacts)) await writeFile(new URL(name, root), bytes);
await writeFile(new URL('SHA256SUMS', root), Object.entries(artifacts).map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join(''));
