/** Fleet-only wire contract. This is deliberately not part of the customer API. */
export const FLEET_DATA_CONTRACT = 'propr.fleet-data.v1';
export const FLEET_DATA_ACTOR_CONTRACT = 'propr.fleet-data.v2';
export const FLEET_DATA_SCOPE = 'hosted_customer_data';
export const FLEET_DATA_ACTIONS = ['database.export', 'repositories.list', 'repositories.cleanup.preview', 'repositories.cleanup.execute', 'operation.status', 'operation.cancel', 'artifact.stream'];
/** Sorted ASCII keys, UTF-8, no whitespace; all numeric wire fields are integers. */
export function canonicalFleetJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonicalFleetJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalFleetJson(value[key])).join(',') + '}';
}
/** Pinned schema description; changing this requires a new contract version. */
export const FLEET_DATA_SCHEMA = canonicalFleetJson({
    version: FLEET_DATA_CONTRACT, scope: FLEET_DATA_SCOPE, actions: FLEET_DATA_ACTIONS,
    assertion: ['action', 'contract', 'contractPin', 'expiresAt', 'hostedInstanceId', 'issuedAt', 'nonce', 'operationId', 'placementGeneration', 'requestDigest', 'runtimeGeneration', 'scope', 'storageInstanceId'],
    requests: { empty: FLEET_DATA_ACTIONS.slice(0, 3), execute: ['action', 'confirmation', 'previewOperationId'], target: ['action', 'targetOperationId'] },
    algorithm: 'HMAC-SHA256', canonical: 'sorted-keys-utf8-json', maxAssertionSeconds: 60, clockSkewSeconds: 5,
    operationSeconds: 300, maxRequestBytes: 8192, maxArtifactBytes: 536870912,
    result: ['contract', 'operationId', 'actor=fleet', 'state', 'expiresAt=epoch-milliseconds', 'result?'],
    states: ['accepted', 'dispatched', 'running', 'completed', 'failed', 'fenced', 'cancelled', 'streaming', 'consumed'],
    error: 'fleet_data_unavailable', maxJsonResponseBytes: 32768,
});
/** Additive actor-bound revision. The v1 schema above remains byte-for-byte pinned. */
export const FLEET_DATA_ACTOR_SCHEMA = canonicalFleetJson({
    ...JSON.parse(FLEET_DATA_SCHEMA),
    version: FLEET_DATA_ACTOR_CONTRACT,
    assertion: [...JSON.parse(FLEET_DATA_SCHEMA).assertion, 'githubActorId', 'storageGeneration'].sort(),
    githubActorId: 'positive-safe-integer-exact-durable-instance-admin',
    storageGeneration: 'native-cleanup-generation-lowercase-uuid',
    authorization: 'current-durable-admin-and-instance.manage_settings-at-every-boundary',
    operationActor: 'original-githubActorId-private-only',
    nativeAuditActor: 'decimal-githubActorId',
});
