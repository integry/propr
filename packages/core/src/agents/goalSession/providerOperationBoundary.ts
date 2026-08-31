import type {
    GoalModelChangeAcknowledgement,
    GoalSessionIdentity,
} from './contract.js';

export interface GoalProviderOperationGuard {
    readonly generation: number;
    readonly leaseExpiresAt?: string;
    assertCurrent(): Promise<void>;
}

export interface GoalModelChangeHistoryRecord {
    operationId: string;
    model: string;
    status: 'pending' | 'settled' | 'retired';
    acknowledgement?: GoalModelChangeAcknowledgement;
}

/** Exact durable addressability ledger, stored separately from bounded session state. */
export interface GoalModelChangeHistoryPort {
    claim(identity: GoalSessionIdentity, operationId: string, model: string): Promise<GoalModelChangeHistoryRecord>;
    settle(
        identity: GoalSessionIdentity,
        operationId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void>;
}
