// Public synthetic fixtures only. Run after building @propr/shared; never changes Fleet data v1/v2.
import { createHash, createHmac, createECDH, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { canonicalFleetJson } from '../packages/shared/dist/fleetData.js';
import { FLEET_EXTENSION_SCHEMA, FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_SCOPE } from '../packages/shared/dist/fleetExtensions.js';
const root = new URL('../docs/contracts/fleet-extensions-v1/', import.meta.url);
await mkdir(root, { recursive: true });
const hash = s => createHash('sha256').update(s).digest('hex');
const pin = hash(FLEET_EXTENSION_SCHEMA); const testSecret = 'PUBLIC-FIXTURE-KEY-NOT-A-PRODUCTION-SECRET';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = { instanceId: id(200), profileId: id(201), revision: 1 };
const input = { version: 1, name: 'Synthetic profile', enabled: false, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }], skillBundleIds: [] };
const requests = [
  { action: 'profile.list' }, { action: 'profile.read', selection }, { action: 'profile.history', profileId: selection.profileId },
  { action: 'profile.create', input, sealed: [] }, { action: 'profile.update', input, selection, sealed: [] },
  { action: 'profile.disable', selection }, { action: 'profile.delete', selection }, { action: 'catalog.list' }, { action: 'skill.list' },
  { action: 'skill.import', repository: 'synthetic/skills', commit: 'a'.repeat(40), directory: 'skills/demo' },
  { action: 'profile.validate', selection }, { action: 'selection.validate', selection, context: { runtime: 'claude', agentAlias: 'claude-main', repositories: ['synthetic/skills'], allowWrite: false } },
  { action: 'recipient.issue', intent: { action: 'profile.create', input }, mutationOperationId: id(4), server: 'docs', field: 'bearerToken' },
  { action: 'operation.status', targetOperationId: id(4) },
];
const fixtures = JSON.stringify({ contractPin: pin, testSecret, requests: requests.map((request, index) => {
  const assertion = { contract: FLEET_EXTENSION_CONTRACT, contractPin: pin, scope: FLEET_EXTENSION_SCOPE, githubActorId: 100, hostedInstanceId: 'fixture-hosted-a', storageInstanceId: id(100), runtimeGeneration: id(101), storageGeneration: id(102), placementGeneration: 'placement-42', action: request.action, operationId: id(index + 1), nonce: String(index + 1).padStart(64, '0'), issuedAt: 1791892800, expiresAt: 1791892860, requestDigest: hash(canonicalFleetJson(request)) };
  const canonical = canonicalFleetJson({ assertion, request, mac: createHmac('sha256', testSecret).update(canonicalFleetJson(assertion)).digest('hex') });
  return { action: request.action, canonical, sha256: hash(canonical) };
}) }, null, 2) + '\n';
// Deterministic PUBLIC fixture signing/agreement keys; these are never deployment authority.
const fixtureBundle = JSON.parse(fixtures);
const acquisition = JSON.parse(fixtureBundle.requests.find(r => r.action === 'recipient.issue').canonical).assertion;
const agreement = createECDH('prime256v1'); agreement.setPrivateKey(Buffer.alloc(32, 1));
const signing = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8' });
const intentDigest = hash(canonicalFleetJson({ action: 'profile.create', input }));
const publicRecipient = { recipientId: id(300), algorithm: 'P-256-ECDH/HKDF-SHA256/AES-256-GCM', publicKey: agreement.getPublicKey().toString('base64url'), binding: { contract: FLEET_EXTENSION_CONTRACT, audience: 'core-extension-mutation', assertion: acquisition, extensionInstanceId: id(200), action: 'profile.create', intentDigest, target: { kind: 'create', intentDigest }, mutationOperationId: id(4), server: 'docs', field: 'bearerToken', recipientId: id(300), expiresAt: acquisition.expiresAt } };
const recipientCanonical = canonicalFleetJson({ ...publicRecipient, signature: sign(null, Buffer.from(canonicalFleetJson(publicRecipient)), signing).toString('base64url') });
fixtureBundle.recipient = { verificationKey: createPublicKey(signing).export({ format: 'der', type: 'spki' }).toString('base64url'), canonical: recipientCanonical, sha256: hash(recipientCanonical) };
const completeFixtures = JSON.stringify(fixtureBundle, null, 2) + '\n';
const capability = JSON.stringify({ contract: FLEET_EXTENSION_CONTRACT, contractPin: pin, transport: 'existing-private-fleet-unix-listener', path: '/extensions/v1/invoke', actions: requests.map(r => r.action), skillSources: ['github-exact-commit'], skillUpload: false, secretAlgorithm: 'P-256-ECDH/HKDF-SHA256/AES-256-GCM', recipientAuthentication: 'Ed25519-independent-native-SPKI-pin-and-exact-expected-binding', downstreamReady: false, compatibility: { fleetDataV1: 'unchanged', fleetDataV2: 'unchanged', nativeSameOrigin: 'preserved', publicEndpoint: false }, consumerGates: { fleet: 'reciprocal-suite-required', routing: 'reciprocal-suite-required', connect: 'separate-follow-up' }, localProof: 'packages/core/test/fleetExtensions.test.ts' }, null, 2) + '\n';
await writeFile(new URL('schema.json', root), FLEET_EXTENSION_SCHEMA);
await writeFile(new URL('fixtures.json', root), completeFixtures);
await writeFile(new URL('capabilities.json', root), capability);
await writeFile(new URL('SHA256SUMS', root), `${pin}  schema.json\n${hash(completeFixtures)}  fixtures.json\n${hash(capability)}  capabilities.json\n${hash(await readFile(new URL('README.md', root), 'utf8'))}  README.md\n`);
