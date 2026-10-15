import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign, createHmac } from 'node:crypto';
import { canonicalFleetJson as canonical, EXTENSION_AUTHORITY_V2_SCHEMA as schema, EXTENSION_AUTHORITY_V2 as contract } from '../packages/shared/dist/index.js';
const root = 'docs/contracts/extension-authority-v2/';
const hash = s => createHash('sha256').update(s).digest('hex');
const digest = v => hash(canonical(v));
const contractPin = hash(schema);
// Public deterministic test seeds only. Production keys are never generated here.
const testKey = byte => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]), type: 'pkcs8', format: 'der' });
const core = testKey(71), routingKey = testKey(72);
const spki = k => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('base64url');
const trust = { contract, keyId: 'synthetic-routing', keyEpoch: '1', authorityEpoch: '1', publicKey: spki(routingKey), producerRevision: 'a'.repeat(64), producerEpoch: '1' };
const old = JSON.parse(readFileSync('docs/contracts/extension-authority-v1/fixtures.json', 'utf8')).request;
const scope = { accountId: 'account', installationId: 'installation', tenantId: 'tenant', targetId: 'target' };
for (const field of ['actor', 'membership', 'security', 'passkey', 'account', 'installation', 'tenant', 'target', 'placement', 'runtime', 'storage', 'extension']) scope[field + 'Epoch'] = '1';
const work = { extension: { ...old.extension, nonce: 'f'.repeat(64), issuedAt: 1800000000, expiresAt: 1800000030 }, extensionInstanceId: old.extensionInstanceId, workDigest: old.workDigest, acquisitionOperationId: null, coreAuthorityEpoch: '2', scope };
const secret = 'PUBLIC-SYNTHETIC-V2-TRANSPORT-SECRET';
let dispatchDecisionDigest;
const phases = ['request', 'dispatch', 'completion', 'status'].map((phase, i) => {
  const request = { contract, contractPin, work, phase, challenge: String(i + 1).repeat(64), issuedAt: 1800000000, expiresAt: 1800000030 };
  const { publicKey, contract: _, ...authority } = trust;
  const statement = { contract: 'propr.routing-extension-authorization.v2', request, decision: 'allow', ...authority, checkedAt: 1800000001, expiresAt: request.expiresAt };
  const routing = { statement, signature: sign(null, Buffer.from(canonical(statement)), routingKey).toString('base64url') };
  const coreDecision = { requestDigest: digest(request), workDigest: digest(work), authorityEpoch: '2', actorId: work.extension.githubActorId, role: 'admin', source: 'local', permission: 'instance.manage_settings', checkedAt: 1800000001 };
  const routingDigest = digest(routing), trustDigest = digest(trust);
  const combinedDecisionDigest = digest({ coreDecision, routingDigest, trustDigest });
  if (phase === 'dispatch') dispatchDecisionDigest = combinedDecisionDigest;
  const result = { recipientCommitment: null, state: i ? 'completed' : 'admitted', nativeResultDigest: i ? digest({ contract: work.extension.contract, operationId: work.extension.operationId, state: 'completed', result: { profiles: [] } }) : null, dispatchDecisionDigest: dispatchDecisionDigest ?? null };
  const proof = { contract, contractPin, request, coreDecision, routingDigest, trustDigest, combinedDecisionDigest, result, resultDigest: digest(result), committedAt: 1800000001, expiresAt: request.expiresAt };
  return { request, routing, envelopeCanonical: canonical({ request, routing, mac: createHmac('sha256', secret).update(canonical({ request, routing })).digest('hex'), ...(phase === 'dispatch' ? { native: { action: work.extension.action } } : {}) }), responseCanonical: canonical({ statement: proof, signature: sign(null, Buffer.from(canonical(proof)), core).toString('base64url') }) };
});
const artifacts = { 'schema.json': schema, 'fixtures.json': JSON.stringify({ trust, coreSPKI: spki(core), nowMs: 1800000001000, secret, phases }, null, 2) + '\n',
  'capabilities.json': JSON.stringify({ contract, contractPin, publicReady: false, downstreamReady: false, selectedRuntimeQualified: false,
    actions: Object.fromEntries(['profile.list', 'profile.read', 'profile.history', 'profile.create', 'profile.update', 'profile.disable', 'profile.delete', 'catalog.list', 'skill.list', 'skill.import', 'profile.validate', 'selection.validate', 'recipient.issue', 'operation.status'].map(a => [a, false])) }, null, 2) + '\n' };
const source = ['packages/shared/src/extensionAuthorityV2.ts', 'packages/core/src/fleet/extensionAuthorityV2.ts', 'packages/core/src/fleet/extensions.ts', 'packages/core/src/extensions/extensionProfileStore.ts', 'packages/core/src/db/migrations/20261015130000_extension_authority_v2.js', 'packages/core/src/db/migrations/20261015070000_extension_authority_epoch.js', 'packages/api/fleetDataListener.ts', 'packages/core/src/fleet/files.ts', 'packages/core/src/fleet/dataPlane.ts', 'packages/core/src/fleet/resetFence.ts', 'packages/shared/src/fleetExtensions.ts', 'packages/shared/src/extensionAuthorityProof.ts', 'packages/shared/src/instanceAuthorization.ts', 'packages/shared/src/extensionProfiles.ts', 'packages/core/src/extensions/privateSecrets.ts', 'packages/core/src/extensions/remoteGitSkill.ts', 'packages/core/src/storage/service.ts', 'packages/core/src/storage/proofIdentity.ts', 'packages/core/test/extensionAuthorityV2.test.ts', 'packages/core/test/extensionAuthorityV2Crash.test.ts', 'packages/core/test/helpers/extensionAuthorityV2Fixture.ts', 'packages/core/test/helpers/extensionAuthorityV2Crash.ts', 'scripts/generate-extension-authority-v2-fixtures.mjs'];
artifacts['source-pins.json'] = JSON.stringify(Object.fromEntries(source.map(p => [p, hash(readFileSync(p))])), null, 2) + '\n';
for (const [name, value] of Object.entries(artifacts)) {
  if (process.argv.includes('--check')) { if (readFileSync(root + name, 'utf8') !== value) throw Error(`Stale ${name}`); }
  else writeFileSync(root + name, value);
}
const sums = [...Object.keys(artifacts), 'verifier.mjs', 'README.md', 'fault-transcript.txt', 'crash-transcript.txt'].map(name => `${hash(readFileSync(root + name))}  ${name}\n`).join('');
if (process.argv.includes('--check')) { if (readFileSync(root + 'SHA256SUMS', 'utf8') !== sums) throw Error('Stale checksums'); }
else writeFileSync(root + 'SHA256SUMS', sums);
