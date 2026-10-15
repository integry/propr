import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign, createHmac } from 'node:crypto';
import { canonicalFleetJson as canonical, EXTENSION_AUTHORITY_SCHEMA, EXTENSION_AUTHORITY_CONTRACT, EXTENSION_AUTHORITY_PATH } from '../packages/shared/dist/index.js';
const root = 'docs/contracts/extension-authority-v1/';
const hash = s => createHash('sha256').update(s).digest('hex');
const contractPin = hash(EXTENSION_AUTHORITY_SCHEMA);
writeFileSync(root + 'schema.json', EXTENSION_AUTHORITY_SCHEMA);
const qualified = JSON.parse(readFileSync('docs/contracts/fleet-extensions-v1-qualified/fixtures.json', 'utf8'));
const { issuedAt, expiresAt, nonce, ...extension } = JSON.parse(qualified.requests[0].canonical).assertion;
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
const request = { contract: EXTENSION_AUTHORITY_CONTRACT, contractPin, extension,
  extensionInstanceId: '11111111-1111-4111-8111-111111111111', workDigest: hash('synthetic original work'),
  acquisitionOperationId: null, phase: 'request', challenge: 'a'.repeat(64), authorityEpoch: null,
  issuedAt: 1800000000, expiresAt: 1800000030 };
const response = r => {
  const statement = { contract: EXTENSION_AUTHORITY_CONTRACT, contractPin, request: r, requestCommitment: hash(canonical(r)),
    authorityEpoch: '2', role: 'admin', source: 'local', permission: 'instance.manage_settings', observedAt: 1800000001,
    expiresAt: r.expiresAt, connectAuthorityVerified: false };
  return { statement, signature: sign(null, Buffer.from(canonical(statement)), key).toString('base64url') };
};
const testSecret = 'PUBLIC-SYNTHETIC-TRANSPORT-SECRET-ONLY';
const phases = ['request', 'dispatch', 'status', 'completion'].map((phase, i) => {
  const r = { ...request, phase, authorityEpoch: i ? '2' : null, challenge: String(i + 1).repeat(64) };
  const envelope = { request: r, mac: createHmac('sha256', testSecret).update(canonical(r)).digest('hex') };
  return { requestCanonical: canonical(envelope), responseCanonical: canonical(response(r)) };
});
writeFileSync(root + 'fixtures.json', JSON.stringify({ request, response: response(request), publicKeyPin: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url'), nowMs: 1800000001000, testSecret, phases }, null, 2) + '\n');
writeFileSync(root + 'capabilities.json', JSON.stringify({ contract: EXTENSION_AUTHORITY_CONTRACT, contractPin,
  qualifiedExtensionContract: extension.contract, qualifiedExtensionPin: extension.contractPin,
  transport: 'existing-authenticated-private-unix-only', path: EXTENSION_AUTHORITY_PATH,
  phases: ['request', 'dispatch', 'status', 'completion'], downstreamReady: false, publicReady: false,
  consumerGates: { fleet: 'independent-pin-and-reciprocal-qualification-required', routing: 'independent-pin-and-reciprocal-qualification-required', connect: 'independent-account-subscription-installation-passkey-evidence-required' },
  keyProvisioning: 'operator-native-channel-only', keyAlgorithm: 'Ed25519', publicPinEncoding: 'base64url-SPKI',
  readiness: 'local-contract-only-no-hosted-enablement' }, null, 2) + '\n');
const source = ['packages/shared/src/extensionAuthorityProof.ts', 'packages/core/src/fleet/extensionAuthorityProof.ts',
  'packages/core/src/db/migrations/20261015070000_extension_authority_epoch.js', 'packages/core/src/fleet/files.ts',
  'packages/core/src/fleet/dataPlane.ts', 'packages/core/src/fleet/resetFence.ts', 'packages/shared/src/instanceAuthorization.ts', 'packages/core/src/storage/service.ts', 'packages/core/src/storage/proofIdentity.ts', 'packages/core/src/storage/services.ts', 'packages/api/fleetDataListener.ts',
  'packages/core/src/fleet/extensions.ts', 'packages/shared/src/fleetExtensions.ts', 'scripts/generate-extension-authority-fixtures.mjs'];
writeFileSync(root + 'source-pins.json', JSON.stringify(Object.fromEntries(source.map(file => [file, hash(readFileSync(file))])), null, 2) + '\n');
const names = ['schema.json', 'fixtures.json', 'capabilities.json', 'source-pins.json', 'verifier.mjs', 'README.md'];
writeFileSync(root + 'SHA256SUMS', names.map(name => `${hash(readFileSync(root + name))}  ${name}\n`).join(''));
