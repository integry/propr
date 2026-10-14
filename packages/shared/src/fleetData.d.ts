import type { DatabaseExportStatus, RepositoryStorageInventory, StorageCleanupPreview, StorageCleanupResult } from './instanceStorage.js';
/** Fleet-only wire contract. This is deliberately not part of the customer API. */
export declare const FLEET_DATA_CONTRACT: "propr.fleet-data.v1";
export declare const FLEET_DATA_ACTOR_CONTRACT: "propr.fleet-data.v2";
export declare const FLEET_DATA_SCOPE: "hosted_customer_data";
export declare const FLEET_DATA_ACTIONS: readonly ["database.export", "repositories.list", "repositories.cleanup.preview", "repositories.cleanup.execute", "operation.status", "operation.cancel", "artifact.stream"];
export type FleetDataAction = typeof FLEET_DATA_ACTIONS[number];
export interface FleetDataBinding {
    hostedInstanceId: string;
    storageInstanceId: string;
    runtimeGeneration: string;
    placementGeneration: string;
    scope: typeof FLEET_DATA_SCOPE;
}
export interface FleetDataAssertion extends FleetDataBinding {
    contract: typeof FLEET_DATA_CONTRACT;
    contractPin: string;
    action: FleetDataAction;
    requestDigest: string;
    operationId: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
}
export type FleetDataRequest = {
    action: 'database.export' | 'repositories.list' | 'repositories.cleanup.preview';
} | {
    action: 'repositories.cleanup.execute';
    previewOperationId: string;
    confirmation: string;
} | {
    action: 'operation.status' | 'operation.cancel' | 'artifact.stream';
    targetOperationId: string;
};
export interface FleetDataEnvelope {
    assertion: FleetDataAssertion;
    request: FleetDataRequest;
    mac: string;
}
export type FleetDataState = 'accepted' | 'dispatched' | 'running' | 'completed' | 'failed' | 'fenced' | 'cancelled' | 'streaming' | 'consumed';
export interface FleetDataResult {
    contract: typeof FLEET_DATA_CONTRACT;
    operationId: string;
    actor: 'fleet';
    state: FleetDataState;
    expiresAt: number;
    result?: DatabaseExportStatus | RepositoryStorageInventory | StorageCleanupPreview | StorageCleanupResult | FleetDataResult | {
        cancelled: true;
    } | {
        delivered: true;
    };
}
/** V2 types are additive; historical v1 types and schema remain unchanged. */
export interface FleetActorDataBinding extends FleetDataBinding {
    storageGeneration: string;
}
export interface FleetActorDataAssertion extends Omit<FleetDataAssertion, 'contract'>, FleetActorDataBinding {
    contract: typeof FLEET_DATA_ACTOR_CONTRACT;
    githubActorId: number;
}
export interface FleetActorDataEnvelope {
    assertion: FleetActorDataAssertion;
    request: FleetDataRequest;
    mac: string;
}
export interface FleetActorDataResult extends Omit<FleetDataResult, 'contract' | 'result'> {
    contract: typeof FLEET_DATA_ACTOR_CONTRACT;
    result?: Exclude<FleetDataResult['result'], FleetDataResult> | FleetActorDataResult;
}
/** Sorted ASCII keys, UTF-8, no whitespace; all numeric wire fields are integers. */
export declare function canonicalFleetJson(value: unknown): string;
/** Pinned schema description; changing this requires a new contract version. */
export declare const FLEET_DATA_SCHEMA: string;
/** Additive actor-bound revision. The v1 schema above remains byte-for-byte pinned. */
export declare const FLEET_DATA_ACTOR_SCHEMA: string;
