import type {
    GoalModelChangeAcknowledgement, GoalModelChangeHistoryPort,
    GoalModelChangeHistoryRecord, GoalSessionIdentity,
} from './contract.js';

type SequencedRecord = GoalModelChangeHistoryRecord & { sequence: number };

export class InMemoryModelChangeHistory implements GoalModelChangeHistoryPort {
    private readonly records = new Map<string, SequencedRecord[]>();

    async claim(identity: GoalSessionIdentity, operationId: string, model: string): Promise<GoalModelChangeHistoryRecord> {
        const key = scope(identity);
        const records = this.records.get(key) ?? [];
        const existing = records.find(record => record.operationId === operationId);
        if (existing) return structuredClone(existing);
        const created = { operationId, model, status: 'pending' as const, sequence: (records.at(-1)?.sequence ?? 0) + 1 };
        records.push(created);
        this.records.set(key, records);
        return structuredClone(created);
    }

    async settle(
        identity: GoalSessionIdentity,
        operationId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void> {
        const records = this.records.get(scope(identity)) ?? [];
        const record = records.find(value => value.operationId === operationId);
        if (!record) return;
        record.status = 'settled';
        record.acknowledgement = structuredClone(acknowledgement);
        const settled = records.filter(value => value.status === 'settled');
        for (const retired of settled.slice(0, Math.max(0, settled.length - 64))) retired.status = 'retired';
    }
}

function scope(identity: GoalSessionIdentity): string {
    return `${identity.goalId}\0${identity.sessionId}`;
}
