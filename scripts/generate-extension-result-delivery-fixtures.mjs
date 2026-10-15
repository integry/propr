import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, createECDH, sign } from 'node:crypto';
import { canonicalFleetJson as canonical, EXTENSION_RESULT_DELIVERY_SCHEMA as schema, EXTENSION_RESULT_DELIVERY as contract, EXTENSION_RESULT_DELIVERY_LIMITS as limits, EXTENSION_LIMITS, FLEET_EXTENSION_CONTRACT, extensionPublicResultSchemas, fleetExtensionRecipientSchema, extensionSelectionSchema } from '../packages/shared/dist/index.js';
import { z } from 'zod';
const root = 'docs/contracts/extension-result-delivery-v1/';
const hash = s => createHash('sha256').update(s).digest('hex');
const digest = v => hash(canonical(v));
const key = b => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, b)]), type: 'pkcs8', format: 'der' });
const core = key(71), routingKey = key(72), recipientKey = key(73);
const spki = k => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('base64url');
const signed = statement => ({ statement, signature: sign(null, Buffer.from(canonical(statement)), core).toString('base64url') });
const v2 = JSON.parse(readFileSync('docs/contracts/extension-authority-v2/fixtures.json'));
const old = JSON.parse(readFileSync('docs/contracts/fleet-extensions-v1-qualified/fixtures.json'));
const requests = old.requests.map(f => JSON.parse(f.canonical).request);
const selection = requests.find(r => r.action === 'profile.read').selection;
const input = requests.find(r => r.action === 'profile.create').input;
const profile = { ...input, ...selection, createdAt: 1800000000000, updatedAt: 1800000000000, auditActor: '100', secrets: {}, skillBundles: [] };
const bundle = { ...JSON.parse(old.skillImportResult.canonical).result.bundle, instanceId: selection.instanceId };
const fixtures = requests.map((native, i) => {
  const base = v2.phases[1];
  const expected = structuredClone(base.request);
  expected.challenge = (i + 1).toString(16).padStart(64, '0');
  expected.work.extension = { ...expected.work.extension, action: native.action, requestDigest: digest(native), operationId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` };
  expected.work.extensionInstanceId = selection.instanceId;
  const routingStatement = { ...base.routing.statement, request: expected };
  const routing = { statement: routingStatement, signature: sign(null, Buffer.from(canonical(routingStatement)), routingKey).toString('base64url') };
  let result;
  switch (native.action) {
    case 'profile.list': result = { instanceId: selection.instanceId, profiles: [profile] }; break;
    case 'profile.history': result = { revisions: [profile] }; break;
    case 'profile.create': case 'profile.read': result = { profile }; break;
    case 'profile.update': case 'profile.disable': result = { profile: { ...profile, revision: native.selection.revision + 1 } }; break;
    case 'profile.delete': result = { deleted: true }; break;
    case 'catalog.list': result = { catalog: [] }; break;
    case 'skill.list': result = { bundles: [bundle] }; break;
    case 'skill.import': result = { bundle: { ...bundle, source: { kind: 'github', repository: native.repository, commit: native.commit, directory: native.directory } } }; break;
    case 'profile.validate': result = { results: [{ name: 'docs', status: 'unavailable' }] }; break;
    case 'selection.validate': result = { selection: native.selection, valid: true }; break;
    case 'operation.status': result = { operationId: native.targetOperationId, state: 'fenced' }; break;
    case 'recipient.issue': {
      const recipientId = '00000000-0000-4000-8000-000000000300', intentDigest = digest(native.intent);
      const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.alloc(32, 1));
      const publicRecipient = { recipientId, algorithm: 'P-256-ECDH/HKDF-SHA256/AES-256-GCM', publicKey: ecdh.getPublicKey().toString('base64url'),
        binding: { contract: FLEET_EXTENSION_CONTRACT, audience: 'core-extension-mutation', assertion: expected.work.extension, extensionInstanceId: expected.work.extensionInstanceId,
          action: native.intent.action, intentDigest, target: native.intent.action === 'profile.create' ? { kind: 'create', intentDigest } : { kind: 'revision', selection: native.intent.selection },
          mutationOperationId: native.mutationOperationId, server: native.server, field: native.field, recipientId, expiresAt: expected.work.extension.expiresAt } };
      result = { ...publicRecipient, signature: sign(null, Buffer.from(canonical(publicRecipient)), recipientKey).toString('base64url') }; break;
    }
  }
  const envelope = { contract: FLEET_EXTENSION_CONTRACT, operationId: expected.work.extension.operationId, state: 'completed', result };
  const statement = structuredClone(JSON.parse(base.responseCanonical).statement);
  statement.request = expected;
  statement.coreDecision.requestDigest = digest(expected); statement.coreDecision.workDigest = digest(expected.work);
  statement.routingDigest = digest(routing);
  statement.combinedDecisionDigest = digest({ coreDecision: statement.coreDecision, routingDigest: statement.routingDigest, trustDigest: statement.trustDigest });
  statement.result = { state: 'completed', nativeResultDigest: digest(envelope), dispatchDecisionDigest: statement.combinedDecisionDigest,
    recipientCommitment: native.action === 'recipient.issue' ? { operationId: native.mutationOperationId, intentDigest: digest(native.intent) } : null };
  statement.resultDigest = digest(statement.result);
  const receipt = signed(statement);
  return { expected, native, routing, first: canonical({ contract, receipt, delivery: { state: 'available', action: native.action, native: envelope } }), replay: canonical({ contract, receipt, delivery: { state: 'unavailable' } }) };
});
const json = v => JSON.stringify(v, null, 2) + '\n';
const artifacts = { 'schema.json': schema, 'fixtures.json': json({ trust: v2.trust, coreSPKI: spki(core), recipientSPKI: spki(recipientKey), nowMs: v2.nowMs, fixtures }),
  'capabilities.json': json({ contract, contractPin: hash(schema), publicReady: false, downstreamReady: false, routingReady: false, fleet104Ready: false, browserReady: false, selectedRuntimeQualified: false, actions: Object.fromEntries(Object.keys(extensionPublicResultSchemas).map(a => [a, false])) }),
  'authority-schema.json': readFileSync('docs/contracts/extension-authority-v2/schema.json', 'utf8'),
  'authority-verifier.mjs': readFileSync('docs/contracts/extension-authority-v2/verifier.mjs', 'utf8').replace("'./schema.json'", "'./authority-schema.json'"),
};
// Generate the binding algorithm from the exact shared implementation, using a
// standalone schema adapter. No second hand-maintained interpretation of bindings.
const schemas = Object.fromEntries(Object.entries(extensionPublicResultSchemas).map(([a, s]) => [a, z.toJSONSchema(s)]));
const functionSource = readFileSync('packages/shared/dist/extensionResultDelivery.js', 'utf8').split('export function parseExtensionResultDelivery')[1].split('//# sourceMappingURL')[0];
artifacts['binding-parser.mjs'] = `// Generated; do not edit.\nimport { readFileSync } from 'node:fs';\nimport { canonical } from './authority-verifier.mjs';\nimport { valid } from './schema-validator.mjs';\nconst adapt = schema => ({ parse(value) { if (!valid(schema, value)) throw Error(); return value; } });\nconst extensionResultDeliverySchema = adapt(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url))).response);\nconst EXTENSION_RESULT_DELIVERY_LIMITS = ${canonical(limits)};\nconst EXTENSION_LIMITS = ${canonical(EXTENSION_LIMITS)};\nconst FLEET_EXTENSION_CONTRACT = ${JSON.stringify(FLEET_EXTENSION_CONTRACT)};\nconst extensionPublicResultSchemas = Object.fromEntries(Object.entries(${canonical(schemas)}).map(([a, s]) => [a, adapt(s)]));\nconst fleetExtensionRecipientSchema = adapt(${canonical(z.toJSONSchema(fleetExtensionRecipientSchema))});\nconst extensionSelectionSchema = adapt(${canonical(z.toJSONSchema(extensionSelectionSchema))});\nexport function parseExtensionResultDelivery${functionSource}`;
const sources = [...Object.keys(JSON.parse(readFileSync('docs/contracts/extension-authority-v2/source-pins.json'))), 'packages/shared/src/extensionResultDelivery.ts', 'packages/shared/src/index.ts', 'packages/core/test/extensionResultDelivery.test.ts', 'scripts/generate-extension-result-delivery-fixtures.mjs'];
artifacts['source-pins.json'] = json(Object.fromEntries(sources.map(p => [p, hash(readFileSync(p))])));
for (const [name, bytes] of Object.entries(artifacts)) {
  if (process.argv.includes('--check')) { if (readFileSync(root + name, 'utf8') !== bytes) throw Error(`Stale ${name}`); }
  else writeFileSync(root + name, bytes);
}
const sums = [...Object.keys(artifacts), 'verifier.mjs', 'schema-validator.mjs', 'README.md'].map(name => `${hash(readFileSync(root + name))}  ${name}\n`).join('');
if (process.argv.includes('--check')) { if (readFileSync(root + 'SHA256SUMS', 'utf8') !== sums) throw Error('Stale checksums'); }
else writeFileSync(root + 'SHA256SUMS', sums);
