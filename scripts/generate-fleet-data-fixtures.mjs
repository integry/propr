// Run from repository root after building @propr/shared. Contains public test data only.
import { createHash, createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonicalFleetJson, FLEET_DATA_SCHEMA, FLEET_DATA_CONTRACT, FLEET_DATA_ACTOR_SCHEMA, FLEET_DATA_ACTOR_CONTRACT, FLEET_DATA_SCOPE } from '../packages/shared/dist/fleetData.js';
const sha256 = value => createHash('sha256').update(value).digest('hex');
for (const version of [1, 2]) {
  const schema = version === 1 ? FLEET_DATA_SCHEMA : FLEET_DATA_ACTOR_SCHEMA;
  const contract = version === 1 ? FLEET_DATA_CONTRACT : FLEET_DATA_ACTOR_CONTRACT;
  const contractPin = sha256(schema);
  const testSecret = 'PUBLIC-FIXTURE-KEY-NOT-A-PRODUCTION-SECRET';
  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const requests = [
    { action: 'database.export' }, { action: 'repositories.list' }, { action: 'repositories.cleanup.preview' },
    { action: 'repositories.cleanup.execute', previewOperationId: id(3), confirmation: id(20) },
    { action: 'operation.status', targetOperationId: id(1) }, { action: 'operation.cancel', targetOperationId: id(1) },
    { action: 'artifact.stream', targetOperationId: id(1) },
  ].map((request, index) => {
    const assertion = { contract, ...(version === 2 ? { githubActorId: 100, storageGeneration: id(102) } : {}), contractPin, hostedInstanceId: 'fixture-hosted-a', storageInstanceId: id(100), runtimeGeneration: id(101), placementGeneration: 'placement-42', scope: FLEET_DATA_SCOPE,
      action: request.action, operationId: id(index + 1), nonce: String(index + 1).padStart(64, '0'), issuedAt: 1791892800, expiresAt: 1791892860, requestDigest: sha256(canonicalFleetJson(request)) };
    const mac = createHmac('sha256', testSecret).update(canonicalFleetJson(assertion)).digest('hex');
    const canonical = canonicalFleetJson({ assertion, request, mac });
    return { action: request.action, canonical, sha256: sha256(canonical) };
  });
  const fixtures = JSON.stringify({ contractPin, testSecret, requests }, null, 2) + '\n';
  await writeFile(new URL(`../docs/contracts/fleet-data-v${version}/schema.json`, import.meta.url), schema);
  await writeFile(new URL(`../docs/contracts/fleet-data-v${version}/fixtures.json`, import.meta.url), fixtures);
  await writeFile(new URL(`../docs/contracts/fleet-data-v${version}/SHA256SUMS`, import.meta.url), `${contractPin}  schema.json\n${sha256(fixtures)}  fixtures.json\n`);

}
