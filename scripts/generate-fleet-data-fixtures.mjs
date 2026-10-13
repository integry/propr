// Run from repository root after building @propr/shared. Contains public test data only.
import { createHash, createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonicalFleetJson, FLEET_DATA_SCHEMA, FLEET_DATA_CONTRACT, FLEET_DATA_SCOPE } from '../packages/shared/dist/fleetData.js';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const contractPin = sha256(FLEET_DATA_SCHEMA);
const testSecret = 'PUBLIC-FIXTURE-KEY-NOT-A-PRODUCTION-SECRET';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const requests = [
  { action: 'database.export' }, { action: 'repositories.list' }, { action: 'repositories.cleanup.preview' },
  { action: 'repositories.cleanup.execute', previewOperationId: id(3), confirmation: id(20) },
  { action: 'operation.status', targetOperationId: id(1) }, { action: 'operation.cancel', targetOperationId: id(1) },
  { action: 'artifact.stream', targetOperationId: id(1) },
].map((request, index) => {
  const assertion = { contract: FLEET_DATA_CONTRACT, contractPin, hostedInstanceId: 'fixture-hosted-a', storageInstanceId: id(100), runtimeGeneration: id(101), placementGeneration: 'placement-42', scope: FLEET_DATA_SCOPE,
    action: request.action, operationId: id(index + 1), nonce: String(index + 1).padStart(64, '0'), issuedAt: 1791892800, expiresAt: 1791892860, requestDigest: sha256(canonicalFleetJson(request)) };
  const mac = createHmac('sha256', testSecret).update(canonicalFleetJson(assertion)).digest('hex');
  const canonical = canonicalFleetJson({ assertion, request, mac });
  return { action: request.action, canonical, sha256: sha256(canonical) };
});
const fixtures = JSON.stringify({ contractPin, testSecret, requests }, null, 2) + '\n';
await writeFile(new URL('../docs/contracts/fleet-data-v1/schema.json', import.meta.url), FLEET_DATA_SCHEMA);
await writeFile(new URL('../docs/contracts/fleet-data-v1/fixtures.json', import.meta.url), fixtures);
await writeFile(new URL('../docs/contracts/fleet-data-v1/SHA256SUMS', import.meta.url), `${contractPin}  schema.json\n${sha256(fixtures)}  fixtures.json\n`);
